// The leaderboard's global publisher — the fix for "it only published when the page was open".
//
// One coordinator, started once from App on boot, subscribes to the store: whenever the
// personal facts move — a finished workout, an edit to an OLD session, a sync that adopted
// another device's copy, an activity changing state — the aggregate fingerprint changes and a
// debounced publish runs with no page involved (R05). The fingerprint covers the actual
// aggregate inputs (id/date/start/end of every workout, the counting fields of every
// activity), not counts: editing an earlier session's duration or swapping an activity for
// another with the same total moves it.
//
// Failure is a state, not a log line (R10): the fingerprint is recorded only after the server
// accepted, a failure keeps the fact pending with the error surfaced for the page to show and
// a retry entry, and the next change or regained connectivity tries again.
//
// A withdrawal is honoured even offline (R11): the intent is persisted per account before the
// request, blocks every publish immediately, survives a reload, and is sent first once the
// network allows. The server confirming it is what clears the mark.
//
// The PRD's conflict rule (§05, R03) lives in leaderboard-client.publishReport: on a stale
// base this module hands it the store's own pull (merge personal state first), and the
// recovery rebuilds from whatever the state is AFTER that merge — never from the closure's
// stale copy.
import { useStore } from '../store/useStore.js'
import { fetchMe, leaveLeaderboard, publishReport } from './leaderboard-client.js'

const DEBOUNCE_MS = 2500
const ME_TTL_MS = 30000

let started = false
let timer = null
let meCache = null               // { at, me }
let lastPublished = ''           // the fingerprint the server last accepted
let publishing = false
const listeners = new Set()

// The coordinator's visible state — the page renders this, nothing else.
const status = { pending: false, lastOkAt: null, lastError: null, withdrawPending: false }

const emit = () => { for (const l of listeners) l(status) }
const setPending = v => { if (status.pending !== v) { status.pending = v; emit() } }
const fail = e => { status.lastError = e?.message || String(e); setPending(true); emit() }
const ok = () => { status.lastError = null; status.lastOkAt = Date.now(); setPending(false); emit() }

/** The actual aggregate inputs, hashed cheaply: any edit that changes what a report would
 *  contain — including an older workout's times, or a same-count activity swap — moves it. */
export function fingerprintOf(S) {
  const w = (S?.workouts || []).map(x => [x.id, x.d, x.start ?? 0, x.end ?? 0])
  const a = (S?.activities || []).map(x => [x.id, x.startMs ?? 0, x.endMs ?? 0, !!x.userExcluded, !!x.sourceDeleted, x.linkedWorkoutId ?? null])
  return JSON.stringify([w, a])
}

/* ---------- the withdrawal mark (R11): per account+instance, survives reloads ---------- */

const withdrawKey = () => {
  const uid = useStore.getState().user?.id
  return uid ? 'lb-withdraw:' + uid : null
}
const withdrawPending = () => {
  const k = withdrawKey()
  try { return !!k && !!localStorage.getItem(k) } catch { return false }
}
const markWithdraw = () => { try { const k = withdrawKey(); if (k) localStorage.setItem(k, '1') } catch { /* private mode */ } }
const clearWithdraw = () => { try { const k = withdrawKey(); if (k) localStorage.removeItem(k) } catch { /* private mode */ } }

/** Withdraw with the offline guarantee: the intent is persisted first and blocks publishing
 *  immediately; the coordinator retries the server call until it confirms. */
export async function requestLeave(me) {
  markWithdraw()
  status.withdrawPending = true
  emit()
  try {
    await leaveLeaderboard(me)
    clearWithdraw()
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
  if (publishing) return
  publishing = true
  try {
    const { user, S, config } = useStore.getState()
    if (!user || !config?.leaderboard) return
    // A withdrawal waiting on the network goes first, and blocks publishing meanwhile.
    if (withdrawPending()) {
      const m = await me(true)
      if (!m?.enabled) { clearWithdraw(); status.withdrawPending = false; emit(); return }
      try { await leaveLeaderboard(m); clearWithdraw(); status.withdrawPending = false; meCache = null; ok() }
      catch (e) { fail(e) }
      return
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return // stays pending; 'online' retries
    const m = await me()
    if (!m?.enabled || m.suspended) return
    if (m.disclosureVersion !== m.currentDisclosureVersion) return // needs re-confirmation first (R12)
    // A fresh join, or a rejoin after a withdrawal: the server holds nothing (reportRev 0),
    // so whatever fingerprint this device remembers is meaningless — publish everything.
    if (!m.reportRev) lastPublished = ''
    const fingerprint = fingerprintOf(S)
    if (fingerprint === lastPublished) { setPending(false); return }
    const r = await publishReport(S, m, {
      // R03: on a stale base, merge personal state FIRST, then rebuild from the merged state —
      // the same closure S would re-serialize exactly the outdated facts that caused the 409.
      pull: () => useStore.getState().pullState(),
      stateOf: () => useStore.getState().S
    })
    if (r.ok) {
      lastPublished = fingerprint
      // The merge may have changed the facts under us: keep whatever is current pending.
      setPending(fingerprintOf(useStore.getState().S) !== fingerprint)
      ok()
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
    if (fingerprintOf(S) === lastPublished && !withdrawPending()) return
    schedule()
  })
  window.addEventListener('online', () => { if (status.pending) runPublish() })
  // A sign-in/instance switch must not carry another account's published fingerprint.
  let seenUser = null
  useStore.subscribe(() => {
    const uid = useStore.getState().user?.id
    if (uid !== seenUser) { seenUser = uid; lastPublished = ''; meCache = null; setPending(false); }
  })
  runPublish()
}

export function retryNow() { runPublish() }
export function publishStatus() { return status }
export function onPublishStatus(l) { listeners.add(l); return () => listeners.delete(l) }
