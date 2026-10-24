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

/* ---------- the withdrawal mark (N09): per instance AND account, survives reloads ---------- */

// The instance is where the app is served from / paired to — a copied or migrated instance can
// legitimately hold the same uids, so the origin (or the phone's paired base) belongs in the key.
const instanceOf = () => {
  try { return typeof location !== 'undefined' && location.origin ? location.origin : 'local' }
  catch { return 'local' }
}
const withdrawKey = (uid, instance) => `lb-withdraw:${instance || instanceOf()}:${uid}`
const withdrawPendingFor = uid => {
  try { return !!uid && !!localStorage.getItem(withdrawKey(uid)) } catch { return false }
}
const markWithdraw = (uid, instance) => { try { localStorage.setItem(withdrawKey(uid, instance), '1') } catch { /* private mode */ } }
const clearWithdraw = (uid, instance) => { try { localStorage.removeItem(withdrawKey(uid, instance)) } catch { /* private mode */ } }

/** Withdraw with the offline guarantee: the intent is persisted first (for THIS account and
 *  instance) and blocks publishing immediately; the coordinator retries the server call until
 *  it confirms. A late answer clears only the mark this call wrote (N09). */
export async function requestLeave(me) {
  const uid = useStore.getState().user?.id
  const instance = instanceOf()
  if (!uid) return { ok: false, error: new Error('not signed in') }
  markWithdraw(uid, instance)
  status.withdrawPending = true
  emit()
  try {
    await leaveLeaderboard(me)
    // The captured account's mark goes, whoever is signed in NOW: the leave succeeded for
    // that account on that instance, and the mark belongs to it, not to the session (N09).
    clearWithdraw(uid, instance)
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

async function runPublish() {
  if (publishing) { rerun = true; return }   // N08: what changed mid-flight runs next
  publishing = true
  rerun = false
  try {
    const start = useStore.getState()
    const uid = start.user?.id
    if (!uid || !start.config?.leaderboard) return
    const instance = instanceOf()
    // N04: everything below belongs to this account on this instance; any await may come back
    // after a sign-out/sign-in, so the binding is re-checked before acting on an answer.
    const stillUs = () => useStore.getState().user?.id === uid

    // A withdrawal waiting on the network goes first, and blocks publishing meanwhile.
    if (withdrawPendingFor(uid)) {
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

    // N03: publish only from a healthy personal sync. 'offline'/'error' publish nothing; the
    // 'held' state (this copy still waiting to be adopted into an account) publishes nothing —
    // facts of no certain ownership never leave the device. All of it stays pending.
    const sync = useStore.getState().sync
    if (!sync || sync.status !== 'ok') return

    if (typeof navigator !== 'undefined' && navigator.onLine === false) return // stays pending; 'online' retries
    const m = await me()
    if (!stillUs()) return
    if (!m?.enabled || m.suspended) return
    if (m.disclosureVersion !== m.currentDisclosureVersion) return // needs re-confirmation first (R12)
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
        return st.user?.id === uid && st.sync?.status === 'ok'
      },
      // N04: the retry's facts come from the store only if it is still the same account.
      stateOf: () => {
        const st = useStore.getState()
        return st.user?.id === uid ? st.S : null
      }
    })
    if (!stillUs()) return // the answer belongs to a previous session: nothing is recorded
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
  useStore.subscribe(() => {
    const { user, S } = useStore.getState()
    if (!user || !S) return
    const sync = useStore.getState().sync
    if (sync?.status && sync.status !== 'ok') return // nothing to publish while unhealthy (N03)
    if (fingerprintOf(S) === lastPublished && !withdrawPendingFor(user.id)) return
    schedule()
  })
  window.addEventListener('online', () => { if (status.pending) runPublish() })
  // A sign-in/instance switch must not carry another account's published fingerprint or marks.
  let seenKey = null
  useStore.subscribe(() => {
    const st = useStore.getState()
    const key = (st.user?.id || '') + '@' + instanceOf()
    if (key !== seenKey) {
      seenKey = key
      lastPublished = ''
      meCache = null
      status.withdrawPending = withdrawPendingFor(st.user?.id)
      setPending(false)
    }
  })
  runPublish()
}

export function retryNow() { runPublish() }
export function publishStatus() { return status }
export function onPublishStatus(l) { listeners.add(l); return () => listeners.delete(l) }
