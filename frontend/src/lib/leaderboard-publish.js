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
import { fingerprintOf } from './leaderboard.js'
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
  let active = false // G08: false once stopped — in-flight answers must be refused
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

  

  /* ---------- withdrawal state, resolved per session ---------- */

  const readMark = key => { try { return storage.getItem(key) !== null } catch { return false } }
  const clearMark = key => { try { storage.removeItem(key) } catch { /* private mode */ } }
  const setMark = key => { try { storage.setItem(key, '1') } catch { /* private mode */ } }

  /* ---------- withdrawal marks, resolved per session (G04) ----------
   * Historical keys are captured as WHOLE strings and classified by exact prefix, never by
   * counting colons — real origins carry protocol and port colons (lb-withdraw:http://local
   * host:3000:a is five segments). Every capture records the actual key so confirm/discard
   * removes exactly what it recognized. */

  /** A v2 origin mark is provably ours only while THIS device literally serves that origin
   *  (same web deployment); on a paired phone the WebView origin proves nothing. */
  const originProvable = () => {
    try { return typeof location !== 'undefined' && !!location.origin && instanceOf(get()) === location.origin }
    catch { return false }
  }

  /** Every stored withdrawal key for this uid, with its provenance. */
  function historicalKeys(sess) {
    const out = { here: [], ambiguous: [] }
    try {
      for (const key of Object.keys(storage)) {
        if (typeof storage[key] === 'function') continue // the storage's own methods
        if (!key.startsWith('lb-withdraw:') || !key.endsWith(`:${sess.uid}`)) continue
        if (key === KEY_V3(sess.instance, sess.uid)) { out.here.push(key); continue } // current format, this server
        const rest = key.slice('lb-withdraw:'.length, key.length - sess.uid.length - 1)
        if (rest.includes(':')) {
          // v2-style: lb-withdraw:<origin-or-base>:<uid>. Provable only while THIS device is
          // literally serving that origin (same web deployment); on a paired phone the
          // WebView origin proves nothing about any server.
          if (originProvable() && rest === location.origin) out.here.push(key)
          else out.ambiguous.push(key)
        } else {
          out.ambiguous.push(key) // v1: no instance proof at all
        }
      }
    } catch { /* storage unavailable: nothing to resolve */ }
    return out
  }

  function withdrawalState(sess) {
    const hist = historicalKeys(sess)
    return {
      pending: hist.here.length > 0 || hist.ambiguous.length > 0 || sess.withdrawMarked,
      ambiguous: hist.here.length === 0 && hist.ambiguous.length > 0
    }
  }

  /** Withdraw with the offline guarantee. The v3 mark (this instance) is persisted first and
   *  blocks publishing immediately; the answer clears only what belongs to the captured
   *  session (N09/F07). */
  async function requestLeave(me) {
    const sess = session
    if (!sess) return { ok: false, error: new Error('not signed in') }
    setMark(KEY_V3(sess.instance, sess.uid))
    sess.withdrawMarked = true
    status.withdrawPending = true
    status.withdrawAmbiguous = false
    emit()
    try {
      await client.leaveLeaderboard(me)
      clearMark(KEY_V3(sess.instance, sess.uid))
      sess.withdrawMarked = false
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

  /** Resolve an ambiguous historical mark (G04/G05): 'here' — the person confirms the intent
   *  belongs to THIS server, so leave and clear every captured key; 'discard' — the person
   *  says the intent belongs elsewhere, so drop exactly the captured keys. Either way the
   *  same records that were recognized are the ones removed. */
  async function resolveAmbiguousWithdraw(action, me) {
    const sess = session
    if (!sess) return { ok: false }
    const hist = historicalKeys(sess)
    if (action === 'discard') {
      for (const key of hist.ambiguous) clearMark(key)
      if (session === sess) {
        const wd = withdrawalState(sess)
        status.withdrawAmbiguous = wd.ambiguous
        status.withdrawPending = wd.pending
        emit()
      }
      return { ok: true }
    }
    try {
      await client.leaveLeaderboard(me || sess.me)
      for (const key of [...hist.ambiguous, ...hist.here]) clearMark(key)
      sess.withdrawMarked = false
      if (session === sess) {
        const wd = withdrawalState(sess)
        status.withdrawAmbiguous = wd.ambiguous
        status.withdrawPending = wd.pending
        sess.me = null
        ok()
      }
      return { ok: true }
    } catch (e) {
      if (session === sess) fail(e)
      return { ok: false, error: e }
    }
  }

  /* ---------- the me cache, bound to the session (F07) ---------- */

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
      const stillUs = () => active && session === sess

      const wd = withdrawalState(sess)
      status.withdrawPending = wd.pending
      status.withdrawAmbiguous = wd.ambiguous
      if (wd.pending) {
        if (wd.ambiguous) { emit(); return } // F06: unprovable — the person resolves it
        const m = await me(sess, true)
        if (!stillUs()) return
        if (!m?.enabled) {
          // Already out server-side: every captured mark for this uid is resolved.
          for (const key of [...historicalKeys(sess).here, ...historicalKeys(sess).ambiguous]) clearMark(key)
          sess.withdrawMarked = false
          const wd = withdrawalState(sess)
          status.withdrawPending = wd.pending
          status.withdrawAmbiguous = wd.ambiguous
          emit()
          return
        }
        try {
          await client.leaveLeaderboard(m)
          if (!stillUs()) return
          for (const key of [...historicalKeys(sess).here, ...historicalKeys(sess).ambiguous]) clearMark(key)
          sess.withdrawMarked = false
          const wd = withdrawalState(sess)
          status.withdrawPending = wd.pending
          status.withdrawAmbiguous = wd.ambiguous
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

      const fingerprint = fingerprintOf(get().S)
      const prevSeen = sess.lastSeenReportRev
      let m = await me(sess)
      if (!stillUs() || !healthy()) return
      sess.lastSeenReportRev = m.reportRev
      // Terminal gates are owed nothing — blocked on a person's decision, not a retry.
      if (!m?.enabled || m.suspended) { setPending(false); return }
      if (m.disclosureVersion !== m.currentDisclosureVersion) { setPending(false); return }

      // F03: the server's baseline is ahead of what THIS session produced — another device
      // published. A fresh reportRev does not authorize old facts: merge personal state first,
      // prove the merge landed (lastSynced moved), and rebuild from the merged state.
      // A rev DIFFERENT from the one this session last saw means another device published
      // in between (G03): a fresh reportRev does not authorize old facts — merge first and
      // rebuild. The first publish of a session has no earlier sighting; its pairing is
      // verified server-side via personalRev instead.
      // G03: whenever the server's baseline could be someone else's newer publish — a rev
      // different from the one this session last saw, or any server-side report before this
      // session's FIRST publish (our facts may predate it) — merge personal state first and
      // rebuild, looping until the baseline is stable across a whole merge. The stability
      // check closes the merge→read window; the personalRev pairing (verified server-side)
      // closes the send window. A merge that does not confirm (pullState swallowed a failure)
      // leaves the publish pending.
      if (prevSeen == null ? m.reportRev > 0 : m.reportRev !== prevSeen) {
        let merged = false
        for (let attempt = 0; attempt < 3 && !merged; attempt++) {
          const revBefore = m.reportRev
          const syncBefore = get().sync?.lastSynced
          try { await get().pullState() } catch { return } // stays pending
          const after = get()
          if (!(stillUs() && after.sync?.status === 'ok' && after.sync?.lastSynced !== syncBefore)) return
          m = await me(sess, true)
          if (!stillUs() || !healthy()) return
          sess.lastSeenReportRev = m.reportRev
          if (m.reportRev === revBefore) merged = true // no new publish during the merge
        }
        if (!merged) return // still racing after 3 rounds: retry on the next change
        if (!m?.enabled || m.suspended) { setPending(false); return }
        if (m.disclosureVersion !== m.currentDisclosureVersion) { setPending(false); return }
        if (fingerprintOf(get().S) === sess.lastPublished) { setPending(false); return }
      }

      // A fresh join / rejoin-after-withdrawal: the server holds nothing, publish everything.
      if (!m.reportRev) sess.lastPublished = ''
      if (fingerprint === sess.lastPublished) { setPending(false); return }

      const sentFacts = get().S // captured at send: the fallback when the client cannot name the accepted fingerprint
      const r = await client.publishReport(sentFacts, m, {
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
        // G02: record the fingerprint of the facts the server ACTUALLY accepted (the 409
        // recovery may have sent the merged retry, not the caller's snapshot) — the response
        // carries it, so no guessing from the response-time store.
        sess.lastPublished = r.acceptedFingerprint ?? fingerprintOf(sentFacts)
        sess.lastAcceptedReportRev = r.reportRev ?? m.reportRev
        sess.lastSeenReportRev = sess.lastAcceptedReportRev
        if (sess.me) sess.me = { ...sess.me, reportRev: sess.lastSeenReportRev } // the cache must not look stale next round
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
        lastSeenReportRev: null,
        withdrawMarked: false,
        lastPublished: ''
      }
      const wd = withdrawalState(session)
      status.withdrawPending = wd.pending
      status.withdrawAmbiguous = wd.ambiguous
      setPending(false)
      // The new session may already hold unpublished facts; give it its own first pass once
      // its merge credential exists. (Its runPublish exits at the credential gate until then.)
      if (started && active) schedule()
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
    active = true
    unsub = store.subscribe(onStoreChange)
    onStoreChange() // register the initial session before the first pass
    window.addEventListener('online', onOnline)
    runPublish()
  }
  let unsub = null
  const onOnline = () => { if (status.pending) runPublish() }
  function stop() {
    // G08: going inactive first — every stillUs() turns false, so an in-flight me()/report()
    // answer is dropped instead of seeding caches, setting status, or sending more requests.
    // Already-sent requests cannot be un-sent; nothing further leaves from here.
    active = false
    if (unsub) { unsub(); unsub = null }
    window.removeEventListener('online', onOnline)
    clearTimeout(timer)
    session = null
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
