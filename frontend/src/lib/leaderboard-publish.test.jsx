// @vitest-environment happy-dom
// The global publish coordinator, round 2: R03/R05/R10/R11/R12 from the first review plus the
// second round's N03 (healthy-sync gate, merge must land), N04 (account binding across awaits),
// N08 (changes during a slow publish run next; pending is derived, never blanket-cleared) and
// N09 (the withdrawal mark is per instance+account and a late leave clears only its own).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const state = { user: null, S: null, config: null, sync: { status: 'ok' }, pullState: vi.fn() }
  const listeners = []
  return {
    state, listeners,
    publishReport: vi.fn(),
    leaveLeaderboard: vi.fn(),
    fetchMe: vi.fn()
  }
})
vi.mock('../store/useStore.js', () => {
  const useStore = selector => selector ? selector(mocks.state) : mocks.state
  useStore.getState = () => mocks.state
  useStore.subscribe = fn => { mocks.listeners.push(fn); return () => {} }
  return { useStore }
})
vi.mock('./leaderboard-client.js', () => ({
  fetchMe: (...a) => mocks.fetchMe(...a),
  leaveLeaderboard: (...a) => mocks.leaveLeaderboard(...a),
  publishReport: (...a) => mocks.publishReport(...a),
  fetchBoard: vi.fn(), joinLeaderboard: vi.fn(), setCheer: vi.fn()
}))

const mod = () => import('./leaderboard-publish.js')

const ME = { enabled: true, suspended: false, disclosureVersion: 1, currentDisclosureVersion: 1, consentVersion: 1, reportRev: 0 }
const facts = workouts => ({ workouts: workouts || [], activities: [] })
const ORIGIN = typeof location !== 'undefined' ? location.origin : 'local'

async function fresh() {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.listeners.length = 0
  mocks.state.user = { id: 'u1', name: 'A' }
  mocks.state.config = { leaderboard: { public_read: false } }
  mocks.state.S = facts([])
  mocks.state.sync = { status: 'ok' }
  mocks.fetchMe.mockResolvedValue({ ...ME })
  localStorage.clear()
  return mod()
}
const fire = () => { for (const l of mocks.listeners) l() }

describe('fingerprintOf — the aggregate inputs, not counts (R05)', () => {
  it('an edit to an OLD workout moves it; a same-length activity swap moves it', async () => {
    const { fingerprintOf } = await fresh()
    const before = fingerprintOf(facts([
      { id: 'a', d: '2026-10-01', start: 100, end: 200 },
      { id: 'b', d: '2026-10-02', start: 300, end: 400 }
    ]))
    const editedOld = fingerprintOf(facts([
      { id: 'a', d: '2026-10-01', start: 100, end: 999 },
      { id: 'b', d: '2026-10-02', start: 300, end: 400 }
    ]))
    expect(editedOld).not.toBe(before)
    const acts1 = fingerprintOf({ workouts: [], activities: [{ id: 'x', startMs: 1, endMs: 2 }] })
    const acts2 = fingerprintOf({ workouts: [], activities: [{ id: 'y', startMs: 3, endMs: 4 }] })
    expect(acts1).not.toBe(acts2)
  })
})

describe('the coordinator', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('publishes when the store moves, with a merge-verifying pull and an account-bound stateOf (R03/R05)', async () => {
    const m = await fresh()
    mocks.publishReport.mockResolvedValue({ ok: true, reportRev: 1 })
    m.startPublishing()
    await vi.advanceTimersByTimeAsync(10)
    expect(mocks.publishReport).toHaveBeenCalledTimes(1)
    const opts = mocks.publishReport.mock.calls[0][2]
    // The pull wrapper answers false when the merge did not land healthy (N03).
    mocks.state.pullState.mockResolvedValue()
    mocks.state.sync = { status: 'offline' }
    await expect(opts.pull()).resolves.toBe(false)
    mocks.state.sync = { status: 'ok' }
    await expect(opts.pull()).resolves.toBe(true)
    // stateOf stays bound to the account it started under (N04).
    expect(opts.stateOf()).toBe(mocks.state.S)
    mocks.state.user = { id: 'u2', name: 'B' }
    expect(opts.stateOf()).toBe(null)
    mocks.state.user = { id: 'u1', name: 'A' }
  })

  it('N03: nothing publishes while personal sync is unhealthy — offline, erroring, or held', async () => {
    const m = await fresh()
    for (const status of ['offline', 'error', 'held', 'auth', 'pending']) {
      mocks.state.sync = { status }
      mocks.publishReport.mockClear()
      m.retryNow()
      await vi.advanceTimersByTimeAsync(10)
      expect(mocks.publishReport).not.toHaveBeenCalled()
    }
    mocks.state.sync = { status: 'ok' }
    m.retryNow()
    await vi.advanceTimersByTimeAsync(10)
    expect(mocks.publishReport).toHaveBeenCalledTimes(1)
  })

  it('N04: an account switch mid-flight aborts — one account\'s facts never reach the next session', async () => {
    const m = await fresh()
    let resolveMe
    mocks.fetchMe.mockReturnValue(new Promise(r => { resolveMe = r }))
    m.startPublishing()
    await vi.advanceTimersByTimeAsync(5)
    // The me() answer lands after this device signed out and back in as someone else.
    mocks.state.user = { id: 'u2', name: 'B' }
    resolveMe({ ...ME })
    await vi.advanceTimersByTimeAsync(20)
    expect(mocks.publishReport).not.toHaveBeenCalled()
  })

  it('N08: a change landing during a slow publish runs next, and pending follows the live facts', async () => {
    const m = await fresh()
    mocks.publishReport.mockResolvedValue({ ok: true })
    m.startPublishing()
    await vi.advanceTimersByTimeAsync(10) // boot pass over the empty history

    let resolveFirst
    mocks.publishReport.mockClear()
    mocks.publishReport.mockReturnValue(new Promise(r => { resolveFirst = r }))
    mocks.state.S = facts([{ id: 'w1', d: '2026-10-20', start: 1, end: 2 }])
    fire()
    await vi.advanceTimersByTimeAsync(3000)       // the slow publish starts
    expect(mocks.publishReport).toHaveBeenCalledTimes(1)

    mocks.state.S = facts([{ id: 'w1', d: '2026-10-20', start: 1, end: 2 }, { id: 'w2', d: '2026-10-21', start: 3, end: 4 }])
    fire()
    await vi.advanceTimersByTimeAsync(3000)       // debounces while the first is in flight
    expect(mocks.publishReport).toHaveBeenCalledTimes(1)

    mocks.publishReport.mockClear()
    mocks.publishReport.mockResolvedValue({ ok: true })
    resolveFirst({ ok: true })                    // the first answer lands: fingerprint w1 only
    await vi.advanceTimersByTimeAsync(10)
    expect(m.publishStatus().pending).toBe(true)  // w2 is still unpublished — not blanket-cleared
    await vi.advanceTimersByTimeAsync(3000)       // the rerun publishes the newer facts
    expect(mocks.publishReport).toHaveBeenCalledTimes(1)
    expect(mocks.publishReport.mock.calls[0][0].workouts).toHaveLength(2)
    expect(m.publishStatus().pending).toBe(false)
  })

  it('R10: a failed publish stays pending with the error; success records the fingerprint', async () => {
    const m = await fresh()
    m.startPublishing()
    await vi.advanceTimersByTimeAsync(10)
    mocks.publishReport.mockResolvedValue({ ok: false, error: new Error('offline') })
    mocks.state.S = facts([{ id: 'w1', d: '2026-10-20', start: 1, end: 2 }])
    fire()
    await vi.advanceTimersByTimeAsync(3000)
    expect(m.publishStatus().pending).toBe(true)
    expect(m.publishStatus().lastError).toBe('offline')

    mocks.publishReport.mockResolvedValue({ ok: true, reportRev: 2 })
    fire()
    await vi.advanceTimersByTimeAsync(3000)
    expect(m.publishStatus().pending).toBe(false)
    expect(m.publishStatus().lastError).toBe(null)
    mocks.publishReport.mockClear()
    fire()
    await vi.advanceTimersByTimeAsync(3000)
    expect(mocks.publishReport).not.toHaveBeenCalled()
  })

  it('R11/N09: an offline withdrawal blocks publishing; a late success clears only its own mark', async () => {
    const m = await fresh()
    let resolveLeave
    mocks.leaveLeaderboard.mockReturnValue(new Promise(r => { resolveLeave = r }))
    const pending = m.requestLeave({ ...ME })
    expect(localStorage.getItem(`lb-withdraw:${ORIGIN}:u1`)).toBe('1')

    m.startPublishing()
    await vi.advanceTimersByTimeAsync(10)
    expect(mocks.publishReport).not.toHaveBeenCalled()

    // While A's leave is in flight, the device switches to B — who has a withdrawal of their own.
    mocks.state.user = { id: 'u2', name: 'B' }
    localStorage.setItem(`lb-withdraw:${ORIGIN}:u2`, '1')
    resolveLeave({})
    await pending
    await vi.advanceTimersByTimeAsync(10)
    // A's mark is cleared by A's answer; B's mark is untouched by it.
    expect(localStorage.getItem(`lb-withdraw:${ORIGIN}:u1`)).toBe(null)
    expect(localStorage.getItem(`lb-withdraw:${ORIGIN}:u2`)).toBe('1')
  })

  it('R12: an unconfirmed disclosure text blocks publishing', async () => {
    const m = await fresh()
    mocks.fetchMe.mockResolvedValue({ ...ME, disclosureVersion: 0, currentDisclosureVersion: 1 })
    m.startPublishing()
    await vi.advanceTimersByTimeAsync(10)
    expect(mocks.publishReport).not.toHaveBeenCalled()
    expect(m.publishStatus().pending).toBe(false)
  })

  it('a suspended or opted-out member publishes nothing', async () => {
    const m = await fresh()
    mocks.fetchMe.mockResolvedValue({ ...ME, enabled: false })
    m.startPublishing()
    await vi.advanceTimersByTimeAsync(10)
    expect(mocks.publishReport).not.toHaveBeenCalled()
  })
})
