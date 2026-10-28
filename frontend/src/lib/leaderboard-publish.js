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
  const status = { pending: false, lastOkAt: null, lastError: null, withdrawPending: false, withdrawAmbiguous: false, withdrawConflict: false, withdrawSaved: false }

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
  // B02=A: a leave intent binds the authorization (consentVersion) it was made against — the
  // persisted copy rides in the mark, the memory decision keeps it beside the id.
  const setMark = (key, intentId, cv) => {
    try { storage.setItem(key, JSON.stringify({ v: 3, i: intentId, cv })); return true }
    catch { return false } // private mode / quota: the decision stays in memory only (B04)
  }
  const cvOfMark = raw => { try { const p = JSON.parse(raw); return Number.isFinite(p?.cv) ? p.cv : null } catch { return null } }

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
  const intentIdOf = raw => { try { const p = JSON.parse(raw); return p && typeof p.i === 'string' ? p.i : null } catch { return null } }

  /* ---------- completion records: written once, read everywhere (S03) ----------
   * R04/R05 made a withdrawal outcome finish its INTENT (by id) instead of deleting the
   * shared mark a newer tab may have replaced. The round-14 version only remembered those
   * ids in the live session's Set and wrote a record nobody read: a reload, a second tab or
   * a fresh sign-in started with an empty Set, saw the mark still on disk (the protocol
   * keeps it as evidence) and called the finished intent outstanding again — the exit became
   * a pending withdrawal, or an old conflict, all over again.
   *
   * So completion is now a READ-WRITE contract, not a write-only one:
   *   - `store`  — `lb-withdraw-ack:<instance>:<uid>:<intentId>`, carrying the version, the
   *                intent id, the account, the INSTANCE and the reason. The namespace sits
   *                outside the `lb-withdraw:` mark prefix, so no historical-key scan mistakes
   *                it for a mark. Everything is read by exact key, never by counting colons:
   *                an origin carries colons of its own, and a v1 record
   *                (`lb-withdraw-ack:<uid>:<intentId>`) is a different key, not a shorter one.
   *   - `read`   — one lookup by id per question, never a scan, and never cached: a second
   *                tab's write must be visible here on the next derivation, not after a
   *                restart (a cache is exactly how S03 would come back).
   *   - `proof`  — a record that cannot be parsed, or that names another version, account or
   *                instance, is NOT a reliable completion: it is left for the operator and the
   *                intent stays outstanding. Only an exact match completes.
   *
   * v1 records (no instance) are migrated only when they can be PROVEN to correspond to a
   * mark this instance still holds — the intent id of the `lb-withdraw:<instance>:<uid>`
   * mark. An unattributable v1 record is left untouched and never completes anything: reusing
   * it across instances is the one thing it cannot support. */
  const ACK_VERSION = 2
  const ackKey = (instance, uid, intentId) => `lb-withdraw-ack:${instance}:${uid}:${intentId}`
  const legacyAckKey = (uid, intentId) => `lb-withdraw-ack:${uid}:${intentId}`

  const validAck = (raw, { intentId, uid, instance }) => {
    let p
    try { p = JSON.parse(raw) } catch { return null } // corrupt: not evidence of anything
    if (!p || typeof p !== 'object') return null
    if (p.v !== ACK_VERSION || p.i !== intentId || p.uid !== uid || p.instance !== instance) return null
    return p
  }

  /** The completion record for this intent, or null. Never throws: an unreadable store
   *  answers "not completed", which keeps the intent pending (honest) instead of finishing
   *  a leave this device cannot prove happened. */
  function readCompletion(sess, intentId) {
    if (intentId == null) return null
    let raw = null
    try { raw = storage.getItem(ackKey(sess.instance, sess.uid, intentId)) } catch { return null }
    if (raw != null) return validAck(raw, { intentId, uid: sess.uid, instance: sess.instance })
    // v1 → v2, only with proof: this instance's own mark still carrying this same intent id.
    try {
      const legacy = storage.getItem(legacyAckKey(sess.uid, intentId))
      if (legacy == null) return null
      const old = JSON.parse(legacy)
      if (!old || old.v !== 1 || old.i !== intentId) return null
      if (intentIdOf(rawMark(KEY_V3(sess.instance, sess.uid))) !== intentId) return null
      const migrated = { v: ACK_VERSION, i: intentId, uid: sess.uid, instance: sess.instance, reason: 'migrated', at: clock() }
      try { storage.setItem(ackKey(sess.instance, sess.uid, intentId), JSON.stringify(migrated)) } catch { /* still valid for this pass */ }
      return migrated
    } catch { return null }
  }

  /** THE question every reader asks (S03): completed in this session, or on disk? */
  const isIntentCompleted = (sess, intentId) =>
    intentId != null && (sess.completed.has(intentId) || readCompletion(sess, intentId) != null)

  /** Record that an intent is finished. Returns whether the record reached storage — the
   *  only honest answer to "will this survive a restart"; the in-memory copy governs this
   *  session either way, and a repeat records nothing twice (settle + acknowledge used to
   *  write the same id twice). */
  const recordCompletion = (sess, intentId, reason = 'left') => {
    if (intentId == null) return false
    const known = sess.completed.has(intentId)
    sess.completed.add(intentId)
    if (known && readCompletion(sess, intentId) != null) return true // nothing new to write
    try {
      storage.setItem(ackKey(sess.instance, sess.uid, intentId),
        JSON.stringify({ v: ACK_VERSION, i: intentId, uid: sess.uid, instance: sess.instance, reason, at: clock() }))
      return true
    } catch {
      // Storage refused: the completion lives in memory only. A restart re-runs the
      // idempotent leave, which is safe but must never be presented as durable.
      return false
    }
  }
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
  const acknowledgeMarks = (sess, captured, reason = 'left') => {
    let persisted = true
    for (const { key, raw } of captured) {
      const id = intentIdOf(raw)
      // Already completed by the caller's identity pass (settleIntents records every id it
      // settles): do not rewrite the same ack record a second time.
      if (id != null) {
        if (!sess.completed.has(id) && !recordCompletion(sess, id, reason)) persisted = false
        continue
      }
      // An unidentifiable mark has no id to ack: the person's explicit decision over a
      // byte-for-byte unchanged mark is the only evidence there is — delete it as before.
      if (rawMark(key) === raw) clearMark(key)
    }
    return persisted
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
  function settleIntents(sess, captured, endableId, reason = 'left') {
    // R04/R05: complete exactly the intents this outcome captured — by ID, never by
    // deleting a shared key a newer tab may have replaced. The memory-only decision this
    // outcome speaks for (endableId) completes with them.
    const ids = new Set()
    for (const { raw } of captured) {
      const id = intentIdOf(raw)
      if (id != null) ids.add(id)
    }
    if (endableId != null) ids.add(endableId)
    let persisted = true
    for (const id of ids) { if (!recordCompletion(sess, id, reason)) persisted = false }
    if (!acknowledgeMarks(sess, captured, reason)) persisted = false
    // Session FACTS only (O03): whether the UI shows the resolution is the projection's
    // business, under the caller's session-identity check — a late response from a
    // replaced session mutates nothing it does not own. The current slot clears only when
    // the completed outcome is the decision it holds (R05: a restored, purely persisted
    // intent has no slot — its completion is recorded by id above).
    if (endableId != null && sess.currentIntentId === endableId) {
      sess.currentIntentId = null
      sess.currentIntentCv = null
      sess.currentIntentPersisted = false
    }
    return persisted
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
    // R04/R05 + S03: a persisted mark is outstanding while its intent id has no completion
    // record — in this session OR on disk. The disk half is what a reload, a second tab and
    // a fresh sign-in depend on; reading it per derivation (never once at startup) is what
    // lets an already-open tab notice another tab finishing the same intent.
    // An unidentifiable mark (no parseable id — a pre-protocol mark) always waits for the
    // person; it can never be silently completed by an id it does not have.
    const outstandingPersisted = [...hist.here, ...hist.ambiguous].filter(key => {
      const id = intentIdOf(rawMark(key))
      return id == null || !isIntentCompleted(sess, id)
    })
    const memoryPending = sess.currentIntentId != null && !isIntentCompleted(sess, sess.currentIntentId)
    return {
      pending: outstandingPersisted.length > 0 || memoryPending,
      // M02: ANY unproven mark demands the person — also when a provable mark sits next
      // to it. The old "only when nothing provable exists" rule let a current-instance
      // success ride over an unknown instance's pending decision (the mixed capture
      // acknowledged both). The automatic flow stays gated off until the person says
      // what the unproven mark was; the provable part either resolves with that same
      // explicit confirmation or auto-completes once the unknown side is decided.
      ambiguous: hist.ambiguous.some(key => {
        const id = intentIdOf(rawMark(key))
        return id == null || !isIntentCompleted(sess, id)
      }),
      // B04: "saved" means the pending decision's mark is REALLY persisted. A decision
      // whose storage write failed lives in memory only — the UI must never promise it
      // will survive a restart, and must warn until it is saved and confirmed.
      saved: memoryPending ? sess.currentIntentPersisted === true : outstandingPersisted.length > 0,
      // R05: the conflict is alive only while at least one of its target intents is still
      // uncompleted — completing them (a confirmed out, a Keep, a replacement) ends it.
      conflict: sess.conflictTargets != null && sess.conflictTargets.some(id => !isIntentCompleted(sess, id))
    }
  }

  /** O03: the withdrawal status fields are a PROJECTION of the current session's facts.
   *  Every writer of these fields goes through here (or through onStoreChange's own
   *  projection) and checks the session identity first — an in-flight answer from a
   *  replaced session must never repaint the live session's withdrawal state. */
  const projectWithdrawal = (sess, wd) => {
    if (session !== sess) return
    status.withdrawPending = wd.pending
    status.withdrawAmbiguous = wd.ambiguous
    status.withdrawSaved = wd.saved
    status.withdrawConflict = wd.conflict
  }

  /* ---------- one shape for every leave outcome (S01/S02) ----------
   * The button's toast and the persistent banner must speak from the same fact, and a result
   * must describe THE session and intent it was made in — never a read of global state after
   * the await, which is how one session's answer repainted another's feedback.
   *   ok / serverConfirmed  what the server did (or did not) confirm
   *   persistence           'storage' (survives a restart) | 'memory' | 'none'
   *   saved                 persistence === 'storage' — the only durable promise made
   *   superseded            a newer decision replaced this one: the UI stays quiet and lets
   *                         the banner, which renders the CURRENT decision, speak instead
   *   target                the account + instance this outcome belongs to
   * `saved` is NEVER assumed from a 200: the success path reports whether the completion
   * record actually reached storage, which is exactly what S03 made load-bearing. */
  const outcome = (sess, { ok, serverConfirmed = false, persistence = 'none', superseded = false, error = null }) => ({
    ok,
    serverConfirmed,
    persistence,
    saved: persistence === 'storage',
    superseded,
    error,
    target: sess ? { uid: sess.uid, instance: sess.instance } : null
  })

  /** The persistence half of a failure, derived from the SAME state the banner renders —
   *  'storage' when the pending decision (or its marks) is durable, 'memory' when the whole
   *  decision lives in this tab, 'none' when nothing is owed any more. */
  const persistenceOf = wd => (wd.saved ? 'storage' : wd.pending ? 'memory' : 'none')

  /** P01/P02: the public-send gate, re-read at EVERY wait resumption of a publish pass. A
   *  withdrawal that began while the pass was paused — its own intent id (made before the
   *  first await, N02), a persisted mark, or an unproven mark demanding the person — closes
   *  the gate for the WHOLE pass: the person's newest decision outranks a publication that
   *  was already on its way. Repaints the withdrawal status so the UI keeps showing it, and
   *  answers whether sending is blocked. The server cannot judge an intent it never
   *  received; once this machine knows a withdrawal is pending, no NEW report may go out. */
  const withdrawBlocked = sess => {
    const wd = withdrawalState(sess)
    projectWithdrawal(sess, wd)
    return wd.pending
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
    // R04: an explicit new decision REPLACES the outstanding one — the replaced intent is
    // completed (its goal is carried by this newer decision), which also resolves any
    // conflict that was about it. What it must NEVER do is touch intents made after the
    // person's view was rendered: those have their own ids.
    if (sess.currentIntentId != null) recordCompletion(sess, sess.currentIntentId)
    sess.conflictTargets = null
    sess.currentIntentId = intentId
    // B02=A: bind the authorization this decision is made against — a leave fired against
    // the CURRENT consentVersion is the person's explicit choice, which is exactly what
    // resolves an authorization conflict.
    sess.currentIntentCv = Number.isFinite(me?.consentVersion) ? me.consentVersion : null
    // B04: record whether the mark really persisted — the UI separates "saved, waiting for
    // the network" from "memory only, a restart would lose it".
    sess.currentIntentPersisted = setMark(key, intentId, sess.currentIntentCv) === true
    const captured = [{ key, raw: rawMark(key) }].filter(c => c.raw !== null)
    status.withdrawPending = true
    status.withdrawConflict = false // a fresh explicit decision speaks for the current authorization
    status.withdrawSaved = sess.currentIntentPersisted
    // Marks of unknown provenance that already sat in storage keep demanding the person
    // (M02) — this new decision for the current instance does not speak for them.
    status.withdrawAmbiguous = historicalKeys(sess).ambiguous.length > 0
    emit()
    try {
      await client.leaveLeaderboard(me)
      const persisted = settleIntents(sess, captured, intentId) // its own marks, its own intent (I05/J04/L02)
      if (session === sess) {
        const wd = withdrawalState(sess)
        projectWithdrawal(sess, wd)
        sess.me = null
        if (!wd.pending) ok()
        else emit()
      }
      // R02/S02: the caller's feedback derives from the SAME facts the banner uses — the
      // server's confirmation AND whether the completion record actually reached storage.
      return outcome(sess, { ok: true, serverConfirmed: true, persistence: persisted ? 'storage' : 'memory' })
    } catch (e) {
      // S02: the failure answer belongs to THIS session and THIS intent. Returning without
      // `saved` made the page read undefined as false and announce "not saved reliably" over
      // a decision that WAS saved. A session replaced mid-flight is superseded: it must not
      // speak for the current one at all.
      if (session !== sess) return outcome(null, { ok: false, superseded: true, error: e })
      fail(e)
      const wd = withdrawalState(sess)
      projectWithdrawal(sess, wd)
      return outcome(sess, {
        ok: false, error: e,
        persistence: persistenceOf(wd),
        // A newer decision made while this request was on the wire carries the goal now.
        superseded: sess.currentIntentId !== intentId
      })
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
    if (!sess) return outcome(null, { ok: false, error: new Error('not signed in') })
    const captured = captureMarks(sess, action === 'discard' ? 'ambiguous' : undefined)
    if (action === 'discard') {
      const persisted = acknowledgeMarks(sess, captured, 'discarded')
      if (session === sess) {
        projectWithdrawal(sess, withdrawalState(sess))
        emit()
      }
      // No server confirmation: the discard is a local attestation about marks this device
      // could not attribute. Its durability is the completion records, nothing else.
      return outcome(sess, { ok: true, persistence: persisted ? 'storage' : 'memory' })
    }
    // S01: the memory decision this resolution acts for. The old failure path read
    // `intentId`, which lives in requestLeave's scope — an offline history confirmation
    // threw ReferenceError instead of answering, and the caller could not retry.
    const intentAtCapture = sess.currentIntentId
    try {
      await client.leaveLeaderboard(me || sess.me)
      // The leave landed for the captured marks' account and instance — they are resolved
      // wherever they are still the marks this resolution captured (I05/J04).
      const persisted = settleIntents(sess, captured, intentAtCapture)
      if (session === sess) {
        const wd = withdrawalState(sess)
        projectWithdrawal(sess, wd)
        sess.me = null
        if (!wd.pending) ok()
        else emit()
      }
      // R02: the caller's feedback derives from the SAME facts the banner uses — the
      // server's confirmation and whether the decision actually persisted locally.
      return outcome(sess, { ok: true, serverConfirmed: true, persistence: persisted ? 'storage' : 'memory' })
    } catch (e) {
      if (session !== sess) return outcome(null, { ok: false, superseded: true, error: e })
      fail(e)
      // R02/S01: an offline failure speaks from THIS session's derived state — never from a
      // variable owned by another function, and never from a fresh global read.
      const wd = withdrawalState(sess)
      projectWithdrawal(sess, wd)
      return outcome(sess, {
        ok: false, error: e,
        persistence: persistenceOf(wd),
        superseded: intentAtCapture != null && sess.currentIntentId !== intentAtCapture
      })
    }
  }

  /** B02=A, the person chose "keep the new join": the newer authorization from the other
   *  device stands, and the OLD leave decision is ended WITHOUT sending anything. Only the
   *  provably-current-instance marks and the current intent are settled — unproven marks
   *  keep demanding their own confirmation (M02) — and the flow re-derives the pending
   *  state, so publishing resumes only when nothing else is owed. */
  /** B02=A, the person chose "keep the new join" — R04: the decision completes ONLY the
   *  intents the displayed conflict was about (its recorded targets, frozen when the
   *  conflict was detected). It never re-captures the current marks: a newer withdrawal
   *  written after the card was shown has its own id, is not among the targets, and
   *  survives. The in-memory slot clears only when the decision it holds is among the
   *  targets. */
  async function resolveWithdrawConflict() {
    const sess = session
    if (!sess) return outcome(null, { ok: false, error: new Error('not signed in') })
    const targets = sess.conflictTargets
    if (targets == null) return { ...outcome(sess, { ok: false }), reason: 'stale-conflict' }
    let persisted = true
    for (const id of targets) {
      if (!recordCompletion(sess, id, 'kept-join')) persisted = false
      if (sess.currentIntentId === id) {
        sess.currentIntentId = null
        sess.currentIntentCv = null
        sess.currentIntentPersisted = false
      }
    }
    if (session === sess) {
      const wd = withdrawalState(sess)
      projectWithdrawal(sess, wd)
      if (!wd.pending) ok() // the kept join is confirmed by nothing owed: publishing resumes
      else emit()
    }
    return outcome(sess, { ok: true, persistence: persisted ? 'storage' : 'memory' })
  }

  /** R01: a member observation is usable for authorization decisions only when it is an
   *  object carrying an explicit boolean `enabled`. A 404 (the feature is off right now)
   *  becomes null; a 401/503/timeout throws; a malformed 200 lacks the field. None of
   *  those may be read as `enabled === false` — that reading deleted withdrawal intents
   *  during a feature-off window and re-published the withdrawn hour when it returned. */
  const isMemberObservation = m => !!m && typeof m === 'object' && typeof m.enabled === 'boolean'

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
        // B02=A: the outstanding leave binds the authorization it was made against. The
        // server showing the member ENABLED with a NEWER consentVersion means another
        // device joined again — firing the old leave against an authorization it never
        // saw would undo the person's newer choice. Stop: keep the intent (still pending,
        // still blocking publishes), surface the conflict, and let the person decide.
        // The outstanding decision's own authorization comes FIRST: a newer in-memory
        // decision (its storage write may have failed, L02) was made against the version
        // the server now shows, and the captured marks of OLDER, already-replaced intents
        // must not resurrect a conflict the person already superseded.
        const intentCv = sess.currentIntentCv ?? captured.map(c => cvOfMark(c.raw)).find(v => v != null)
        if (m?.enabled && (intentCv == null || Number(m.consentVersion) > intentCv)) {
          // R04/R05: freeze what this conflict is ABOUT — the intents captured now (their
          // persisted ids) plus the memory decision that was current. A newer intent that
          // appears later has its own id and is never among the targets.
          const targets = new Set([...captured.map(c => intentIdOf(c.raw)).filter(id => id != null)])
          if (intentAtCapture != null) targets.add(intentAtCapture)
          sess.conflictTargets = [...targets]
          projectWithdrawal(sess, withdrawalState(sess))
          emit()
          return
        }
        // R01: "already out" requires a VALID member observation with an explicit
        // enabled === false. A 404 (the feature is off right now), a null, or a malformed
        // answer says nothing about the stored authorization — treating it as a confirmed
        // exit deleted the withdrawal intent and let the hour re-publish when the feature
        // returned. Unavailable: keep the intent, keep the gate, end the pass quietly.
        if (!isMemberObservation(m)) {
          projectWithdrawal(sess, withdrawalState(sess))
          emit()
          return
        }
        if (m.enabled === false) {
          // Already out server-side: the captured marks' goal is the server's state, not
          // this request — they are completed wherever they are still the captured ones,
          // and so is the memory decision this retry captured (unchanged).
          settleIntents(sess, captured, intentAtCapture)
          sess.me = null // the member's state just changed: never pin the "out" answer
          const wd2 = withdrawalState(sess)
          projectWithdrawal(sess, wd2)
          if (session === sess && !wd2.pending) ok()
          else if (session === sess) emit()
          return
        }
        try {
          await client.leaveLeaderboard(m)
          if (!stillUs()) return
          settleIntents(sess, captured, intentAtCapture)
          const wd2 = withdrawalState(sess)
          projectWithdrawal(sess, wd2)
          sess.me = null
          if (session === sess && !wd2.pending) ok()
          else if (session === sess) emit()
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
      // N02: the person could withdraw while this pass waited for the me answer — a
      // pending withdrawal ends the pass here, before anything is sent.
      if (withdrawBlocked(sess)) return
      // Terminal gates are owed nothing — blocked on a person's decision, not a retry.
      // R01: an unavailable observation (feature off / malformed) is NOT "the member is
      // out" — it stops this pass without touching the withdrawal state either way.
      // The validation comes BEFORE the first field read (round-15 §5): a 404 answers null,
      // and reading `reportRev` off it threw a TypeError that surfaced as a publish error
      // instead of the quiet "feature is off" this branch is supposed to be.
      if (!isMemberObservation(m)) { setPending(false); return }
      sess.lastSeenReportRev = m.reportRev
      if (m.enabled === false || m.suspended) { setPending(false); return }
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
          // N02: a withdrawal landing during the merge stops the public side here — the
          // merge itself was the PERSONAL save and is allowed to complete (C10).
          if (withdrawBlocked(sess)) return
          if (!(stillUs() && after.sync?.status === 'ok' && after.sync?.lastSynced !== syncBefore)) return
          m = await me(sess, true)
          if (!stillUs() || !healthy()) return
          if (withdrawBlocked(sess)) return
          if (m.reportRev === revBefore) merged = true // no new publish during the merge
        }
        if (!merged) {
          sess.lastSeenReportRev = prevSeen // H02: exhaustion keeps the merge obligation
          return // retry on the next change; never send facts older than the baseline
        }
        sess.lastSeenReportRev = m.reportRev
        // I02: no second version field is recorded here — the send below captures facts and
        // rev in one snapshot, so the pairing can never come from a different moment.
        if (!isMemberObservation(m)) { setPending(false); return }
        if (m.enabled === false || m.suspended) { setPending(false); return }
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
        if (withdrawBlocked(sess)) return null // a 409 recovery must not re-send past a new withdrawal (N02)
        const st = get()
        if (st.sync?.status !== 'ok') return 'unconfirmed'
        const fp = st.sync?.confirmedFp   // the store's proof: a JSON string (J02 wiring)
        if (typeof fp === 'string' && JSON.stringify(syncFingerprint(st.S)) !== fp) return 'unconfirmed'
        return { facts: st.S, rev: Number.isFinite(st.sync?.rev) ? st.sync.rev : null }
      }
      // P02: the last gate before the wire — every await this pass crossed has been
      // re-checked, and this is the send's own doorway.
      if (withdrawBlocked(sess)) return
      const snapshot = snapshotOf()
      if (snapshot === null) return
      if (snapshot === 'unconfirmed') { setPending(true); return } // owed to the personal sync first
      const r = await client.publishReport(snapshot, m, {
        // N03: the pull wrapper answers whether the merge actually landed healthy.
        pull: async () => {
          try { await get().pullState() } catch { return false }
          const st = get()
          // N02: a withdrawal landing during the recovery's merge stops the resend.
          if (withdrawBlocked(sess)) return false
          return session === sess && st.sync?.status === 'ok'
        },
        // I02: the retry's facts and rev come from the store together, only while it is
        // still this session (N04: an account switch answers null and the publish stays
        // pending — it is never rebuilt from a stranger's store).
        snapshotOf
      })
      if (!stillUs() || !healthy()) return // the answer belongs to a previous session
      // P04: read the gate once more — a withdrawal that began while the request was on
      // the wire outranks this answer. (A send that left BEFORE the withdrawal may land;
      // the server sorts it against the withdrawal by authorization and transaction order.)
      const blocked = withdrawBlocked(sess)
      if (r.ok) {
        // G02/I02: record the fingerprint of the facts the server ACTUALLY accepted — the
        // 409 recovery may have sent the re-captured snapshot, not the caller's. The answer
        // names it; the fallback is what THIS pass sent (the snapshot), never a response-time
        // re-read of the store — a change landing mid-flight must not count as published.
        sess.lastPublished = r.acceptedFingerprint ?? fingerprintOf(snapshot.facts)
        sess.lastAcceptedReportRev = r.reportRev ?? m.reportRev
        sess.lastSeenReportRev = sess.lastAcceptedReportRev
        if (sess.me) sess.me = { ...sess.me, reportRev: sess.lastSeenReportRev } // the cache must not look stale next round
        if (blocked) { projectWithdrawal(sess, withdrawalState(sess)); emit(); return } // P04
        ok()
      } else if (blocked) {
        emit() // this pass ends quietly: the person's withdrawal keeps the status
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
        currentIntentCv: null,          // the consentVersion that decision was made against (B02)
        currentIntentPersisted: false,  // whether that decision's mark actually reached storage (B04)
        conflictTargets: null,          // R04/R05: the intent ids the displayed conflict is about; the
                                        // conflict clears only when ALL of them are completed
        completed: new Set(),           // intent ids completed in THIS session — the memory half;
                                        // the durable half is read back per intent id (S03)
        lastPublished: ''
      }
      // O03: a NEW session starts with a clean conflict flag and its own facts — nothing
      // of the previous session's withdrawal state survives the identity swap.
      const wd = withdrawalState(session)
      status.withdrawPending = wd.pending
      status.withdrawAmbiguous = wd.ambiguous
      status.withdrawSaved = wd.saved
      status.withdrawConflict = wd.conflict
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

  /* ---------- another tab's completion (S03) ----------
   * The storage event is the only signal a same-origin sibling gives, and it names the key
   * it touched — so the reaction stays scoped to our namespace and never scans storage.
   * A completion written elsewhere makes a mark here no longer outstanding: the projection
   * is re-derived (the banner must stop asking), and a publish that was gated on the
   * withdrawal may now proceed. A mark removed elsewhere re-derives the same way, so the
   * banner never keeps a flag the facts no longer support. */
  const onStorageEvent = e => {
    if (!started || !active || !session) return
    const k = e?.key
    if (typeof k !== 'string' || !k.startsWith('lb-withdraw')) return
    const wd = withdrawalState(session)
    projectWithdrawal(session, wd)
    emit()
    if (!wd.pending) schedule() // the sibling finished it: this tab may publish again
  }

  function start() {
    if (started) return
    started = true
    active = true
    unsub = store.subscribe(onStoreChange)
    onStoreChange() // register the initial session before the first pass
    window.addEventListener('online', onOnline)
    window.addEventListener('storage', onStorageEvent)
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
    window.removeEventListener('storage', onStorageEvent)
    clearTimeout(timer)
    session = null
    started = false
  }

  return {
    start, stop,
    retryNow: runPublish,
    requestLeave,
    resolveAmbiguousWithdraw,
    resolveWithdrawConflict,
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
export const resolveWithdrawConflict = (...a) => singleton?.resolveWithdrawConflict(...a) ?? { ok: false }
export const invalidateMe = () => singleton?.invalidateMe()
