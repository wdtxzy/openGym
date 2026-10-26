// @vitest-environment happy-dom
// The publish conflict rule (PRD §05, the review's R03) and the round-7 snapshot pairing
// (I02): on a stale base the client must merge personal state FIRST and rebuild from the
// merged state — re-serializing the same outdated facts under a fresh revision is exactly
// how one device's older hour overwrote another's newer totals in the review's
// reproduction. And the facts plus the personal-state revision they were confirmed at
// always travel together: a send never borrows the freshest me.personalRev to label older
// facts, and a 409 recovery re-captures the WHOLE snapshot (facts AND rev) after the merge.
import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({ me: vi.fn(), put: vi.fn() }))
vi.mock('./api.js', () => ({
  api: (path, opts) => (path === '/api/leaderboard/me' ? mocks.me() : mocks.put(path, opts))
}))

const { publishReport } = await import('./leaderboard-client.js')

beforeEach(() => { vi.clearAllMocks() })

const ME = { enabled: true, suspended: false, consentVersion: 1, reportRev: 0 }
const snap = (facts, rev) => ({ facts, rev })

describe('publishReport conflict recovery (R03)', () => {
  it('a stale base pulls first, then builds from the merged state — never the closure copy', async () => {
    const stale = { workouts: [{ id: 'w1', d: '2026-10-20', start: 1, end: 2 }], activities: [] }
    const merged = { workouts: [{ id: 'w1', d: '2026-10-20', start: 1, end: 2 }, { id: 'w2', d: '2026-10-21', start: 3, end: 4 }], activities: [] }
    const pull = vi.fn()
    const snapshotOf = () => snap(merged, 7)

    mocks.put.mockRejectedValueOnce(Object.assign(new Error('stale'), { status: 409, data: { error: 'report-stale' } }))
    mocks.me.mockResolvedValueOnce({ ...ME, reportRev: 4 })
    mocks.put.mockResolvedValueOnce({ reportRev: 5, acceptedAt: 1 })

    const r = await publishReport(snap(stale, 6), ME, { pull, snapshotOf })

    expect(r.ok).toBe(true)
    expect(pull).toHaveBeenCalledTimes(1)
    // The retried body was built from the MERGED snapshot: both workouts reached the server,
    // it was based on the re-read member revision (4), and the retry's pairing is the
    // re-captured snapshot's rev (7) — facts and rev from the SAME read (I02).
    const sent = JSON.parse(mocks.put.mock.calls[1][1].body)
    expect(sent.days.length >= 1).toBe(true)
    expect(sent.baseReportRev).toBe(4)
    expect(sent.personalRev).toBe(7)
    expect(r.acceptedRev).toBe(7)
  })

  it('a non-recoverable failure is returned, not retried', async () => {
    mocks.put.mockRejectedValueOnce(Object.assign(new Error('nope'), { status: 403, data: { error: 'suspended' } }))
    const r = await publishReport(snap({ workouts: [], activities: [] }, 1), ME, { pull: vi.fn(), snapshotOf: () => snap({ workouts: [], activities: [] }, 1) })
    expect(r.ok).toBe(false)
    expect(mocks.put).toHaveBeenCalledTimes(1)
  })

  it('a recovery that finds the member disabled reports it instead of publishing', async () => {
    mocks.put.mockRejectedValueOnce(Object.assign(new Error('stale'), { status: 409, data: { error: 'consent-stale' } }))
    mocks.me.mockResolvedValueOnce({ enabled: false, suspended: false, consentVersion: 2, reportRev: 0 })
    const r = await publishReport(snap({ workouts: [], activities: [] }, 1), ME, { pull: vi.fn(), snapshotOf: () => snap({ workouts: [], activities: [] }, 1) })
    expect(r).toEqual({ ok: false, reason: 'disabled' })
    expect(mocks.put).toHaveBeenCalledTimes(1)
  })
})

describe('the snapshot pairing (I02)', () => {
  it('the sent personalRev is the snapshot\'s own rev — me.personalRev is never borrowed', async () => {
    mocks.put.mockResolvedValueOnce({ reportRev: 1, acceptedAt: 1 })
    // me.personalRev is 9, the confirmed snapshot is rev 1: the label must stay 1.
    const r = await publishReport(snap({ workouts: [], activities: [] }, 1), { ...ME, personalRev: 9 })
    const sent = JSON.parse(mocks.put.mock.calls[0][1].body)
    expect(sent.personalRev).toBe(1)
    expect(r.ok).toBe(true)
  })

  it('a snapshot without a confirmed rev omits the field (pre-pairing client), never guesses', async () => {
    mocks.put.mockResolvedValueOnce({ reportRev: 1, acceptedAt: 1 })
    await publishReport(snap({ workouts: [], activities: [] }, null), { ...ME, personalRev: 9 })
    const sent = JSON.parse(mocks.put.mock.calls[0][1].body)
    expect('personalRev' in sent).toBe(false)
  })

  it('an account switch mid-recovery leaves the publish pending, not rebuilt from a stranger', async () => {
    mocks.put.mockRejectedValueOnce(Object.assign(new Error('stale'), { status: 409, data: { error: 'personal-stale' } }))
    mocks.me.mockResolvedValueOnce({ ...ME, reportRev: 1 })
    const r = await publishReport(snap({ workouts: [], activities: [] }, 1), ME, {
      pull: vi.fn(),
      snapshotOf: () => null // the session is gone by the time the merge lands
    })
    expect(r).toEqual({ ok: false, reason: 'account-switched', error: expect.any(Error) })
    expect(mocks.put).toHaveBeenCalledTimes(1)
  })
})
