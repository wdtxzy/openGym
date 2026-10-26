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

const ME = { enabled: true, suspended: false, disclosureVersion: 1, currentDisclosureVersion: 1, consentVersion: 1, reportRev: 1, personalRev: 7 }
const facts = id => ({ workouts: [{ id, d: '2026-10-25', start: 100, end: 200 }], activities: [] })

function harness({ server = 'https://alpha.example', lastSynced = 1 } = {}) {
  const state = {
    user: { id: 'a', name: 'A' }, S: facts('A-private'), config: { leaderboard: {} },
    sync: { status: 'ok', server, lastSynced }, pullState: vi.fn(async () => { state.sync = { ...state.sync, lastSynced: state.sync.lastSynced + 1 } })
  }
  const listeners = []
  const store = {
    getState: () => state,
    subscribe: fn => { listeners.push(fn); return () => {} }
  }
  const client = { fetchMe: vi.fn(), leaveLeaderboard: vi.fn(), publishReport: vi.fn() }
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
