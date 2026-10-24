// @vitest-environment happy-dom
// The publish conflict rule (PRD §05, the review's R03): on a stale base the client must
// merge personal state FIRST and rebuild from the merged state — re-serializing the same
// outdated facts under a fresh revision is exactly how one device's older hour overwrote
// another's newer totals in the review's reproduction.
import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({ me: vi.fn(), put: vi.fn() }))
vi.mock('./api.js', () => ({
  api: (path, opts) => (path === '/api/leaderboard/me' ? mocks.me() : mocks.put(path, opts))
}))

const { publishReport } = await import('./leaderboard-client.js')

beforeEach(() => { vi.clearAllMocks() })

const ME = { enabled: true, suspended: false, consentVersion: 1, reportRev: 0 }

describe('publishReport conflict recovery (R03)', () => {
  it('a stale base pulls first, then builds from the merged state — never the closure copy', async () => {
    const stale = { workouts: [{ id: 'w1', d: '2026-10-20', start: 1, end: 2 }], activities: [] }
    const merged = { workouts: [{ id: 'w1', d: '2026-10-20', start: 1, end: 2 }, { id: 'w2', d: '2026-10-21', start: 3, end: 4 }], activities: [] }
    const pull = vi.fn()
    const stateOf = () => merged

    mocks.put.mockRejectedValueOnce(Object.assign(new Error('stale'), { status: 409, data: { error: 'report-stale' } }))
    mocks.me.mockResolvedValueOnce({ ...ME, reportRev: 4 })
    mocks.put.mockResolvedValueOnce({ reportRev: 5, acceptedAt: 1 })

    const r = await publishReport(stale, ME, { pull, stateOf })

    expect(r.ok).toBe(true)
    expect(pull).toHaveBeenCalledTimes(1)
    // The retried body was built from the MERGED state: both workouts reached the server,
    // and it was based on the re-read member revision (4), not the closure's.
    const sent = JSON.parse(mocks.put.mock.calls[1][1].body)
    expect(sent.days).toHaveLength(2)
    expect(sent.baseReportRev).toBe(4)
  })

  it('a non-recoverable failure is returned, not retried', async () => {
    mocks.put.mockRejectedValueOnce(Object.assign(new Error('nope'), { status: 403, data: { error: 'suspended' } }))
    const r = await publishReport({ workouts: [], activities: [] }, ME, { pull: vi.fn(), stateOf: () => ({ workouts: [], activities: [] }) })
    expect(r.ok).toBe(false)
    expect(mocks.put).toHaveBeenCalledTimes(1)
  })

  it('a recovery that finds the member disabled reports it instead of publishing', async () => {
    mocks.put.mockRejectedValueOnce(Object.assign(new Error('stale'), { status: 409, data: { error: 'consent-stale' } }))
    mocks.me.mockResolvedValueOnce({ enabled: false, suspended: false, consentVersion: 2, reportRev: 0 })
    const r = await publishReport({ workouts: [], activities: [] }, ME, { pull: vi.fn(), stateOf: () => ({ workouts: [], activities: [] }) })
    expect(r).toEqual({ ok: false, reason: 'disabled' })
    expect(mocks.put).toHaveBeenCalledTimes(1)
  })
})
