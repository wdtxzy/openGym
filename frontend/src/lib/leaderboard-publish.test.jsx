// @vitest-environment happy-dom
// The publish coordinator, round 5: driven through the createPublisher factory (injected
// store/client/clock/storage), the way the app builds its singleton. Pins the round-1..4
// behaviour that still holds (T01 merge gate, R03 session-bound recovery, N03 health gate,
// N08 slow-publish rerun, R10 pending semantics, R11/N09 mark isolation, T05 instance
// isolation) and the round-5 contract (G04 whole-key capture, ambiguous withdrawal resolution,
// G08 stop invalidation).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fingerprintOf } from './leaderboard.js'
import { createPublisher } from './leaderboard-publish.js'
import * as realClient from './leaderboard-client.js'

vi.mock('./api.js', () => ({ api: vi.fn() }))

const ME = { enabled: true, suspended: false, disclosureVersion: 1, currentDisclosureVersion: 1, consentVersion: 1, reportRev: 1, personalRev: 7 }
const facts = id => ({ workouts: [{ id, d: '2026-10-25', start: 100, end: 200 }], activities: [] })

function harness({ server = 'https://alpha.example', lastSynced = 1, client: clientOverride } = {}) {
  const state = {
    user: { id: 'a', name: 'A' }, S: facts('A-private'), config: { leaderboard: {} },
    sync: { status: 'ok', server, lastSynced }, pullState: vi.fn(async () => { state.sync = { ...state.sync, lastSynced: state.sync.lastSynced + 1 } })
  }
  const listeners = []
  const store = {
    getState: () => state,
    subscribe: fn => { listeners.push(fn); return () => {} }
  }
  const client = clientOverride || { fetchMe: vi.fn(), leaveLeaderboard: vi.fn(), publishReport: vi.fn() }
  const clock = vi.fn(() => 1000)
  // The marks live as own enumerable keys on the storage itself, exactly like the
  // browser's localStorage; the factory enumerates Object.keys(storage).
  const storageShim = {
    getItem: k => (k in storageShim ? storageShim[k] : null),
    setItem: (k, v) => { storageShim[k] = String(v) },
    removeItem: k => { delete storageShim[k] }
  }
  const storage = storageShim
  const p = createPublisher({ store, client, clock, storage: storageShim })
  const fire = () => { for (const l of listeners) l() }
  /** The session's own confirmed exchange: lastSynced moves off the boot baseline. */
  const merged = () => { state.sync = { ...state.sync, lastSynced: state.sync.lastSynced + 1 }; fire() }
  return { state, listeners, client, storage, p, fire, merged }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('fingerprintOf — the aggregate inputs, not counts', () => {
  it('an edit to an OLD workout moves it; a same-length activity swap moves it', () => {
    const before = fingerprintOf({ workouts: [{ id: 'a', d: 'x', start: 1, end: 2 }, { id: 'b', d: 'x', start: 3, end: 4 }], activities: [] })
    const editedOld = fingerprintOf({ workouts: [{ id: 'a', d: 'x', start: 1, end: 9 }, { id: 'b', d: 'x', start: 3, end: 4 }], activities: [] })
    expect(editedOld).not.toBe(before)
    const a1 = fingerprintOf({ workouts: [], activities: [{ id: 'x', startMs: 1, endMs: 2 }] })
    const a2 = fingerprintOf({ workouts: [], activities: [{ id: 'y', startMs: 3, endMs: 4 }] })
    expect(a1).not.toBe(a2)
  })
})

describe('the coordinator factory', () => {
  it('T01: publishes only after THIS session merges, with the merged facts', async () => {
    const h = harness()
    h.client.publishReport.mockResolvedValue({ ok: true, reportRev: 2, acceptedFingerprint: 'x' })
    h.client.fetchMe.mockResolvedValue({ ...ME })
    h.p.start()
    await vi.advanceTimersByTimeAsync(10)
    expect(h.client.publishReport).not.toHaveBeenCalled() // no credential yet
    h.state.S = facts('changed-while-unmerged')
    h.fire()
    await vi.advanceTimersByTimeAsync(3000)
    expect(h.client.publishReport).not.toHaveBeenCalled()
    h.merged()
    await vi.advanceTimersByTimeAsync(3000)
    expect(h.client.publishReport).toHaveBeenCalledTimes(1)
    expect(h.client.publishReport.mock.calls[0][0].facts.workouts[0].id).toBe('changed-while-unmerged')
    h.p.stop()
  })

  it('R03: the pull wrapper verifies health and the retry is session-bound', async () => {
    const h = harness()
    h.client.fetchMe.mockResolvedValue({ ...ME })
    h.client.publishReport.mockResolvedValue({ ok: true, reportRev: 2, acceptedFingerprint: 'x' })
    h.p.start()
    h.merged()
    await vi.advanceTimersByTimeAsync(3000)
    expect(h.client.publishReport).toHaveBeenCalledTimes(1)
    const opts = h.client.publishReport.mock.calls[0][2]
    h.state.sync = { ...h.state.sync, status: 'offline' }
    h.state.pullState.mockResolvedValue()
    await expect(opts.pull()).resolves.toBe(false) // merge did not land healthy
    h.state.sync = { ...h.state.sync, status: 'ok' }
    await expect(opts.pull()).resolves.toBe(true)
    expect(opts.snapshotOf().facts).toBe(h.state.S)
    h.state.user = { id: 'b', name: 'B' }
    h.fire() // the session changes on notification, not on mutation
    expect(opts.snapshotOf()).toBe(null)
    h.p.stop()
  })

  it('N03: nothing publishes while personal sync is unhealthy', async () => {
    const h = harness()
    h.client.fetchMe.mockResolvedValue({ ...ME })
    h.client.publishReport.mockResolvedValue({ ok: true })
    h.p.start()
    h.merged()
    await vi.advanceTimersByTimeAsync(3000)
    expect(h.client.publishReport).toHaveBeenCalledTimes(1)
    for (const status of ['offline', 'error', 'held', 'auth', 'pending']) {
      h.client.publishReport.mockClear()
      h.state.sync = { ...h.state.sync, status }
      h.state.S = facts('w-' + status)
      h.fire()
      await vi.advanceTimersByTimeAsync(3000)
      expect(h.client.publishReport).not.toHaveBeenCalled()
    }
    h.state.sync = { ...h.state.sync, status: 'ok' }
    h.fire()
    await vi.advanceTimersByTimeAsync(3000)
    expect(h.client.publishReport).toHaveBeenCalledTimes(1)
    h.p.stop()
  })

  it('N08/G02: a change landing during a slow publish reruns, and lastPublished is the ACCEPTED fingerprint', async () => {
    const h = harness()
    h.client.fetchMe.mockResolvedValue({ ...ME })
    h.p.start()
    h.merged()
    await vi.advanceTimersByTimeAsync(10)
    let resolveFirst
    h.client.publishReport.mockReturnValueOnce(new Promise(r => { resolveFirst = r }))
    h.state.S = facts('OLD')
    h.fire()
    await vi.advanceTimersByTimeAsync(3000)
    expect(h.client.publishReport).toHaveBeenCalledTimes(1)
    h.state.S = facts('NEW')
    h.fire()
    await vi.advanceTimersByTimeAsync(3000)
    expect(h.client.publishReport).toHaveBeenCalledTimes(1)
    // The OLD facts are what the server accepted — that exact fingerprint is recorded (G02),
    // so NEW stays pending and reruns.
    h.client.publishReport.mockClear()
    h.client.publishReport.mockResolvedValue({ ok: true, reportRev: 3, acceptedFingerprint: fingerprintOf(facts('NEW')) })
    resolveFirst({ ok: true, reportRev: 2, acceptedFingerprint: fingerprintOf(facts('OLD')) })
    await vi.advanceTimersByTimeAsync(10)
    expect(h.p.publishStatus().pending).toBe(true)
    await vi.advanceTimersByTimeAsync(3000)
    expect(h.client.publishReport).toHaveBeenCalledTimes(1)
    expect(h.client.publishReport.mock.calls[0][0].facts.workouts[0].id).toBe('NEW')
    expect(h.p.publishStatus().pending).toBe(false)
    h.p.stop()
  })

  it('R10: a failed publish stays pending with the error', async () => {
    const h = harness()
    h.client.fetchMe.mockResolvedValue({ ...ME })
    h.p.start()
    h.merged()
    await vi.advanceTimersByTimeAsync(10)
    h.client.publishReport.mockResolvedValue({ ok: false, error: new Error('offline') })
    h.fire()
    await vi.advanceTimersByTimeAsync(3000)
    expect(h.p.publishStatus().pending).toBe(true)
    expect(h.p.publishStatus().lastError).toBe('offline')
    h.p.stop()
  })

  it('T05/G04: a mark made on alpha never replays against beta; v2 URL keys are recognized whole', async () => {
    const h = harness({ server: 'https://alpha.example' })
    h.client.leaveLeaderboard.mockRejectedValue(new Error('offline'))
    h.p.start()
    await h.p.requestLeave({ ...ME })
    expect(JSON.parse(h.storage['lb-withdraw:https://alpha.example:a']).i).toBeTypeOf('string')
    expect(h.client.leaveLeaderboard).toHaveBeenCalledTimes(1)
    // Switch the same uid to beta: no leave replay, the alpha mark survives.
    h.state.sync = { status: 'ok', server: 'https://beta.example', lastSynced: 1 }
    h.fire()
    h.p.retryNow()
    await vi.advanceTimersByTimeAsync(10)
    expect(h.client.leaveLeaderboard).toHaveBeenCalledTimes(1)
    expect(JSON.parse(h.storage['lb-withdraw:https://alpha.example:a']).i).toBeTypeOf('string')
    // A v2 key with a REAL URL (colons galore) on this device's own origin counts as here.
    // beta is not the WebView origin here, so a v2 key for another origin stays ambiguous.
    h.storage['lb-withdraw:https://paired-elsewhere.example:3000:a'] = '1'
    h.p.retryNow()
    await vi.advanceTimersByTimeAsync(10)
    expect(h.client.publishReport).not.toHaveBeenCalled() // ambiguous blocks publishing
    expect(h.p.publishStatus().withdrawAmbiguous).toBe(true)
    h.p.stop()
  })

  it('G04: confirm/discard acts on exactly the captured keys', async () => {
    const h = harness()
    h.storage['lb-withdraw:https://some-old-origin.example:a'] = '1' // v2, five colon segments
    h.storage['lb-withdraw:a'] = '1' // v1
    h.p.start()
    await vi.advanceTimersByTimeAsync(10)
    expect(h.p.publishStatus().withdrawAmbiguous).toBe(true)
    expect(h.client.publishReport).not.toHaveBeenCalled()
    // Discard removes precisely the two captured historical keys.
    await h.p.resolveAmbiguousWithdraw('discard')
    expect('lb-withdraw:https://some-old-origin.example:a' in h.storage).toBe(false)
    expect('lb-withdraw:a' in h.storage).toBe(false)
    expect(h.p.publishStatus().withdrawAmbiguous).toBe(false)
    h.p.stop()
  })

  it('G04: confirm-leave clears the captured keys after the leave lands', async () => {
    const h = harness()
    h.storage['lb-withdraw:a'] = '1'
    h.client.fetchMe.mockResolvedValue({ ...ME })
    h.client.leaveLeaderboard.mockResolvedValue({})
    h.p.start()
    await vi.advanceTimersByTimeAsync(10)
    await h.p.resolveAmbiguousWithdraw('leave')
    expect(h.client.leaveLeaderboard).toHaveBeenCalledTimes(1)
    expect('lb-withdraw:a' in h.storage).toBe(false)
    h.p.stop()
  })

  it('R11/N09: a late leave success clears only its own mark', async () => {
    const h = harness()
    let resolveLeave
    h.client.leaveLeaderboard.mockReturnValueOnce(new Promise(r => { resolveLeave = r }))
    h.p.start()
    const pending = h.p.requestLeave({ ...ME })
    expect(JSON.parse(h.storage['lb-withdraw:https://alpha.example:a']).i).toBeTypeOf('string')
    h.merged()
    await vi.advanceTimersByTimeAsync(3000)
    expect(h.client.publishReport).not.toHaveBeenCalled() // withdrawal blocks publishing
    // Switch to b, who has a withdrawal of their own.
    h.state.user = { id: 'b', name: 'B' }
    h.storage['lb-withdraw:https://alpha.example:b'] = JSON.stringify({v:3,i:'b-intent'})
    h.fire()
    resolveLeave({})
    await pending
    expect('lb-withdraw:https://alpha.example:a' in h.storage).toBe(false)
    expect(JSON.parse(h.storage['lb-withdraw:https://alpha.example:b']).i).toBe('b-intent') // untouched
    h.p.stop()
  })

  it('G08: stop invalidates in-flight work — a late me answer publishes nothing', async () => {
    const h = harness()
    let resolveMe
    h.client.fetchMe.mockReturnValueOnce(new Promise(r => { resolveMe = r }))
    h.p.start()
    h.merged()
    await vi.advanceTimersByTimeAsync(10)
    h.p.stop()
    resolveMe({ ...ME })
    await vi.advanceTimersByTimeAsync(3000)
    expect(h.client.publishReport).not.toHaveBeenCalled()
  })
})

describe('J04 — an offline withdrawal finishes after automatic recovery', () => {
  const ME0 = { enabled: true, suspended: false, disclosureVersion: 1, currentDisclosureVersion: 1, consentVersion: 1, reportRev: 0 }

  function withdrawFixture() {
    const h = harness()
    h.p.start()
    h.client.fetchMe.mockResolvedValue({ ...ME0 })
    return h
  }

  it.each([[true, 'the leave request succeeds'], [false, 'the server already shows the member out']])('me.enabled=%s — %s', async enabled => {
    const h = withdrawFixture()
    h.client.leaveLeaderboard.mockRejectedValueOnce(new Error('initial offline'))
    if (enabled) h.client.leaveLeaderboard.mockResolvedValue({})
    await h.p.requestLeave({ ...ME0 })
    expect(Object.keys(h.storage).filter(k => k.startsWith('lb-withdraw:'))).toHaveLength(1)
    expect(h.p.publishStatus().withdrawPending).toBe(true)

    // Back online: the automatic pass settles the intent — no keys, no pending, no stale error.
    h.client.fetchMe.mockResolvedValue({ ...ME0, enabled })
    await h.p.retryNow()
    await vi.advanceTimersByTimeAsync(1)

    expect(Object.keys(h.storage).filter(k => k.startsWith('lb-withdraw:'))).toHaveLength(0)
    expect(h.p.publishStatus().withdrawPending).toBe(false)
    expect(h.p.publishStatus().lastError).toBe(null)
    expect(h.p.publishStatus().lastOkAt).not.toBe(null)
    // After the withdrawal the member is out — and a REJOIN in the same session publishes
    // again (the stuck intent never returns to undo it): the me cache reads enabled, a
    // confirmed exchange of its own, then a changed fact.
    h.client.fetchMe.mockResolvedValue({ ...ME0, enabled: true, reportRev: 0 })
    h.client.publishReport.mockResolvedValue({ ok: true, reportRev: 1, acceptedFingerprint: 'x' })
    h.merged()
    h.state.S = facts('after-withdrawal')
    h.fire()
    await vi.advanceTimersByTimeAsync(3000)
    expect(h.client.publishReport).toHaveBeenCalled()
    expect(h.p.publishStatus().withdrawPending).toBe(false)
  })

  it('a newer intent made while the automatic retry is in flight still survives (I05 kept)', async () => {
    const h = withdrawFixture()
    let done
    h.client.leaveLeaderboard
      .mockRejectedValueOnce(new Error('offline intent A'))
      .mockImplementationOnce(() => new Promise(resolve => { done = resolve }))
      .mockRejectedValueOnce(new Error('offline intent B'))
    await h.p.requestLeave({ ...ME0 })            // intent A, persisted, fails offline
    const retry = h.p.retryNow()
    await vi.advanceTimersByTimeAsync(1)
    await h.p.requestLeave({ ...ME0, consentVersion: 3 }) // intent B replaces the mark
    const key = 'lb-withdraw:https://alpha.example:a'
    const newRaw = h.storage[key]
    done({})                                       // intent A's late success lands
    await retry
    expect(h.storage[key]).toBe(newRaw)            // B's mark untouched
    expect(h.p.publishStatus().withdrawPending).toBe(true)
  })
})

describe('K03 — replacing a failed intent and completing the new one leaves no phantom intent', () => {
  const ME0 = { enabled: true, suspended: false, disclosureVersion: 1, currentDisclosureVersion: 1, consentVersion: 1, reportRev: 0 }

  function withdrawFixture() {
    const h = harness()
    h.p.start()
    h.client.fetchMe.mockResolvedValue({ ...ME0 })
    return h
  }

  it.each([[false, 'the replacement succeeds directly'], [true, 'the replacement fails, then the automatic retry succeeds']])('automatic=%s — %s', async automatic => {
    const h = withdrawFixture()
    // Intent A: persisted, request fails offline.
    h.client.leaveLeaderboard.mockRejectedValueOnce(new Error('A offline'))
    await h.p.requestLeave({ ...ME0 })
    expect(h.p.publishStatus().withdrawPending).toBe(true)
    if (automatic) h.client.leaveLeaderboard.mockRejectedValueOnce(new Error('B offline'))
    h.client.leaveLeaderboard.mockResolvedValue({})
    // Intent B replaces the mark for the same account/instance — A is superseded, not
    // accumulated: the old code read the "previous" id from the mark AFTER overwriting
    // it, so A's id survived as a phantom and no completion could ever clear pending.
    await h.p.requestLeave({ ...ME0 })
    if (automatic) {
      await h.p.retryNow()
      await vi.advanceTimersByTimeAsync(1)
    }
    const key = 'lb-withdraw:https://alpha.example:a'
    expect(key in h.storage).toBe(false)            // the persisted mark settled
    expect(h.p.publishStatus().withdrawPending).toBe(false) // and so did the in-memory intents
    expect(h.p.publishStatus().lastError).toBe(null)
    expect(h.p.publishStatus().lastOkAt).not.toBe(null)
    // A triple replacement chain settles the same way.
    h.client.leaveLeaderboard.mockReset()
    h.client.leaveLeaderboard.mockRejectedValueOnce(new Error('C offline'))
    h.client.leaveLeaderboard.mockRejectedValueOnce(new Error('D offline'))
    h.client.leaveLeaderboard.mockResolvedValue({})
    await h.p.requestLeave({ ...ME0 }) // C, fails
    await h.p.requestLeave({ ...ME0 }) // D replaces C, fails
    await h.p.requestLeave({ ...ME0 }) // E replaces D, succeeds
    expect('lb-withdraw:https://alpha.example:a' in h.storage).toBe(false)
    expect(h.p.publishStatus().withdrawPending).toBe(false)
  })
})

describe('L02 — a memory-only intent (its storage write failed) survives an older success', () => {
  const ME0 = { enabled: true, suspended: false, disclosureVersion: 1, currentDisclosureVersion: 1, consentVersion: 1, reportRev: 0 }

  function withdrawFixture() {
    const h = harness()
    h.p.start()
    h.client.fetchMe.mockResolvedValue({ ...ME0 })
    h.client.publishReport.mockResolvedValue({ ok: true, reportRev: 1, acceptedFingerprint: 'x' })
    return h
  }
  const failStorage = h => {
    const real = h.storage.setItem
    let fail = false
    h.storage.setItem = (k, v) => { if (fail) throw new Error('quota'); real(k, v) }
    return on => { fail = on }
  }

  it('an old success cannot sweep away a newer intent whose storage write failed — publishing stays blocked', async () => {
    const h = withdrawFixture()
    const setFailing = failStorage(h)
    let resolveA
    // Intent A: persisted fine, its response hangs (it may already have executed server-side).
    h.client.leaveLeaderboard.mockImplementationOnce(() => new Promise(resolve => { resolveA = resolve }))
    // Intent B: a newer decision (consent 3) — its storage write will fail, so it lives
    // in memory only, and its own request fails offline.
    h.client.leaveLeaderboard.mockRejectedValueOnce(new Error('new consent-3 leave offline'))
    const old = h.p.requestLeave({ ...ME0 })
    setFailing(true)
    await h.p.requestLeave({ ...ME0, consentVersion: 3 })
    expect(h.p.publishStatus().withdrawPending).toBe(true) // B is the current decision

    resolveA({})
    await old
    // A's success settles A — never B: no persisted record names B, but B is the KNOWN
    // newer decision of this session, and only its own confirmation (or an explicit
    // replacement) may end it.
    expect(h.p.publishStatus().withdrawPending).toBe(true)
    expect(h.p.publishStatus().lastError).toBe('new consent-3 leave offline')

    // A confirmed personal exchange and a fresh pass: the unfinished withdrawal must
    // still block publishing — publishReport is never called while B is pending.
    h.client.leaveLeaderboard.mockRejectedValueOnce(new Error('still offline'))
    h.merged()
    await h.p.retryNow()
    await vi.advanceTimersByTimeAsync(1)
    expect(h.client.publishReport).not.toHaveBeenCalled()
    expect(h.p.publishStatus().withdrawPending).toBe(true)
  })

  it('the memory-only intent completes when ITS OWN confirmation finally lands (no storage needed)', async () => {
    const h = withdrawFixture()
    const setFailing = failStorage(h)
    let resolveA
    h.client.leaveLeaderboard.mockImplementationOnce(() => new Promise(resolve => { resolveA = resolve }))
    h.client.leaveLeaderboard.mockRejectedValueOnce(new Error('new consent-3 leave offline'))
    const old = h.p.requestLeave({ ...ME0 })
    setFailing(true)
    await h.p.requestLeave({ ...ME0, consentVersion: 3 })
    resolveA({})
    await old
    expect(h.p.publishStatus().withdrawPending).toBe(true)
    // The automatic retry, acting for the memory decision that was current when it
    // began, confirms the leave — and ends it without any persisted mark.
    h.client.leaveLeaderboard.mockResolvedValue({})
    h.merged()
    await h.p.retryNow()
    await vi.advanceTimersByTimeAsync(1)
    expect(h.p.publishStatus().withdrawPending).toBe(false)
    expect(h.p.publishStatus().lastError).toBe(null)
    expect(h.p.publishStatus().lastOkAt).not.toBe(null)
    expect(h.client.publishReport).not.toHaveBeenCalled() // the withdrawal branch, not a publish
  })

  it('repeated failed storage writes do not re-accumulate ghost intents (K03 kept)', async () => {
    const h = withdrawFixture()
    const setFailing = failStorage(h)
    setFailing(true)
    h.client.leaveLeaderboard.mockRejectedValue(new Error('offline'))
    await h.p.requestLeave({ ...ME0 })
    await h.p.requestLeave({ ...ME0, consentVersion: 2 })
    await h.p.requestLeave({ ...ME0, consentVersion: 3 })
    expect(h.p.publishStatus().withdrawPending).toBe(true) // exactly one current decision
    // Storage heals and the current decision's request succeeds: everything completes,
    // nothing lingers — the old Set-based model would have left the first two ids.
    setFailing(false)
    h.client.leaveLeaderboard.mockResolvedValue({})
    await h.p.requestLeave({ ...ME0, consentVersion: 4 })
    expect(h.p.publishStatus().withdrawPending).toBe(false)
    expect(Object.keys(h.storage).filter(k => k.startsWith('lb-withdraw:'))).toHaveLength(0)
  })
})

describe('M02 — provenance-scoped withdrawal resolution', () => {
  // A v2 mark for a server this device does not serve (the harness origin is not this URL)
  // is unprovable; the v3 mark for the connected instance is provably here.
  const UNKNOWN = 'lb-withdraw:https://older-server.example:a'
  const HERE = 'lb-withdraw:https://alpha.example:a'

  it('the automatic flow never touches an unproven mark beside a provable one', async () => {
    const h = harness()
    h.storage[UNKNOWN] = JSON.stringify({ v: 2, i: 'older-intent' })
    h.storage[HERE] = JSON.stringify({ v: 3, i: 'here-intent', cv: 1 })
    h.client.fetchMe.mockResolvedValue({ ...ME })
    h.client.leaveLeaderboard.mockResolvedValue({})
    h.p.start()
    await vi.advanceTimersByTimeAsync(10)
    h.p.retryNow()
    await vi.advanceTimersByTimeAsync(10)
    // The mixed state is the person's to resolve (F06): no automatic leave, no publish,
    // and BOTH marks exactly as they were.
    expect(h.client.leaveLeaderboard).not.toHaveBeenCalled()
    expect(h.client.publishReport).not.toHaveBeenCalled()
    expect(JSON.parse(h.storage[UNKNOWN]).i).toBe('older-intent')
    expect(JSON.parse(h.storage[HERE]).i).toBe('here-intent')
    expect(h.p.publishStatus().withdrawPending).toBe(true)
    expect(h.p.publishStatus().withdrawAmbiguous).toBe(true)
    h.p.stop()
  })

  it('a discard attests only the unproven marks; the provable part then auto-completes', async () => {
    const h = harness()
    h.storage[UNKNOWN] = JSON.stringify({ v: 2, i: 'older-intent' })
    h.storage[HERE] = JSON.stringify({ v: 3, i: 'here-intent', cv: 1 })
    h.client.fetchMe.mockResolvedValue({ ...ME })
    h.client.leaveLeaderboard.mockResolvedValue({})
    h.p.start()
    await vi.advanceTimersByTimeAsync(10)
    await h.p.resolveAmbiguousWithdraw('discard')
    // The person said the unproven intents are not ours: they go — and ONLY them.
    expect(UNKNOWN in h.storage).toBe(false)
    expect(JSON.parse(h.storage[HERE]).i).toBe('here-intent') // still this instance's decision
    expect(h.p.publishStatus().withdrawPending).toBe(true)
    // With the unknown side decided, the automatic flow may finish the provable one.
    h.p.retryNow()
    await vi.advanceTimersByTimeAsync(10)
    expect(h.client.leaveLeaderboard).toHaveBeenCalledTimes(1)
    expect(HERE in h.storage).toBe(false)
    expect(h.p.publishStatus().withdrawPending).toBe(false)
    h.p.stop()
  })

  it('a confirm attests everything captured belongs here: its leave settles all of it', async () => {
    const h = harness()
    h.storage[UNKNOWN] = JSON.stringify({ v: 1, i: 'legacy-intent' }) // v1: no instance proof
    h.storage[HERE] = JSON.stringify({ v: 3, i: 'here-intent', cv: 1 })
    h.client.fetchMe.mockResolvedValue({ ...ME })
    h.client.leaveLeaderboard.mockResolvedValue({})
    h.p.start()
    await vi.advanceTimersByTimeAsync(10)
    await h.p.resolveAmbiguousWithdraw('leave')
    expect(h.client.leaveLeaderboard).toHaveBeenCalledTimes(1)
    expect(UNKNOWN in h.storage).toBe(false)
    expect(HERE in h.storage).toBe(false)
    expect(h.p.publishStatus().withdrawPending).toBe(false)
    h.p.stop()
  })

  it('a leave response settles only the provable marks it captured — an unproven mark written mid-flight survives', async () => {
    const h = harness()
    h.storage[HERE] = JSON.stringify({ v: 3, i: 'here-intent', cv: 1 })
    h.client.fetchMe.mockResolvedValue({ ...ME })
    let resolveLeave
    h.client.leaveLeaderboard.mockImplementationOnce(() => new Promise(r => { resolveLeave = r }))
    h.p.start()
    const leaving = h.p.requestLeave({ ...ME })
    // While the request is in flight, an unproven mark appears (another device's record
    // synced into this storage).
    h.storage[UNKNOWN] = JSON.stringify({ v: 1, i: 'late-legacy' })
    resolveLeave({})
    await leaving
    // The response speaks for the current instance only: the unproven mark is untouched
    // and still demands the person.
    expect(UNKNOWN in h.storage).toBe(true)
    expect(HERE in h.storage).toBe(false)
    expect(h.p.publishStatus().withdrawPending).toBe(true)
    expect(h.p.publishStatus().withdrawAmbiguous).toBe(true)
    expect(h.client.publishReport).not.toHaveBeenCalled()
    h.p.stop()
  })

  it('multiple unproven formats (v1 and foreign-origin v2) are discarded together, the provable mark stays', async () => {
    const h = harness()
    h.storage['lb-withdraw:a'] = '1'                                             // v1: no proof
    h.storage['lb-withdraw:https://paired-elsewhere.example:3000:a'] = '1'       // v2, foreign origin
    h.storage[HERE] = JSON.stringify({ v: 3, i: 'here-intent', cv: 1 })
    h.client.fetchMe.mockResolvedValue({ ...ME })
    h.client.leaveLeaderboard.mockResolvedValue({})
    h.p.start()
    await vi.advanceTimersByTimeAsync(10)
    expect(h.p.publishStatus().withdrawAmbiguous).toBe(true)
    await h.p.resolveAmbiguousWithdraw('discard')
    expect('lb-withdraw:a' in h.storage).toBe(false)
    expect('lb-withdraw:https://paired-elsewhere.example:3000:a' in h.storage).toBe(false)
    expect(JSON.parse(h.storage[HERE]).i).toBe('here-intent')
    h.p.stop()
  })
})

describe('N02 — a withdrawal that lands mid-publish stops every new send', () => {
  it('P01: a withdrawal during the first me blocks the publish — the server answer does not outrank it', async () => {
    const h = harness()
    h.client.publishReport.mockResolvedValue({ ok: true, reportRev: 2, acceptedFingerprint: 'x' })
    let resolveMe
    h.client.fetchMe.mockImplementationOnce(() => new Promise(r => { resolveMe = r }))
    h.p.start()
    h.merged()
    await vi.advanceTimersByTimeAsync(3000) // the pass is now parked on the me fetch
    // The person withdraws; the request never reaches the server (offline).
    h.client.leaveLeaderboard.mockRejectedValueOnce(new Error('leave offline'))
    await h.p.requestLeave({ ...ME })
    expect(h.p.publishStatus().withdrawPending).toBe(true)
    // The me answer finally lands: the server still has the member enabled — but the local
    // decision is newer than that answer, and it closes the gate.
    resolveMe({ ...ME })
    await vi.advanceTimersByTimeAsync(1)
    expect(h.client.publishReport).not.toHaveBeenCalled()
    const st = h.p.publishStatus()
    expect(st.withdrawPending).toBe(true)
    expect(st.lastError).toBe('leave offline') // the withdrawal's error was not wiped (P04)
    // And the gate stays closed on later passes while the withdrawal is pending.
    h.client.fetchMe.mockResolvedValue({ ...ME })
    h.merged()
    await vi.advanceTimersByTimeAsync(3000)
    expect(h.client.publishReport).not.toHaveBeenCalled()
    h.p.stop()
  })

  it('P02: a withdrawal during the merge-stabilization me stops the send; the personal merge still completed', async () => {
    const h = harness()
    h.client.publishReport.mockResolvedValue({ ok: true, reportRev: 2, acceptedFingerprint: 'x' })
    // First sighting: a reportRev this session never saw — the merge loop runs, and its
    // fresh me fetch is where this pass parks.
    h.client.fetchMe.mockResolvedValueOnce({ ...ME, reportRev: 5 })
    let resolveFresh
    h.client.fetchMe.mockImplementationOnce(() => new Promise(r => { resolveFresh = r }))
    h.p.start()
    h.merged()
    await vi.advanceTimersByTimeAsync(3000)
    h.client.leaveLeaderboard.mockRejectedValueOnce(new Error('leave offline'))
    await h.p.requestLeave({ ...ME })
    resolveFresh({ ...ME, reportRev: 5 }) // the server still says enabled
    await vi.advanceTimersByTimeAsync(1)
    expect(h.client.publishReport).not.toHaveBeenCalled()
    expect(h.p.publishStatus().withdrawPending).toBe(true)
    expect(h.p.publishStatus().lastError).toBe('leave offline')
    h.p.stop()
  })

  it('P02: a withdrawal during the 409 recovery blocks the resend (the real client, real recovery)', async () => {
    const api = vi.mocked((await import('./api.js')).api)
    let sends = 0
    api.mockImplementation(async (url, opts) => {
      if (url.endsWith('/me')) return { ...ME }
      if (url.endsWith('/report')) {
        sends++
        if (sends === 1) throw Object.assign(new Error('stale'), { status: 409, data: { error: 'report-stale' } })
        return { ok: true, reportRev: 2 }
      }
      if (url.endsWith('/consent')) throw new Error('leave offline') // the withdrawal fails offline
      throw new Error('unexpected ' + url)
    })
    const h = harness({ client: realClient })
    let resolvePull
    h.state.pullState = vi.fn()
      .mockImplementationOnce(async () => { h.state.sync = { ...h.state.sync, lastSynced: h.state.sync.lastSynced + 1 } }) // the merge loop's pull
      .mockImplementationOnce(() => new Promise(r => { resolvePull = r })) // the recovery's pull parks here
    h.p.start()
    h.merged()
    await vi.advanceTimersByTimeAsync(3000) // the send 409s; the recovery parks on its pull
    expect(sends).toBe(1)
    await h.p.requestLeave({ ...ME })
    resolvePull()
    await vi.advanceTimersByTimeAsync(1)
    expect(sends).toBe(1) // N02: the recovery never re-sent past the withdrawal
    expect(h.p.publishStatus().withdrawPending).toBe(true)
    expect(h.p.publishStatus().lastError).toBe('leave offline')
    h.p.stop()
  })

  it('P04: a report accepted after a withdrawal began records the facts but never repaints the withdrawal', async () => {
    const h = harness()
    let resolveSend
    h.client.publishReport.mockImplementationOnce(() => new Promise(r => { resolveSend = r }))
    h.client.fetchMe.mockResolvedValue({ ...ME })
    h.p.start()
    h.merged()
    await vi.advanceTimersByTimeAsync(3000) // the send is on the wire
    // The withdrawal begins while the request is in flight; its own request fails offline.
    h.client.leaveLeaderboard.mockRejectedValueOnce(new Error('leave offline'))
    await h.p.requestLeave({ ...ME })
    // The pre-withdrawal send is then accepted (the server sorts it against the withdrawal).
    resolveSend({ ok: true, reportRev: 2, acceptedFingerprint: 'x' })
    await vi.advanceTimersByTimeAsync(1)
    const st = h.p.publishStatus()
    expect(st.withdrawPending).toBe(true) // the withdrawal state survived the success
    expect(st.lastError).toBe('leave offline') // and its error message with it
    h.p.stop()
  })
})

describe('B02/P09 — an old leave intent meets a newer authorization: the person decides', () => {
  const HERE = 'lb-withdraw:https://alpha.example:a'

  function conflictFixture() {
    const h = harness()
    h.storage[HERE] = JSON.stringify({ v: 3, i: 'old-intent', cv: 1 }) // made against consent v1
    h.client.leaveLeaderboard.mockRejectedValue(new Error('leave offline'))
    // The server now shows the member ENABLED on consent v2 — another device joined again.
    h.client.fetchMe.mockResolvedValue({ ...ME, consentVersion: 2 })
    h.p.start()
    return h
  }

  it('the automatic retry stops at the conflict: no leave, no publish, the intent stays pending', async () => {
    const h = conflictFixture()
    await vi.advanceTimersByTimeAsync(10)
    h.p.retryNow()
    await vi.advanceTimersByTimeAsync(10)
    expect(h.client.leaveLeaderboard).not.toHaveBeenCalled() // the old leave never fires against v2
    expect(h.client.publishReport).not.toHaveBeenCalled()
    const st = h.p.publishStatus()
    expect(st.withdrawPending).toBe(true)
    expect(st.withdrawConflict).toBe(true)
    expect(JSON.parse(h.storage[HERE]).i).toBe('old-intent') // untouched: the person decides
    h.p.stop()
  })

  it('"still leave" makes a NEW decision against the current authorization and completes', async () => {
    const h = conflictFixture()
    await vi.advanceTimersByTimeAsync(10)
    h.p.retryNow()
    await vi.advanceTimersByTimeAsync(10)
    expect(h.p.publishStatus().withdrawConflict).toBe(true)
    // The person confirms leaving under the CURRENT version: a fresh intent, bound to v2.
    h.client.leaveLeaderboard.mockResolvedValueOnce({})
    await h.p.requestLeave({ ...ME, consentVersion: 2 })
    expect(h.client.leaveLeaderboard).toHaveBeenCalledTimes(1)
    const st = h.p.publishStatus()
    expect(st.withdrawPending).toBe(false)
    expect(st.withdrawConflict).toBe(false)
    expect(HERE in h.storage).toBe(false)
    h.p.stop()
  })

  it('"keep the new join" ends the old decision without sending anything', async () => {
    const h = conflictFixture()
    await vi.advanceTimersByTimeAsync(10)
    h.p.retryNow()
    await vi.advanceTimersByTimeAsync(10)
    expect(h.p.publishStatus().withdrawConflict).toBe(true)
    await h.p.resolveWithdrawConflict()
    expect(h.client.leaveLeaderboard).not.toHaveBeenCalled() // nothing was sent: the join stands
    const st = h.p.publishStatus()
    expect(st.withdrawPending).toBe(false)
    expect(st.withdrawConflict).toBe(false)
    expect(HERE in h.storage).toBe(false)
    h.p.stop()
  })

  it('"keep the new join" leaves unproven marks alone — they still demand their own confirmation', async () => {
    const h = conflictFixture()
    const UNKNOWN = 'lb-withdraw:https://older-server.example:a'
    h.storage[UNKNOWN] = JSON.stringify({ v: 2, i: 'older-intent' })
    await vi.advanceTimersByTimeAsync(10)
    h.p.retryNow()
    await vi.advanceTimersByTimeAsync(10)
    await h.p.resolveWithdrawConflict()
    const st = h.p.publishStatus()
    expect(st.withdrawPending).toBe(true) // the unproven mark still waits for the person (M02)
    expect(st.withdrawAmbiguous).toBe(true)
    expect(JSON.parse(h.storage[UNKNOWN]).i).toBe('older-intent')
    expect(HERE in h.storage).toBe(false)
    h.p.stop()
  })
})

describe('O03 — the withdrawal conflict state belongs to the session', () => {
  const HERE = 'lb-withdraw:https://alpha.example:a'

  function conflictedSession() {
    const h = harness()
    h.storage[HERE] = JSON.stringify({ v: 3, i: 'old-intent', cv: 1 })
    h.client.leaveLeaderboard.mockRejectedValue(new Error('leave offline'))
    h.client.fetchMe.mockResolvedValue({ ...ME, consentVersion: 2 }) // a newer join elsewhere
    h.p.start()
    return h
  }

  it('a conflict on A does not follow the account to B', async () => {
    const h = conflictedSession()
    await vi.advanceTimersByTimeAsync(10)
    h.p.retryNow()
    await vi.advanceTimersByTimeAsync(10)
    expect(h.p.publishStatus().withdrawConflict).toBe(true)
    // Switch to a different account on the same instance: B has no withdrawal at all.
    h.state.user = { id: 'b' }
    delete h.storage[HERE]
    h.fire()
    await vi.advanceTimersByTimeAsync(10)
    const st = h.p.publishStatus()
    expect(st.withdrawConflict).toBe(false) // O03: the flag died with A's session
    expect(st.withdrawPending).toBe(false)
    h.p.stop()
  })

  it('a late success from A does not clear B\u2019s own conflict', async () => {
    const h = conflictedSession()
    // A's own leave request is still in flight when the account switches to B.
    let resolveA
    h.client.leaveLeaderboard.mockImplementationOnce(() => new Promise(r => { resolveA = r }))
    const leaving = h.p.requestLeave({ ...ME }) // A's direct leave, against consent v1... the fixture's newer join makes it conflict later
    h.state.user = { id: 'b' }
    delete h.storage[HERE]
    h.storage['lb-withdraw:https://alpha.example:b'] = JSON.stringify({ v: 3, i: 'b-intent', cv: 1 })
    h.fire()
    await vi.advanceTimersByTimeAsync(10)
    h.p.retryNow()
    await vi.advanceTimersByTimeAsync(10)
    expect(h.p.publishStatus().withdrawConflict).toBe(true) // B's own conflict (cv1 intent, cv2 server)
    resolveA({}) // A's leave finally succeeds
    await leaving
    await vi.advanceTimersByTimeAsync(10)
    expect(h.p.publishStatus().withdrawConflict).toBe(true) // O03: A's answer never painted B
    expect(h.p.publishStatus().withdrawPending).toBe(true) // B's intent still waits
    expect(h.client.publishReport).not.toHaveBeenCalled()
    h.p.stop()
  })

  it('signing out clears the projected conflict state', async () => {
    const h = conflictedSession()
    await vi.advanceTimersByTimeAsync(10)
    h.p.retryNow()
    await vi.advanceTimersByTimeAsync(10)
    expect(h.p.publishStatus().withdrawConflict).toBe(true)
    h.state.user = null
    h.fire()
    await vi.advanceTimersByTimeAsync(10)
    expect(h.p.publishStatus().withdrawConflict).toBe(false)
    h.p.stop()
  })
})

describe('O02 — B04: a memory-only withdrawal is never promised as saved', () => {
  const ME0 = { enabled: true, suspended: false, disclosureVersion: 1, currentDisclosureVersion: 1, consentVersion: 1, reportRev: 0 }

  it('a storage failure flags the intent as not saved; the gate and the retry still hold', async () => {
    const h = harness()
    let full = false
    const realSet = h.storage.setItem
    h.storage.setItem = (k, v) => { if (full) throw new Error('quota'); realSet(k, v) }
    h.client.fetchMe.mockResolvedValue({ ...ME0 })
    h.client.leaveLeaderboard.mockRejectedValue(new Error('offline'))
    h.p.start()
    full = true
    await h.p.requestLeave({ ...ME0 })
    const st = h.p.publishStatus()
    expect(st.withdrawPending).toBe(true)
    expect(st.withdrawSaved).toBe(false) // B04: the UI must warn, never promise "Saved"
    // The memory-only decision still blocks publishing (L02) — the risk is contained.
    h.merged()
    await vi.advanceTimersByTimeAsync(3000)
    expect(h.client.publishReport).not.toHaveBeenCalled()
    expect(h.p.publishStatus().withdrawSaved).toBe(false)
    h.p.stop()
  })

  it('a persisted intent is flagged saved — the ordinary offline path keeps its promise', async () => {
    const h = harness()
    h.client.fetchMe.mockResolvedValue({ ...ME0 })
    h.client.leaveLeaderboard.mockRejectedValue(new Error('offline'))
    h.p.start()
    await h.p.requestLeave({ ...ME0 })
    const st = h.p.publishStatus()
    expect(st.withdrawPending).toBe(true)
    expect(st.withdrawSaved).toBe(true) // the mark is on disk: "saved, waiting for the network"
    h.p.stop()
  })
})
