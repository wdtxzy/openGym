// @vitest-environment happy-dom
// The global publish coordinator: the review's R03 (merge before re-publish), R05 (publishes
// without the page, fingerprint over the real aggregate inputs), R10 (failure stays pending
// and visible, success records the fingerprint), R11 (an offline withdrawal blocks publishing
// and retries first), R12 (an unconfirmed disclosure blocks publishing).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const state = { user: null, S: null, config: null, pullState: vi.fn() }
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

async function fresh() {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.listeners.length = 0
  mocks.state.user = { id: 'u1', name: 'A' }
  mocks.state.config = { leaderboard: { public_read: false } }
  mocks.state.S = facts([])
  mocks.fetchMe.mockResolvedValue({ ...ME })
  localStorage.clear()
  return mod()
}

describe('fingerprintOf — the aggregate inputs, not counts (R05)', () => {
  it('an edit to an OLD workout moves it; a same-length activity swap moves it', async () => {
    const { fingerprintOf } = await fresh()
    const before = fingerprintOf(facts([
      { id: 'a', d: '2026-10-01', start: 100, end: 200 },
      { id: 'b', d: '2026-10-02', start: 300, end: 400 }
    ]))
    const editedOld = fingerprintOf(facts([
      { id: 'a', d: '2026-10-01', start: 100, end: 999 },   // same count, older item edited
      { id: 'b', d: '2026-10-02', start: 300, end: 400 }
    ]))
    expect(editedOld).not.toBe(before)
    const withActs1 = fingerprintOf({ workouts: [], activities: [{ id: 'x', startMs: 1, endMs: 2 }] })
    const withActs2 = fingerprintOf({ workouts: [], activities: [{ id: 'y', startMs: 3, endMs: 4 }] })
    expect(withActs1).not.toBe(withActs2)
  })
})

describe('the coordinator (started once, no page involved)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('publishes when the store moves, with pull+stateOf for conflict recovery (R03/R05)', async () => {
    const m = await fresh()
    mocks.publishReport.mockResolvedValue({ ok: true, reportRev: 1 })
    m.startPublishing()
    await vi.advanceTimersByTimeAsync(10)
    expect(mocks.publishReport).toHaveBeenCalledTimes(1) // the boot pass over an empty history
    // The conflict recovery pulls through the store's own merge, then reads the merged state.
    mocks.publishReport.mock.calls[0][2].pull()
    expect(mocks.state.pullState).toHaveBeenCalled()

    // A finished workout with no leaderboard page anywhere: the store fires, the publish runs.
    mocks.publishReport.mockClear()
    mocks.state.S = facts([{ id: 'w1', d: '2026-10-20', start: 1, end: 2 }])
    for (const l of mocks.listeners) l()
    await vi.advanceTimersByTimeAsync(3000)
    expect(mocks.publishReport).toHaveBeenCalledTimes(1)
    expect(mocks.publishReport.mock.calls[0][2].stateOf()).toBe(mocks.state.S)
    expect(m.publishStatus().pending).toBe(false)
  })

  it('a failed publish stays pending with the error; success records the fingerprint (R10)', async () => {
    const m = await fresh()
    m.startPublishing()
    await vi.advanceTimersByTimeAsync(10)
    mocks.publishReport.mockResolvedValue({ ok: false, error: new Error('offline') })
    mocks.state.S = facts([{ id: 'w1', d: '2026-10-20', start: 1, end: 2 }])
    for (const l of mocks.listeners) l()
    await vi.advanceTimersByTimeAsync(3000)
    expect(m.publishStatus().pending).toBe(true)
    expect(m.publishStatus().lastError).toBe('offline')

    // The same facts retry on the next tick; only acceptance closes them.
    mocks.publishReport.mockResolvedValue({ ok: true, reportRev: 2 })
    for (const l of mocks.listeners) l()
    await vi.advanceTimersByTimeAsync(3000)
    expect(m.publishStatus().pending).toBe(false)
    expect(m.publishStatus().lastError).toBe(null)
    // Nothing more to do: an unchanged store fire publishes nothing.
    mocks.publishReport.mockClear()
    for (const l of mocks.listeners) l()
    await vi.advanceTimersByTimeAsync(3000)
    expect(mocks.publishReport).not.toHaveBeenCalled()
  })

  it('an offline withdrawal is persisted, blocks publishing, and retries the leave first (R11)', async () => {
    const m = await fresh()
    mocks.leaveLeaderboard.mockRejectedValue(new Error('offline'))
    const r = await m.requestLeave({ ...ME })
    expect(r.ok).toBe(false)
    expect(localStorage.getItem('lb-withdraw:u1')).toBe('1')

    m.startPublishing()
    await vi.advanceTimersByTimeAsync(10)
    // The withdrawal goes first; while it cannot land, no report is published at all.
    expect(mocks.publishReport).not.toHaveBeenCalled()
    expect(m.publishStatus().withdrawPending).toBe(true)

    mocks.leaveLeaderboard.mockResolvedValue({})
    // The leave landing turns the member off server-side; nothing publishes afterwards.
    mocks.fetchMe.mockResolvedValue({ ...ME, enabled: false })
    mocks.state.S = facts([{ id: 'w1', d: '2026-10-20', start: 1, end: 2 }])
    for (const l of mocks.listeners) l()
    await vi.advanceTimersByTimeAsync(3000)
    expect(localStorage.getItem('lb-withdraw:u1')).toBe(null)
    expect(m.publishStatus().withdrawPending).toBe(false)
    expect(mocks.publishReport).not.toHaveBeenCalled()
  })

  it('an unconfirmed disclosure text blocks publishing (R12)', async () => {
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

  it('a sign-in switch resets the published fingerprint between accounts', async () => {
    const m = await fresh()
    mocks.publishReport.mockResolvedValue({ ok: true })
    m.startPublishing()
    await vi.advanceTimersByTimeAsync(10)
    mocks.state.user = { id: 'u2', name: 'B' }
    for (const l of mocks.listeners) l()
    await vi.advanceTimersByTimeAsync(3000)
    // u2's first pass publishes (fresh fingerprint), never u1's recorded one.
    expect(mocks.publishReport).toHaveBeenCalled()
  })
})
