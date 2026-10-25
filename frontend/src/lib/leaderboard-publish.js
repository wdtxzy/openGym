// The leaderboard's global publisher — the fix for "it only published when the page was open".
//
// One coordinator, started once from App on boot, subscribes to the store: whenever the
// personal facts move — a finished workout, an edit to an OLD session, a sync that adopted
// another device's copy, an activity changing state — the aggregate fingerprint changes and a
// debounced publish runs with no page involved (R05). The fingerprint covers the actual
// aggregate inputs, not counts.
//
// Round-2 hardening, each with its number:
//   N03 — a publish requires personal sync to be HEALTHY (status 'ok'). An offline, erroring,
//         or held-for-adoption store never publishes, and the 409 recovery only retries after
//         the pull wrapper reports a real, healthy merge — pullState swallows its own errors,
//         so "it was called" proves nothing; the wrapper answers true/false.
//   N04 — every publish is bound to the account and instance it started with, re-checked after
//         every await: a sign-out/sign-in mid-flight aborts instead of handing one account's
//         facts to the next account's session.
//   N08 — a slow publish does not swallow what changed while it was in flight (a rerun is
//         scheduled), and `pending` is always recomputed from the live fingerprint, never
//         blanket-cleared by a finishing request.
//   N09 — the withdrawal mark is keyed by instance AND account, and a leave request clears
//         only the mark it wrote: a late success for account A cannot delete account B's
//         pending withdrawal.
import { useStore } from '../store/useStore.js'
import { fetchMe, leaveLeaderboard, publishReport } from './leaderboard-client.js'

const DEBOUNCE_MS = 2500
const ME_TTL_MS = 30000

let started = false
let timer = null
let meCache = null               // { at, me }
let lastPublished = ''           // the fingerprint the server last accepted
let publishing = false
let rerun = false                // something changed while a publish was in flight (N08)
const listeners = new Set()

// The coordinator's visible state — the page renders this, nothing else.
const status = { pending: false, lastOkAt: null, lastError: null, withdrawPending: false }

const emit = () => { for (const l of listeners) l(status) }
const setPending = v => { if (status.pending !== v) { status.pending = v; emit() } }
const fail = e => { status.lastError = e?.message || String(e); setPending(true); emit() }
// N08: acceptance clears the error and re-derives `pending` from the CURRENT facts — a change
// that landed during the request keeps the coordinator honestly pending.
const ok = () => {
  status.lastError = null
  status.lastOkAt = Date.now()
  status.pending = fingerprintOf(useStore.getState().S) !== lastPublished
  emit()
}

/** The actual aggregate inputs, hashed cheaply: any edit that changes what a report would
 *  contain — including an older workout's times, or a same-count activity swap — moves it. */
export function fingerprintOf(S) {
  const w = (S?.workouts || []).map(x => [x.id, x.d, x.start ?? 0, x.end ?? 0])
  const a = (S?.activities || []).map(x => [x.id, x.startMs ?? 0, x.endMs ?? 0, !!x.userExcluded, !!x.sourceDeleted, x.linkedWorkoutId ?? null])
  return JSON.stringify([w, a])
}

/* ---------- the withdrawal mark: per real server base AND account, survives reloads ---------- */

// The instance is where requests actually go: the phone's paired base, or the page's own
// origin — same WebView origin hosts every pairing, and an origin alone cannot tell two
// paired servers apart (T05). The store keeps the live answer in sync.server.
const instanceOf = st => (st?.sync?.server) || (typeof location !== 'undefined' && location.origin) || 'local';
const withdrawKey = (uid, instance) => `lb-withdraw:${instance}:${uid}`;
// The previous release kept `lb-withdraw:<uid>` with no instance. An old mark is neither
// dropped nor blindly replayed against a different server (T06): it blocks publishing and is
// resolved the moment a leave lands or clearly has nothing to leave here.
const legacyWithdrawKey = uid => `lb-withdraw:${uid}`;
const withdrawPendingFor = (uid, instance) => {
  try {
    if (!uid) return false;
    if (localStorage.getItem(withdrawKey(uid, instance))) return true;
    return localStorage.getItem(legacyWithdrawKey(uid)) !== null;
  } catch { return false }
};
const markWithdraw = (uid, instance) => { try { localStorage.setItem(withdrawKey(uid, instance), '1') } catch { /* private mode */ } };
const clearWithdraw = (uid, instance) => {
  try {
    localStorage.removeItem(withdrawKey(uid, instance));
    localStorage.removeItem(legacyWithdrawKey(uid)); // resolved once, in whichever format
  } catch { /* private mode */ }
};

/** Withdraw with the offline guarantee: the intent is persisted first (for THIS account on
 *  THIS server) and blocks publishing immediately; the coordinator retries the server call until
 *  it confirms. A late answer clears only the mark this call wrote (N09). */
export async function requestLeave(me) {
  const st = useStore.getState();
  const uid = st.user?.id;
  const instance = instanceOf(st);
  if (!uid) return { ok: false, error: new Error('not signed in') };
  markWithdraw(uid, instance);
  status.withdrawPending = true;
  emit();
  try {
    await leaveLeaderboard(me)
    // The captured account's mark goes, whoever is signed in NOW: the leave succeeded for
    // that account on that instance, and the mark belongs to it, not to the session (N09).
    clearWithdraw(uid, instance);
    if (useStore.getState().user?.id !== uid) return { ok: true, note: 'account switched' }
    status.withdrawPending = false
    meCache = null
    ok()
    return { ok: true }
  } catch (e) {
    fail(e)
    return { ok: false, error: e }
  }
}

async function me(force = false) {
  const now = Date.now()
  if (!force && meCache && now - meCache.at < ME_TTL_MS) return meCache.me
  const m = await fetchMe()
  meCache = { at: now, me: m }
  return m
}

/** Forget the cached member state (after a join, a re-confirm, an admin action). */
export function invalidateMe() { meCache = null }

/* ---------- session identity (T02): uid + REAL server base, and a generation that only
 * ---------- ever moves forward. A task captures both; any switch — sign-out, A→B, B→A, the
 * ---------- same uid onto another paired server — bumps the generation and orphans it. */

let sessionGen = 0;
let seenSessionKey = null;
const sessionKeyOf = st => `${st.user?.id || ''}|${instanceOf(st)}`;

/* ---------- the this-session merge credential (T01): a healthy sync.status can be a value
 * ---------- restored from storage at boot, before this session's /api/data has answered.
 * lastSynced only moves when a real exchange CONFIRMED in this page's lifetime, so publishing
 * waits until the coordinator has SEEN it move (from the baseline captured at start). */

let baselineSyncedAt = 0;
let sessionSyncedAt = 0;

async function runPublish() {
  if (publishing) { rerun = true; return }   // N08: what changed mid-flight runs next
  publishing = true
  rerun = false
  try {
    const start = useStore.getState()
    const uid = start.user?.id
    if (!uid || !start.config?.leaderboard) return
    const instance = instanceOf(start)
    const sessionKey = sessionKeyOf(start)
    const gen = sessionGen
    // T04/T02: everything below belongs to this account, on this server, in this session
    // stretch; any await may come back after a switch, so the binding is re-checked before
    // anything is acted on.
    const stillUs = () => {
      const st = useStore.getState()
      return sessionKeyOf(st) === sessionKey && sessionGen === gen
    }
    const healthy = () => {
      const st = useStore.getState()
      return st.sync?.status === 'ok'
    }

    // A withdrawal waiting on the network goes first, and blocks publishing meanwhile.
    if (withdrawPendingFor(uid, instance)) {
      const m = await me(true)
      if (!stillUs()) return
      if (!m?.enabled) { clearWithdraw(uid, instance); status.withdrawPending = false; emit(); return }
      try {
        await leaveLeaderboard(m)
        if (!stillUs()) return
        clearWithdraw(uid, instance)
        status.withdrawPending = false
        meCache = null
        ok()
      } catch (e) { fail(e) }
      return
    }

    // T01: no publish until THIS session has completed a personal merge — the baseline was
    // captured at start, and only a real confirmed exchange since then moves lastSynced.
    if (!sessionSyncedAt) return
    // N03: publish only from a healthy personal sync — and healthy NOW, not just at capture.
    if (!healthy()) return

    if (typeof navigator !== 'undefined' && navigator.onLine === false) return // stays pending; 'online' retries
    const m = await me()
    if (!stillUs() || !healthy()) return
    // Terminal gates below are owed NOTHING: a member who is out, suspended, or unconfirmed
    // is blocked on a person's decision, not on a retry — pending comes back off.
    if (!m?.enabled || m.suspended) { setPending(false); return }
    if (m.disclosureVersion !== m.currentDisclosureVersion) { setPending(false); return } // R12
    // A fresh join, or a rejoin after a withdrawal: the server holds nothing (reportRev 0),
    // so whatever fingerprint this device remembers is meaningless — publish everything.
    if (!m.reportRev) lastPublished = ''
    const fingerprint = fingerprintOf(start.S)
    if (fingerprint === lastPublished) { setPending(false); return }

    const r = await publishReport(start.S, m, {
      // N03: the pull wrapper answers whether the merge actually landed healthy — pullState
      // swallows its own failures, so the client treats false as "do not retry".
      pull: async () => {
        try { await useStore.getState().pullState() } catch { return false }
        const st = useStore.getState()
        return sessionKeyOf(st) === sessionKey && sessionGen === gen && st.sync?.status === 'ok'
      },
      // N04: the retry's facts come from the store only if it is still the same session.
      stateOf: () => {
        const st = useStore.getState()
        return sessionKeyOf(st) === sessionKey && sessionGen === gen ? st.S : null
      }
    })
    if (!stillUs() || !healthy()) return // the answer belongs to a previous session: nothing is recorded
    if (r.ok) {
      lastPublished = fingerprint
      ok() // re-derives pending from the live facts (N08)
    } else if (r.reason === 'disabled') {
      meCache = null // joined-out or suspended elsewhere: re-read next round, nothing to publish
      setPending(false)
    } else {
      fail(r.error || new Error('publication failed'))
    }
  } catch (e) {
    fail(e)
  } finally {
    publishing = false
    if (rerun) { rerun = false; schedule() }   // N08: facts changed during the flight
  }
}

const schedule = () => {
  setPending(true)
  clearTimeout(timer)
  timer = setTimeout(runPublish, DEBOUNCE_MS)
}

/** Start the global coordinator. Idempotent; called once from App. */
export function startPublishing() {
  if (started || typeof window === 'undefined') return
  started = true
  // The merge baseline is whatever storage restored — a value from BEFORE this page loaded
  // proves nothing about this session's sync (T01).
  baselineSyncedAt = useStore.getState().sync?.lastSynced ?? 0
  // Prime the session registry with the CURRENT session before the first pass, so the boot
  // pass and the subscribers agree on the generation instead of the first fire invalidating it.
  seenSessionKey = sessionKeyOf(useStore.getState())
  useStore.subscribe(() => {
    const st = useStore.getState()
    // A real confirmed exchange this session: lastSynced moved off the boot baseline.
    const synced = st.sync?.lastSynced
    if (typeof synced === 'number' && synced !== baselineSyncedAt && synced !== sessionSyncedAt) {
      sessionSyncedAt = synced
    }
  })
  useStore.subscribe(() => {
    const st = useStore.getState()
    // Any session change — user, server, sign-out and back — bumps the generation: the old
    // one's in-flight tasks die on their next stillUs() (T02), and nothing of the previous
    // session's memory (member cache, published fingerprint) carries over.
    const key = sessionKeyOf(st)
    if (key !== seenSessionKey) {
      const first = seenSessionKey === null
      seenSessionKey = key
      sessionGen++
      lastPublished = ''
      meCache = null
      status.withdrawPending = withdrawPendingFor(st.user?.id, instanceOf(st))
      setPending(false)
      if (!first) schedule() // the new session deserves a fresh pass once it syncs
    }
  })
  useStore.subscribe(() => {
    const { user, S } = useStore.getState()
    if (!user || !S) return
    const st = useStore.getState()
    if (st.sync?.status && st.sync.status !== 'ok') return // nothing to publish while unhealthy (N03)
    if (!sessionSyncedAt) return                            // nor before this session's merge (T01)
    if (fingerprintOf(S) === lastPublished && !withdrawPendingFor(user.id, instanceOf(st))) return
    schedule()
  })
  window.addEventListener('online', () => { if (status.pending) runPublish() })
  runPublish()
}

export function retryNow() { runPublish() }
export function publishStatus() { return status }
export function onPublishStatus(l) { listeners.add(l); return () => listeners.delete(l) }
