import { useStore } from '../store/useStore.js'
import { fingerprintOf } from './leaderboard.js'
import { syncFingerprint } from './sync-changes.js'
import { fetchMe, leaveLeaderboard, publishReport } from './leaderboard-client.js'

// The leaderboard's global publisher — a session machine, not a pile of module globals.
//
// One publisher instance (created once from App), one store subscription, and ONE session
// object at a time. Every switch — sign-out, A→B, B→A, the same uid onto another paired
// server — swaps the whole object (F04: a merge credential from one session can never
// authorize the next), and every async step re-validates the captured object before touching
// cache, marks or status (F07: an old me response cannot seed the new session's cache; an old
// leave cannot clear the new session's mark).
//
// A publish requires (T01/F03): the CURRENT session has completed its own confirmed exchange
// (lastSynced moved off this session's baseline — a value restored from storage proves
// nothing), AND the report's facts and their personal-state revision are captured in ONE
// snapshot (I02). When the server's reportRev is ahead of what this session produced —
// another device published — sending is only allowed AFTER a fresh personal merge lands and
// the report is rebuilt from the merged snapshot; the merge must itself move lastSynced
// (pullState swallows its own failures, so "it was called" proves nothing).
//
// Withdrawal marks (F05/F06) know every format this app ever wrote, and an old mark whose
// instance cannot be proven blocks publishing and waits for the person to resolve it — it is
// never silently dropped, never replayed against a server it cannot be proven to belong to.
// Every withdrawal path — direct, automatic retry, ambiguous-resolution, already-out —
// captures the exact marks it acts on and may clear only those, only while unchanged (I05);
// the pending state is always re-derived from the marks that remain.

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

  const clearMark = key => { try { storage.removeItem(key) } catch { /* private mode */ } }
  const setMark = (key, intentId) => { try { storage.setItem(key, JSON.stringify({ v: 3, i: intentId })) } catch { /* private mode */ } }

  /** A withdrawal intent id — browser crypto when present (everywhere this app ships), a
   *  timestamp+random fallback for the odd WebView without it. No Node import: this module
   *  is part of the browser bundle (the round-7 build warning). */
  const newIntentId = () => {
    try { if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID() } catch { /* unavailable */ }
    return String(clock()) + '-' + Math.random().toString(36).slice(2)
  }

  /* I05/J04 — the one rule every withdrawal path shares: a response may clear only the
   * exact marks it was sent against, captured (key + stored value) BEFORE the request, and
   * only while the stored value is still byte-for-byte the same one. A newer intent that
   * replaced a mark while the request was in flight survives; the pending state is always
   * re-derived from the marks that remain, never asserted from this one answer.
   *
   * The in-memory half (J04): a session tracks its outstanding leave intents BY ID, not by
   * one boolean — the boolean could only be cleared under a condition the old derivation
   * made unsatisfiable (withdrawalState folded it into pending before the check), so an
   * automatic withdrawal that had succeeded kept the UI in "leaving" forever. Ids settle
   * individually: superseded when a newer request replaces the mark, deleted when the
   * captured mark they stand for is acknowledged away. */
  const rawMark = key => { try { return storage.getItem(key) } catch { return null } }
  /** Capture the marks a withdrawal outcome may act on, SCOPED to a provenance group (M02):
   *  'here' — only keys that provably belong to the current instance (the only ones an
   *  automatic flow may ever settle); 'ambiguous' — only keys whose instance ownership
   *  nobody here can prove (the person's explicit discard acts on these); no group — both,
   *  for the explicit confirm whose leave covers everything the person just attested to.
   *  A current-instance success must never acknowledge a mark it cannot attribute — the
   *  old blanket capture silently deleted another instance's pending decision. */
  const captureMarks = (sess, group) => {
    const hist = historicalKeys(sess)
    const keys = group === 'here' ? hist.here : group === 'ambiguous' ? hist.ambiguous : [...hist.here, ...hist.ambiguous]
    return keys.map(key => ({ key, raw: rawMark(key) })).filter(c => c.raw !== null)
  }
  const acknowledgeMarks = captured => {
    for (const { key, raw } of captured) if (rawMark(key) === raw) clearMark(key)
  }
  /** Settle the outcome of a confirmed leave: acknowledge the captured marks (each only
   *  while still byte-for-byte the mark it was sent against — I05), and end the
   *  in-memory intent this outcome may speak for. `endableId` is the id the COMPLETED
   *  request represents: a direct request's own id, or the id that was current when an
   *  automatic retry captured it. An intent that has since been REPLACED by a newer one
   *  is never ended by an older outcome — and crucially, an intent is ended by IDENTITY,
   *  never by "no persisted mark records it" (L02): a decision whose storage write
   *  failed lives in memory and stays pending until its own confirmation, an explicit
   *  replacement, or a later leave confirmed for this account+instance while it was
   *  still the current decision. */
  function settleIntents(sess, captured, endableId) {
    acknowledgeMarks(captured)
    if (endableId != null && sess.currentIntentId === endableId) sess.currentIntentId = null
  }

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
      pending: hist.here.length > 0 || hist.ambiguous.length > 0 || sess.currentIntentId != null,
      // M02: ANY unproven mark demands the person — also when a provable mark sits next
      // to it. The old "only when nothing provable exists" rule let a current-instance
      // success ride over an unknown instance's pending decision (the mixed capture
      // acknowledged both). The automatic flow stays gated off until the person says
      // what the unproven mark was; the provable part either resolves with that same
      // explicit confirmation or auto-completes once the unknown side is decided.
      ambiguous: hist.ambiguous.length > 0
    }
  }

  /** Withdraw with the offline guarantee. The v3 mark (this instance) is persisted first and
   *  blocks publishing immediately; the answer clears only the mark it was sent against,
   * only while that mark is still this exact intent (I05) — a newer intent made while the
   * request was in flight keeps its mark and keeps the withdrawal pending. */
  async function requestLeave(me) {
    const sess = session
    if (!sess) return { ok: false, error: new Error('not signed in') }
    const key = KEY_V3(sess.instance, sess.uid)
    const intentId = newIntentId()
    // The decision is current from the moment it is made (K03/L02): the in-memory intent
    // is this one — explicitly replacing whatever was current, so no ghost can
    // accumulate — and the persisted mark is a best-effort copy, not the decision
    // itself. A storage that cannot hold marks leaves the decision alive in memory:
    // its pending state and its protection against publishing survive, and its own
    // confirmation ends it without ever needing the mark.
    sess.currentIntentId = intentId
    setMark(key, intentId)
    const captured = [{ key, raw: rawMark(key) }].filter(c => c.raw !== null)
    status.withdrawPending = true
    // Marks of unknown provenance that already sat in storage keep demanding the person
    // (M02) — this new decision for the current instance does not speak for them.
    status.withdrawAmbiguous = historicalKeys(sess).ambiguous.length > 0
    emit()
    try {
      await client.leaveLeaderboard(me)
      settleIntents(sess, captured, intentId) // its own marks, its own intent (I05/J04/L02)
      if (session === sess) {
        const wd = withdrawalState(sess)
        status.withdrawPending = wd.pending
        status.withdrawAmbiguous = wd.ambiguous
        sess.me = null
        if (!wd.pending) ok()
        else emit()
      }
      return { ok: true }
    } catch (e) {
      if (session === sess) fail(e)
      return { ok: false, error: e }
    }
  }

  /** Resolve an ambiguous historical mark (G04/G05): 'here' — the person confirms the intent
   *  belongs to THIS server, so leave and clear the captured marks; 'discard' — the person
   *  says the intent belongs elsewhere, so drop them. Either way the marks that were
   *  recognized are the ones acted on, and only while unchanged (I05). The person's
   *  decision is scoped to what they actually decided (M02): a discard attests that the
   *  UNPROVABLE marks are not ours — provable marks next to them are still this
   *  instance's outstanding decision and stay pending; a confirm attests that
   *  everything captured belongs here, so its leave may settle all of it. */
  async function resolveAmbiguousWithdraw(action, me) {
    const sess = session
    if (!sess) return { ok: false }
    const captured = captureMarks(sess, action === 'discard' ? 'ambiguous' : undefined)
    if (action === 'discard') {
      acknowledgeMarks(captured)
      if (session === sess) {
        const wd = withdrawalState(sess)
        status.withdrawAmbiguous = wd.ambiguous
        status.withdrawPending = wd.pending
        emit()
      }
      return { ok: true }
    }
    const intentAtCapture = sess.currentIntentId // the memory decision this resolution acts for (L02)
    try {
      await client.leaveLeaderboard(me || sess.me)
      // The leave landed for the captured marks' account and instance — they are resolved
      // wherever they are still the marks this resolution captured (I05/J04).
      settleIntents(sess, captured, intentAtCapture)
      if (session === sess) {
        const wd = withdrawalState(sess)
        status.withdrawAmbiguous = wd.ambiguous
        status.withdrawPending = wd.pending
        sess.me = null
        if (!wd.pending) ok()
        else emit()
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
    let sess = null // hoisted: the catch must know whose failure it is handling (H09)
    try {
      const start = get()
      if (!start.user?.id || !start.config?.leaderboard) return
      sess = session
      const stillUs = () => active && session === sess

      const wd = withdrawalState(sess)
      status.withdrawPending = wd.pending
      status.withdrawAmbiguous = wd.ambiguous
      if (wd.pending) {
        if (wd.ambiguous) { emit(); return } // F06: unprovable — the person resolves it
        // I05/J04/L02/M02: the marks this automatic retry may act on are captured BEFORE
        // the me fetch and the request — and so is the id of the memory decision that
        // was current when the retry began. Its outcome settles exactly these, never
        // the marks or the newer intent a request made while it was in flight — and
        // only PROVABLY-current-instance marks at that: an unattributable mark is the
        // person's decision, never this request's to acknowledge.
        const captured = captureMarks(sess, 'here')
        const intentAtCapture = sess.currentIntentId
        const m = await me(sess, true)
        if (!stillUs()) return
        if (!m?.enabled) {
          // Already out server-side: the captured marks' goal is the server's state, not
          // this request — they are resolved wherever they are still the captured ones,
          // and so is the memory decision this retry captured (unchanged).
          settleIntents(sess, captured, intentAtCapture)
          sess.me = null // the member's state just changed: never pin the "out" answer
          const wd2 = withdrawalState(sess)
          status.withdrawPending = wd2.pending
          status.withdrawAmbiguous = wd2.ambiguous
          if (!wd2.pending) ok()
          else emit()
          return
        }
        try {
          await client.leaveLeaderboard(m)
          if (!stillUs()) return
          settleIntents(sess, captured, intentAtCapture)
          const wd2 = withdrawalState(sess)
          status.withdrawPending = wd2.pending
          status.withdrawAmbiguous = wd2.ambiguous
          sess.me = null
          if (!wd2.pending) ok()
          else emit()
        } catch (e) {
          // I06: the inner catch checks the session too — a withdrawal started under A that
          // fails after the switch must not paint B's error state (the outer catch's H09
          // rule, applied to this branch's own await as well).
          if (stillUs()) fail(e)
        }
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
      // G03/H02: whenever the server's baseline could be someone else's newer publish — a
      // rev different from the one this session last SAW, or any server-side report before
      // this session's FIRST publish — merge personal state first and rebuild, looping until
      // the baseline is stable across a whole merge. "Seen" is not "merged into": on
      // exhaustion the sighting is restored, so the next round still owes a merge. After a
      // stable merge the session records the personal-state revision the NEW facts were
      // confirmed at (sync.rev) — the only version a report may claim (H02).
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
          if (m.reportRev === revBefore) merged = true // no new publish during the merge
        }
        if (!merged) {
          sess.lastSeenReportRev = prevSeen // H02: exhaustion keeps the merge obligation
          return // retry on the next change; never send facts older than the baseline
        }
        sess.lastSeenReportRev = m.reportRev
        // I02: no second version field is recorded here — the send below captures facts and
        // rev in one snapshot, so the pairing can never come from a different moment.
        if (!m?.enabled || m.suspended) { setPending(false); return }
        if (m.disclosureVersion !== m.currentDisclosureVersion) { setPending(false); return }
        if (fingerprintOf(get().S) === sess.lastPublished) { setPending(false); return }
      }

      // A fresh join / rejoin-after-withdrawal: the server holds nothing, publish everything.
      if (!m.reportRev) sess.lastPublished = ''
      if (fingerprint === sess.lastPublished) { setPending(false); return }

      /* I02/J02: the facts, the personal-state revision they were confirmed at, and the
       * PROOF they were confirmed — captured in ONE read. A snapshot is sendable only when
       * the local copy IS the copy the server holds: sync healthy, and (when the store
       * publishes one — it does since the J02 wiring) the confirmed fingerprint matches the
       * current state. The round-8 hole: during a 409 recovery's fresh me fetch, a local
       * edit made the facts newer than the last sync while the rev still matched the
       * server's, and the unconfirmed hour was published ahead of its own personal save —
       * against the PRD's order (personal sync first, then aggregate). 'unconfirmed' means
       * "wait for the personal sync, then take a fresh snapshot"; null means "this session
       * is gone". */
      const snapshotOf = () => {
        if (!(active && session === sess)) return null
        const st = get()
        if (st.sync?.status !== 'ok') return 'unconfirmed'
        const fp = st.sync?.confirmedFp   // the store's proof: a JSON string (J02 wiring)
        if (typeof fp === 'string' && JSON.stringify(syncFingerprint(st.S)) !== fp) return 'unconfirmed'
        return { facts: st.S, rev: Number.isFinite(st.sync?.rev) ? st.sync.rev : null }
      }
      const snapshot = snapshotOf()
      if (snapshot === null) return
      if (snapshot === 'unconfirmed') { setPending(true); return } // owed to the personal sync first
      const r = await client.publishReport(snapshot, m, {
        // N03: the pull wrapper answers whether the merge actually landed healthy.
        pull: async () => {
          try { await get().pullState() } catch { return false }
          const st = get()
          return session === sess && st.sync?.status === 'ok'
        },
        // I02: the retry's facts and rev come from the store together, only while it is
        // still this session (N04: an account switch answers null and the publish stays
        // pending — it is never rebuilt from a stranger's store).
        snapshotOf
      })
      if (!stillUs() || !healthy()) return // the answer belongs to a previous session
      if (r.ok) {
        // G02/I02: record the fingerprint of the facts the server ACTUALLY accepted — the
        // 409 recovery may have sent the re-captured snapshot, not the caller's. The answer
        // names it; the fallback is what THIS pass sent (the snapshot), never a response-time
        // re-read of the store — a change landing mid-flight must not count as published.
        sess.lastPublished = r.acceptedFingerprint ?? fingerprintOf(snapshot.facts)
        sess.lastAcceptedReportRev = r.reportRev ?? m.reportRev
        sess.lastSeenReportRev = sess.lastAcceptedReportRev
        if (sess.me) sess.me = { ...sess.me, reportRev: sess.lastSeenReportRev } // the cache must not look stale next round
        ok()
      } else if (r.reason === 'disabled') {
        sess.me = null
        setPending(false)
      } else if (r.reason === 'needs-sync') {
        // J02: the recovery found local facts the server has not confirmed — owed to the
        // personal sync, not an error. The next confirmed exchange re-runs this pass.
        setPending(true)
      } else {
        fail(r.error || new Error('publication failed'))
      }
    } catch (e) {
      // H09: a late failure belongs to the session that started it — a replaced or stopped
      // session's rejection must not paint the new session's status.
      if (sess && active && session === sess) fail(e)
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
      // F04: the WHOLE session object is replaced — credentials, caches, fingerprints, marks.
      // The isolation is the IDENTITY swap: in-flight tasks hold the old object and die on
      // their next stillUs(), which compares session objects, not this counter. The
      // generation is diagnostic bookkeeping for logs/tests, never a gate.
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
        currentIntentId: null,          // the CURRENT leave decision's id — one slot, replaced
                                        // explicitly by every newer request (K03), ended only by
                                        // its own confirmation (L02); persisted marks are a
                                        // best-effort copy of it, never the decision itself
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
