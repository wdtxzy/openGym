// The leaderboard's global publisher — a session machine, not a pile of module globals.
//
// One publisher instance (created once from App), one store subscription, and ONE session
// object at a time: { key, generation, baselineSyncedAt, sessionSyncedAt, me, meAt,
// lastAcceptedReportRev, lastPublished, withdrawal }. Every switch — sign-out, A→B, B→A, the
// same uid onto another paired server — swaps the whole object (F04: a merge credential from
// one session can never authorize the next), and every async step re-validates the captured
// object before touching cache, marks or status (F07: an old me response cannot seed the new
// session's cache; an old leave cannot clear the new session's mark).
//
// A publish requires (T01/F03): the CURRENT session has completed its own confirmed exchange
// (lastSynced moved off this session's baseline — a value restored from storage proves
// nothing), AND the report's facts correspond to the server's current baseline. When the
// server's reportRev is ahead of what this session produced — another device published —
// sending is only allowed AFTER a fresh personal merge lands and the report is rebuilt from
// the merged state; the merge must itself move lastSynced (pullState swallows its own
// failures, so "it was called" proves nothing).
//
// Withdrawal marks (F05/F06) know every format this app ever wrote, and an old mark whose
// instance cannot be proven blocks publishing and waits for the person to resolve it — it is
// never silently dropped, never replayed against a server it cannot be proven to belong to.
import { useStore } from '../store/useStore.js'
import { fetchMe, leaveLeaderboard, publishReport } from './leaderboard-client.js'

const DEBOUNCE_MS = 2500
const ME_TTL_MS = 30000

/** The instance a request goes to: the phone's paired base, or the page's own origin. */
const instanceOf = st => (st?.sync?.server) || (typeof location !== 'undefined' && location.origin) || 'local'
const sessionKeyOf = st => `${st.user?.id || ''}|${instanceOf(st)}`

/* ---------- withdrawal marks: every format ever shipped (F05/F06) ---------- */
// v3 (current): lb-withdraw:<server-base>:<uid>   — provably this instance.
// v2:           lb-withdraw:<origin>:<uid>        — provable only while serving that origin.
// v1:           lb-withdraw:<uid>                 — no instance proof at all.
const KEY_V3 = (inst, uid) => `lb-withdraw:${inst}:${uid}`
const KEY_V2 = (origin, uid) => `lb-withdraw:${origin}:${uid}`
const KEY_V1 = uid => `lb-withdraw:${uid}`

export function createPublisher({ store = useStore, client = { fetchMe, leaveLeaderboard, publishReport }, clock = Date.now, storage = globalThis.localStorage } = {}) {
  const get = () => store.getState()
  let started = false
  let timer = null
  let publishing = false
  let rerun = false
  let generation = 0
  let session = null           // the live session object; replaced whole on any switch
  const listeners = new Set()
  const status = { pending: false, lastOkAt: null, lastError: null, withdrawPending: false, withdrawAmbiguous: false }

  const emit = () => { for (const l of [...listeners]) l(status) }
  const setPending = v => { if (status.pending !== v) { status.pending = v; emit() } }
  const fail = e => { status.lastError = e?.message || String(e); setPending(true); emit() }
  // Acceptance clears the error and re-derives `pending` from the CURRENT facts (N08).
  const ok = () => {
    status.lastError = null
    status.lastOkAt = clock()
    status.pending = session && fingerprintOf(get().S) !== session.lastPublished
    emit()
  }

  /** The aggregate inputs, hashed cheaply: edits to an OLD session or a same-count activity
   *  swap move it, not just counts. */
  function fingerprintOf(S) {
    const w = (S?.workouts || []).map(x => [x.id, x.d, x.start ?? 0, x.end ?? 0])
    const a = (S?.activities || []).map(x => [x.id, x.startMs ?? 0, x.endMs ?? 0, !!x.userExcluded, !!x.sourceDeleted, x.linkedWorkoutId ?? null])
    return JSON.stringify([w, a])
  }

  /* ---------- withdrawal state, resolved per session ---------- */

  const readMark = key => { try { return storage.getItem(key) !== null } catch { return false } }
  const clearMark = key => { try { storage.removeItem(key) } catch { /* private mode */ } }
  const setMark = key => { try { storage.setItem(key, '1') } catch { /* private mode */ } }

  /** A v2 origin mark is provably ours while we are STILL serving that origin (a web app on
   *  the same deployment); on a paired phone the origin proves nothing about the server. */
  const originProvable = () => {
    try { return typeof location !== 'undefined' && location.origin && instanceOf(get()) === location.origin }
    catch { return false }
  }

  /** Withdrawal marks that apply to THIS session, and whether any of them is ambiguous
   *  (its instance cannot be proven): ambiguous blocks publishing and waits for the person. */
  function withdrawalState(sess) {
    const uid = sess.uid
    const current = readMark(KEY_V3(sess.instance, uid))
    const v2Here = originProvable() && readMark(KEY_V2(location.origin, uid))
    const v1 = readMark(KEY_V1(uid))
    const v2Elsewhere = !originProvable() && (() => {
      try {
        for (const k of Object.keys(storage)) if (k.startsWith('lb-withdraw:') && k.endsWith(`:${uid}`) && k.split(':').length === 3) return true
      } catch { /* private mode */ }
      return false
    })()
    return {
      pending: current || v2Here || v1 || v2Elsewhere,
      ambiguous: (!current && (v1 || v2Elsewhere)) // ours to act on only after the person says which server
    }
  }

  /** Withdraw with the offline guarantee. The mark (v3, this instance) is persisted first and
   *  blocks publishing immediately; the answer clears only what belongs to the captured
   *  session (N09/F07). */
  async function requestLeave(me) {
    const sess = session
    if (!sess) return { ok: false, error: new Error('not signed in') }
    setMark(KEY_V3(sess.instance, sess.uid))
    status.withdrawPending = true
    status.withdrawAmbiguous = false
    emit()
    try {
      await client.leaveLeaderboard(me)
      clearMark(KEY_V3(sess.instance, sess.uid))
      clearMark(KEY_V1(sess.uid)) // resolved once, in whichever format it was recorded
      if (session === sess) {
        status.withdrawPending = false
        sess.me = null
        ok()
      }
      return { ok: true }
    } catch (e) {
      if (session === sess) fail(e)
      return { ok: false, error: e }
    }
  }

  /** Resolve an ambiguous (unprovable-instance) withdrawal mark: 'here' — the person confirms
   *  the intent belongs to THIS server, so leave and clear; 'discard' — the person confirms
   *  they rejoined elsewhere, so drop the old mark. Either way publishing unblocks. */
  async function resolveAmbiguousWithdraw(action, me) {
    const sess = session
    if (!sess) return { ok: false }
    if (action === 'discard') {
      clearMark(KEY_V1(sess.uid))
      if (session === sess) { status.withdrawAmbiguous = false; status.withdrawPending = false; emit() }
      return { ok: true }
    }
    try {
      await client.leaveLeaderboard(me || sess.me)
      clearMark(KEY_V1(sess.uid))
      clearMark(KEY_V3(sess.instance, sess.uid))
      if (session === sess) { status.withdrawAmbiguous = false; status.withdrawPending = false; sess.me = null; ok() }
      return { ok: true }
    } catch (e) {
      if (session === sess) fail(e)
      return { ok: false, error: e }
    }
  }

  /* ---------- me cache, bound to the session (F07) ---------- */

  async function me(sess, force = false) {
    if (!force && sess.me && clock() - sess.meAt < ME_TTL_MS) return sess.me
    const m = await client.fetchMe()
    if (session !== sess) return m // a stale answer: hand it back, cache NOTHING
    sess.me = m
    sess.meAt = clock()
    return m
  }

  /* ---------- the publish pass ---------- */

  async function runPublish() {
    if (publishing) { rerun = true; return }
    publishing = true
    rerun = false
    try {
      const start = get()
      if (!start.user?.id || !start.config?.leaderboard) return
      const sess = session
      const stillUs = () => session === sess

      const wd = withdrawalState(sess)
      status.withdrawPending = wd.pending
      status.withdrawAmbiguous = wd.ambiguous
      if (wd.pending) {
        if (wd.ambiguous) { emit(); return } // F06: unprovable — the person resolves it
        const m = await me(sess, true)
        if (!stillUs()) return
        if (!m?.enabled) {
          clearMark(KEY_V3(sess.instance, sess.uid))
          clearMark(KEY_V1(sess.uid))
          status.withdrawPending = false
          emit()
          return
        }
        try {
          await client.leaveLeaderboard(m)
          if (!stillUs()) return
          clearMark(KEY_V3(sess.instance, sess.uid))
          clearMark(KEY_V1(sess.uid))
          status.withdrawPending = false
          sess.me = null
          ok()
        } catch (e) { fail(e) }
        return
      }

      // T01/F04: only THIS session's own confirmed exchange opens the gate.
      if (!sess.sessionSyncedAt) return
      const healthy = () => get().sync?.status === 'ok'
      if (!healthy()) return // offline/erroring/held-for-adoption: owed, not publishable
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return

      const factsSnapshot = get().S
      const fingerprint = fingerprintOf(factsSnapshot)
      let m = await me(sess)
      if (!stillUs() || !healthy()) return
      // Terminal gates are owed nothing — blocked on a person's decision, not a retry.
      if (!m?.enabled || m.suspended) { setPending(false); return }
      if (m.disclosureVersion !== m.currentDisclosureVersion) { setPending(false); return }

      // F03: the server's baseline is ahead of what THIS session produced — another device
      // published. A fresh reportRev does not authorize old facts: merge personal state first,
      // prove the merge landed (lastSynced moved), and rebuild from the merged state.
      if (m.reportRev > 0 && m.reportRev !== sess.lastAcceptedReportRev) {
        const before = get().sync?.lastSynced
        try { await get().pullState() } catch { return } // stays pending
        const after = get()
        const merged = stillUs()
          && after.sync?.status === 'ok'
          && after.sync?.lastSynced !== before // the exchange really confirmed, not just ran
        if (!merged) return
        m = await me(sess, true)
        if (!stillUs() || !healthy()) return
        if (!m?.enabled || m.suspended) { setPending(false); return }
        if (m.disclosureVersion !== m.currentDisclosureVersion) { setPending(false); return }
        if (fingerprintOf(after.S) === sess.lastPublished) { setPending(false); return } // merged to what's already published
      }

      // A fresh join / rejoin-after-withdrawal: the server holds nothing, publish everything.
      if (!m.reportRev) sess.lastPublished = ''
      if (fingerprint === sess.lastPublished) { setPending(false); return }

      const r = await client.publishReport(get().S, m, {
        // N03: the pull wrapper answers whether the merge actually landed healthy.
        pull: async () => {
          try { await get().pullState() } catch { return false }
          const st = get()
          return session === sess && st.sync?.status === 'ok'
        },
        // N04: the retry's facts come from the store only while it is still this session.
        stateOf: () => (session === sess ? get().S : null)
      })
      if (!stillUs() || !healthy()) return // the answer belongs to a previous session
      if (r.ok) {
        // Record the fingerprint of the facts actually accepted (the store may have moved).
        sess.lastPublished = fingerprintOf(get().S)
        sess.lastAcceptedReportRev = r.reportRev ?? m.reportRev
        ok()
      } else if (r.reason === 'disabled') {
        sess.me = null
        setPending(false)
      } else {
        fail(r.error || new Error('publication failed'))
      }
    } catch (e) {
      fail(e)
    } finally {
      publishing = false
      if (rerun) { rerun = false; schedule() }
    }
  }

  const schedule = () => {
    setPending(true)
    clearTimeout(timer)
    timer = setTimeout(runPublish, DEBOUNCE_MS)
  }

  /* ---------- the single subscription: session first, then everything else ---------- */

  function onStoreChange() {
    const st = get()
    const key = sessionKeyOf(st)
    if (!session || session.key !== key) {
      // F04: the WHOLE session object is replaced — credentials, caches, fingerprints, marks
      // — and the generation moves, so every in-flight task of the old session dies on its
      // next stillUs().
      generation++
      session = {
        key,
        generation,
        uid: st.user?.id,
        instance: instanceOf(st),
        baselineSyncedAt: st.sync?.lastSynced ?? 0,
        sessionSyncedAt: 0,
        me: null,
        meAt: 0,
        lastAcceptedReportRev: null,
        lastPublished: ''
      }
      const wd = withdrawalState(session)
      status.withdrawPending = wd.pending
      status.withdrawAmbiguous = wd.ambiguous
      setPending(false)
      return
    }
    // Same session: a confirmed exchange moves lastSynced off THIS session's baseline.
    const synced = st.sync?.lastSynced
    if (typeof synced === 'number' && synced !== session.baselineSyncedAt) session.sessionSyncedAt = synced
    if (!st.user || !st.S) return
    if (st.sync?.status && st.sync.status !== 'ok') return
    if (!session.sessionSyncedAt) return
    const wd2 = withdrawalState(session)
    if (fingerprintOf(st.S) === session.lastPublished && !wd2.pending) return
    schedule()
  }

  function start() {
    if (started) return
    started = true
    unsub = store.subscribe(onStoreChange)
    onStoreChange() // register the initial session before the first pass
    window.addEventListener('online', onOnline)
    runPublish()
  }
  let unsub = null
  const onOnline = () => { if (status.pending) runPublish() }
  function stop() {
    if (unsub) { unsub(); unsub = null }
    window.removeEventListener('online', onOnline)
    clearTimeout(timer)
    started = false
  }

  return {
    start, stop,
    retryNow: runPublish,
    requestLeave,
    resolveAmbiguousWithdraw,
    invalidateMe() { if (session) { session.me = null; session.meAt = 0 } },
    publishStatus() { return status },
    onPublishStatus(l) { listeners.add(l); return () => listeners.delete(l) },
    fingerprintOf
  }
}

/* ---------- the app's single instance (App starts it; tests may build their own) ---------- */

const singleton = typeof window !== 'undefined'
  ? createPublisher({})
  : null

export const startPublishing = () => singleton?.start()
export const retryNow = () => singleton?.retryNow()
export const publishStatus = () => singleton
  ? singleton.publishStatus()
  : { pending: false, lastOkAt: null, lastError: null, withdrawPending: false, withdrawAmbiguous: false }
export const onPublishStatus = l => singleton?.onPublishStatus(l) || (() => {})
export const requestLeave = (...a) => singleton?.requestLeave(...a) ?? { ok: false, error: new Error('no session') }
export const resolveAmbiguousWithdraw = (...a) => singleton?.resolveAmbiguousWithdraw(...a) ?? { ok: false }
export const invalidateMe = () => singleton?.invalidateMe()
export function fingerprintOf(S) { return singleton ? singleton.fingerprintOf(S) : '[]' }
