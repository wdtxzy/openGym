// @vitest-environment happy-dom
// The global publish coordinator, round 3: the earlier rounds' behaviour (R03/R05/R10/R11/R12,
// N03/N04/N08/N09) plus the third review's T01 (a publish waits for THIS session's completed
// merge), T02 (a generation that dies on A→B→A and same-uid server switches), T05 (withdrawal
// marks keyed by the real server base) and T06 (an old-format withdrawal mark blocks and is
// resolved by an attempted leave, never silently dropped).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const state = { user: null, S: null, config: null, sync: null, pullState: vi.fn() }
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
const ALPHA = 'https://alpha.example'

async function fresh() {
  vi.resetModules()
  vi.resetAllMocks() // clears implementations too: a rejected leave in an earlier test must not leak
  mocks.listeners.length = 0
  mocks.state.user = { id: 'u1', name: 'A' }
  mocks.state.config = { leaderboard: { public_read: false } }
  mocks.state.S = facts([])
  // A healthy-looking sync whose lastSynced is the value storage restored at boot: it must
  // NOT count as this session's merge until the coordinator sees it move (T01).
  mocks.state.sync = { status: 'ok', server: ALPHA, lastSynced: 100 }
  mocks.fetchMe.mockResolvedValue({ ...ME })
  localStorage.clear()
  return mod()
}
const fire = () => { for (const l of mocks.listeners) l() }
/** A real confirmed exchange in this session: lastSynced moves off the boot baseline. */
const sessionSynced = () => {
  mocks.state.sync = { ...mocks.state.sync, lastSynced: (mocks.state.sync.lastSynced || 0) + 1 }
  fire()
}

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

  it('T01: a healthy-looking boot state publishes nothing before THIS session merges', async () => {
    const m = await fresh()
    mocks.publishReport.mockResolvedValue({ ok: true })
    m.startPublishing()
    await vi.advanceTimersByTimeAsync(10)
    expect(mocks.publishReport).not.toHaveBeenCalled()
    // Facts changing meanwhile change nothing: the merge credential is still missing.
    mocks.state.S = facts([{ id: 'stale', d: '2026-10-20', start: 1, end: 2 }])
    fire()
    await vi.advanceTimersByTimeAsync(3000)
    expect(mocks.publishReport).not.toHaveBeenCalled()
    // The session's first confirmed exchange opens the gate — and publishes the CURRENT facts.
    sessionSynced()
    await vi.advanceTimersByTimeAsync(3000)
    expect(mocks.publishReport).toHaveBeenCalledTimes(1)
    expect(mocks.publishReport.mock.calls[0][0].workouts[0].id).toBe('stale')
  })

  it('T02: A → B → A kills the first A task even though the uid is back', async () => {
    const m = await fresh()
    mocks.state.S = facts([{ id: 'A-private', d: '2026-10-20', start: 1, end: 2 }])
    let resolveMe
    mocks.fetchMe.mockReturnValueOnce(new Promise(r => { resolveMe = r }))
    m.startPublishing()
    sessionSynced()
    await vi.advanceTimersByTimeAsync(10)
    expect(mocks.publishReport).not.toHaveBeenCalled() // still waiting on me()
    mocks.state = { ...mocks.state, user: { id: 'u2', name: 'B' } }; fire()
    mocks.state = { ...mocks.state, user: { id: 'u1', name: 'A' }, S: facts([{ id: 'A-current', d: '2026-10-20', start: 1, end: 2 }]) }; fire()
    resolveMe({ ...ME })
    await vi.advanceTimersByTimeAsync(10)
    expect(mocks.publishReport).not.toHaveBeenCalled() // the generation moved twice; the task died
    // The new session's own pass publishes only once it has merged in ITS session.
    sessionSynced()
    await vi.advanceTimersByTimeAsync(3000)
    expect(mocks.publishReport.mock.calls.every(c => c[0].workouts[0].id !== 'A-private')).toBe(true)
  })

  it('T02: the same uid switching paired servers is a different session', async () => {
    const m = await fresh()
    let resolveMe
    mocks.fetchMe.mockReturnValueOnce(new Promise(r => { resolveMe = r }))
    m.startPublishing()
    sessionSynced()
    await vi.advanceTimersByTimeAsync(10)
    mocks.state = { ...mocks.state, sync: { status: 'ok', server: 'https://beta.example', lastSynced: mocks.state.sync.lastSynced } }
    fire()
    resolveMe({ ...ME })
    await vi.advanceTimersByTimeAsync(10)
    expect(mocks.publishReport).not.toHaveBeenCalled()
  })

  it('publishes when the store moves, with a merge-verifying pull and a session-bound stateOf (R03)', async () => {
    const m = await fresh()
    mocks.publishReport.mockResolvedValue({ ok: true, reportRev: 1 })
    m.startPublishing()
    sessionSynced()
    await vi.advanceTimersByTimeAsync(3000)
    expect(mocks.publishReport).toHaveBeenCalledTimes(1)
    const opts = mocks.publishReport.mock.calls[0][2]
    // The pull wrapper answers false when the merge did not land healthy (N03).
    mocks.state.pullState.mockResolvedValue()
    mocks.state.sync = { ...mocks.state.sync, status: 'offline' }
    await expect(opts.pull()).resolves.toBe(false)
    mocks.state.sync = { ...mocks.state.sync, status: 'ok' }
    await expect(opts.pull()).resolves.toBe(true)
    // stateOf stays bound to the session it started under (N04/T02).
    expect(opts.stateOf()).toBe(mocks.state.S)
    mocks.state = { ...mocks.state, user: { id: 'u2', name: 'B' } }
    expect(opts.stateOf()).toBe(null)
  })

  it('N03: nothing publishes while personal sync is unhealthy — offline, erroring, or held', async () => {
    const m = await fresh()
    m.startPublishing()
    sessionSynced()
    await vi.advanceTimersByTimeAsync(3000)
    expect(mocks.publishReport).toHaveBeenCalledTimes(1)
    for (const status of ['offline', 'error', 'held', 'auth', 'pending']) {
      mocks.publishReport.mockClear()
      mocks.state.sync = { ...mocks.state.sync, status }
      mocks.state.S = facts([{ id: 'w' + status, d: '2026-10-20', start: 1, end: 2 }])
      fire()
      await vi.advanceTimersByTimeAsync(3000)
      expect(mocks.publishReport).not.toHaveBeenCalled()
    }
    mocks.state.sync = { ...mocks.state.sync, status: 'ok' }
    fire()
    await vi.advanceTimersByTimeAsync(3000)
    expect(mocks.publishReport).toHaveBeenCalledTimes(1)
  })

  it('N08: a change landing during a slow publish runs next, and pending follows the live facts', async () => {
    const m = await fresh()
    mocks.publishReport.mockResolvedValue({ ok: true })
    m.startPublishing()
    sessionSynced()
    await vi.advanceTimersByTimeAsync(10)

    let resolveFirst
    mocks.publishReport.mockClear()
    mocks.publishReport.mockReturnValue(new Promise(r => { resolveFirst = r }))
    mocks.state.S = facts([{ id: 'w1', d: '2026-10-20', start: 1, end: 2 }])
    fire()
    await vi.advanceTimersByTimeAsync(3000)
    expect(mocks.publishReport).toHaveBeenCalledTimes(1)

    mocks.state.S = facts([{ id: 'w1', d: '2026-10-20', start: 1, end: 2 }, { id: 'w2', d: '2026-10-21', start: 3, end: 4 }])
    fire()
    await vi.advanceTimersByTimeAsync(3000)
    expect(mocks.publishReport).toHaveBeenCalledTimes(1)

    mocks.publishReport.mockClear()
    mocks.publishReport.mockResolvedValue({ ok: true })
    resolveFirst({ ok: true })
    await vi.advanceTimersByTimeAsync(10)
    expect(m.publishStatus().pending).toBe(true)
    await vi.advanceTimersByTimeAsync(3000)
    expect(mocks.publishReport).toHaveBeenCalledTimes(1)
    expect(mocks.publishReport.mock.calls[0][0].workouts).toHaveLength(2)
    expect(m.publishStatus().pending).toBe(false)
  })

  it('R10: a failed publish stays pending with the error; success records the fingerprint', async () => {
    const m = await fresh()
    m.startPublishing()
    sessionSynced()
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

  it('T05: a withdrawal mark belongs to the server it was made on; another server never replays it', async () => {
    const m = await fresh()
    mocks.leaveLeaderboard.mockRejectedValue(new Error('offline'))
    await m.requestLeave({ ...ME })
    expect(localStorage.getItem(`lb-withdraw:${ALPHA}:u1`)).toBe('1')
    expect(mocks.leaveLeaderboard).toHaveBeenCalledTimes(1)

    // Same uid, another paired server: no leave is replayed there, no mark is cleared.
    mocks.state = { ...mocks.state, sync: { status: 'ok', server: 'https://beta.example', lastSynced: 200 } }
    m.retryNow()
    await vi.advanceTimersByTimeAsync(10)
    expect(mocks.leaveLeaderboard).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(`lb-withdraw:${ALPHA}:u1`)).toBe('1')
  })

  it('T06: an old-format withdrawal mark blocks publishing and is resolved by an attempted leave', async () => {
    const m = await fresh()
    localStorage.setItem('lb-withdraw:u1', '1') // the previous release's key format
    m.startPublishing()
    sessionSynced()
    await vi.advanceTimersByTimeAsync(10) // the resolution window: blocked, one leave attempt, mark gone
    expect(mocks.publishReport).not.toHaveBeenCalled()
    expect(mocks.leaveLeaderboard).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem('lb-withdraw:u1')).toBe(null) // resolved once the leave lands
  })

  it('R11/N09: an offline withdrawal blocks publishing; a late success clears only its own mark', async () => {
    const m = await fresh()
    let resolveLeave
    mocks.leaveLeaderboard.mockReturnValueOnce(new Promise(r => { resolveLeave = r }))
    const pending = m.requestLeave({ ...ME })
    expect(localStorage.getItem(`lb-withdraw:${ALPHA}:u1`)).toBe('1')

    sessionSynced()
    await vi.advanceTimersByTimeAsync(3000)
    expect(mocks.publishReport).not.toHaveBeenCalled()

    // While u1's leave is in flight, the device switches to u2 — with a withdrawal of their own.
    mocks.state = { ...mocks.state, user: { id: 'u2', name: 'B' } }
    localStorage.setItem(`lb-withdraw:${ALPHA}:u2`, '1')
    resolveLeave({})
    await pending
    await vi.advanceTimersByTimeAsync(10)
    expect(localStorage.getItem(`lb-withdraw:${ALPHA}:u1`)).toBe(null)
    expect(localStorage.getItem(`lb-withdraw:${ALPHA}:u2`)).toBe('1')
  })

  it('R12: an unconfirmed disclosure text blocks publishing', async () => {
    const m = await fresh()
    mocks.fetchMe.mockResolvedValue({ ...ME, disclosureVersion: 0, currentDisclosureVersion: 1 })
    m.startPublishing()
    sessionSynced()
    await vi.advanceTimersByTimeAsync(3000)
    expect(mocks.publishReport).not.toHaveBeenCalled()
    expect(m.publishStatus().pending).toBe(false)
  })

  it('a suspended or opted-out member publishes nothing', async () => {
    const m = await fresh()
    mocks.fetchMe.mockResolvedValue({ ...ME, enabled: false })
    m.startPublishing()
    sessionSynced()
    await vi.advanceTimersByTimeAsync(3000)
    expect(mocks.publishReport).not.toHaveBeenCalled()
  })
})
