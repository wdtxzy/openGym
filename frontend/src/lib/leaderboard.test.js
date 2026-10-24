import { describe, expect, it } from 'vitest'
import {
  REPORT_DAYS,
  aggregate,
  buildReport,
  gymBuckets,
  remainingMs,
  syncedBuckets,
  unionLength,
  windowTotals
} from './leaderboard.js'
import { beijingDayKey, windowFor } from '../../../api/community/windows.js'

// Beijing instants this file pins behaviour to. 2026-10-19 is a Monday; the PRD's own
// cross-midnight example is Beijing Sunday 2026-10-25 23:30 → Monday 00:30.
const bj = (y, m, d, h = 0, min = 0) => Date.UTC(y, m - 1, d, h - 8, min) // h in Beijing time
const MIN = 60000
const SUN_2330 = bj(2026, 10, 25, 23, 30) // Beijing Sunday 23:30
const MON_1030 = bj(2026, 10, 26, 0, 30)  // Beijing Monday 00:30

describe('unionLength — the training side of the subtraction (Q11)', () => {
  it('counts overlapping workouts once, not twice', () => {
    // 20 + 15 min workouts sharing 5 min: the union is 30, never 35 (PRD's own example).
    expect(unionLength([[0, 20 * MIN], [15 * MIN, 30 * MIN]])).toBe(30 * MIN)
    expect(unionLength([[0, 20 * MIN], [5 * MIN, 20 * MIN]])).toBe(20 * MIN) // contained
    expect(unionLength([[0, 5 * MIN], [5 * MIN, 10 * MIN]])).toBe(10 * MIN) // touching endpoints
    expect(unionLength([])).toBe(0)
    expect(unionLength([[10, 10]])).toBe(0) // empty span
  })

  it('ignores non-times rather than throwing on junk', () => {
    expect(unionLength([['x', 5], [0, 5]])).toBe(5)
  })
})

describe('remainingMs — an activity minus the training union', () => {
  const train = [[0, 45 * MIN]]
  it('60 min of activity with 45 min of training leaves 15', () => {
    expect(remainingMs(0, 60 * MIN, train)).toBe(15 * MIN)
  })
  it('full overlap leaves 0, no overlap leaves everything', () => {
    expect(remainingMs(5 * MIN, 40 * MIN, train)).toBe(0)
    expect(remainingMs(60 * MIN, 90 * MIN, train)).toBe(30 * MIN)
  })
  it('clips training to the activity before subtracting', () => {
    // A 30-minute activity [30,60) against training [0,40): the overlap is 10, so 20 remain.
    expect(remainingMs(30 * MIN, 60 * MIN, [[0, 40 * MIN]])).toBe(20 * MIN)
  })
  it('an activity without usable bounds has no time at all', () => {
    expect(remainingMs(NaN, 5, [])).toBe(0)
    expect(remainingMs(10, 10, [])).toBe(0)
  })
})

describe('gymBuckets — attribution by start day, no invented duration', () => {
  it('a session belongs entirely to the Beijing day it started on, across midnight (Q02)', () => {
    const days = gymBuckets([{ id: 'w1', d: 'whatever-the-phone-said', start: SUN_2330, end: MON_1030 }])
    expect(Object.keys(days)).toEqual(['2026-10-25'])
    expect(days['2026-10-25'].gymMs).toBe(60 * MIN)
    expect(days['2026-10-25'].gymSessions).toBe(1)
    // …and therefore to the week that Sunday belongs to, not the Monday it spills into.
    const week = windowTotals(days, 'week', bj(2026, 10, 26, 11))
    expect(week.gymMs).toBe(0) // the new week sees none of it
    expect(windowTotals(days, 'week', SUN_2330).gymMs).toBe(60 * MIN)
  })

  it('invalid or missing times contribute 0 ms, never a fabricated duration', () => {
    const days = gymBuckets([
      { id: 'a', d: '2026-10-20', start: 1000 },                 // a placeholder epoch, not a real start
      { id: 'b', d: '2026-10-21' },                               // a date only (manual backfill)
      { id: 'c' }                                                 // nothing usable at all
    ])
    expect(days['2026-10-20']).toMatchObject({ gymMs: 0, gymSessions: 1 })
    expect(days['2026-10-21']).toMatchObject({ gymMs: 0, gymSessions: 1 })
    expect(days['2026-10-22']).toBeUndefined()
    expect(Object.keys(days).sort()).toEqual(['2026-10-20', '2026-10-21'])
  })

  it('UTC 16:00 is Beijing midnight of the next day', () => {
    expect(beijingDayKey(Date.UTC(2026, 9, 24, 16, 0))).toBe('2026-10-25')
  })
})

describe('syncedBuckets — the health side (Q11 + Q12 semantics)', () => {
  const train = [[SUN_2330, SUN_2330 + 45 * MIN]]
  it('counts only the remainder, once, on the activity\'s start day', () => {
    const days = syncedBuckets(
      [{ id: 'a1', startMs: SUN_2330, endMs: SUN_2330 + 60 * MIN }],
      [{ start: SUN_2330, end: SUN_2330 + 45 * MIN }]
    )
    expect(days['2026-10-25']).toMatchObject({ syncedMs: 15 * MIN, syncedSessions: 1 })
  })
  it('two overlapping workouts remove their union, not their sum', () => {
    const base = SUN_2330
    const days = syncedBuckets(
      [{ id: 'a1', startMs: base, endMs: base + 60 * MIN }],
      [
        { start: base, end: base + 20 * MIN },
        { start: base + 15 * MIN, end: base + 30 * MIN } // 5 min shared with the first
      ]
    )
    expect(days['2026-10-25'].syncedMs).toBe(30 * MIN) // 60 − union(30), not 60 − 35
  })
  it('a fully-overlapping activity leaves no time and no session', () => {
    const base = SUN_2330
    const days = syncedBuckets(
      [
        { id: 'gone', startMs: base, endMs: base + 10 * MIN },
        { id: 'excluded', startMs: base, endMs: base + 60 * MIN, userExcluded: true },
        { id: 'deleted-at-source', startMs: base, endMs: base + 60 * MIN, sourceDeleted: true },
        { id: 'converted', startMs: base, endMs: base + 60 * MIN, linkedWorkoutId: 'w9' }
      ],
      [{ start: base, end: base + 60 * MIN }]
    )
    expect(days['2026-10-25']).toBeUndefined()
  })
})

describe('aggregate + buildReport — the published facts', () => {
  const now = bj(2026, 10, 24, 12)
  const workouts = [
    { id: 'w1', d: '2026-10-20', start: bj(2026, 10, 20, 18), end: bj(2026, 10, 20, 19) },
    { id: 'w-old', d: '2026-06-01', start: bj(2026, 6, 1, 18), end: bj(2026, 6, 1, 19) } // 175 days back
  ]
  it('lifetime covers all history; the report window trims to 93 days including today', () => {
    const report = buildReport({ workouts, activities: [] }, { consentVersion: 3, baseReportRev: 7, requestId: 'r1', now })
    expect(report.days.map(d => d.date)).toEqual(['2026-10-20'])
    expect(report.lifetime.gymMs).toBe(120 * MIN)
    expect(report.lifetime.gymSessions).toBe(2)
    expect(report.coverageEnd).toBe('2026-10-24')
    expect(report.coverageStart).toBe(beijingDayKey(Date.UTC(2026, 9, 24) - (REPORT_DAYS - 1) * 86400000 - 8 * 3600000))
    expect(report).toMatchObject({
      schemaVersion: 1, algorithmVersion: 1, calendarVersion: 1,
      consentVersion: 3, baseReportRev: 7, requestId: 'r1', dataAsOf: now
    })
  })
  it('aggregate keeps the two sides and both counters apart', () => {
    const base = bj(2026, 10, 20, 6)
    const { days, lifetime } = aggregate(
      [{ id: 'w1', d: '2026-10-20', start: base, end: base + 30 * MIN }],
      [{ id: 'a1', startMs: base, endMs: base + 60 * MIN }]
    )
    expect(days['2026-10-20']).toEqual({ gymMs: 30 * MIN, syncedMs: 30 * MIN, gymSessions: 1, syncedSessions: 1 })
    expect(lifetime).toEqual({ gymMs: 30 * MIN, syncedMs: 30 * MIN, gymSessions: 1, syncedSessions: 1 })
  })
})

describe('windowTotals — the same buckets, summed per period', () => {
  const days = {
    '2026-10-12': { gymMs: 10, syncedMs: 0, gymSessions: 1, syncedSessions: 0 }, // last week
    '2026-10-19': { gymMs: 20, syncedMs: 5, gymSessions: 1, syncedSessions: 1 }, // this week
    '2026-10-26': { gymMs: 40, syncedMs: 0, gymSessions: 2, syncedSessions: 0 }  // next week (a test fixture)
  }
  it('a week sums only its own days, a month its own, all everything', () => {
    const at = bj(2026, 10, 21, 9)
    expect(windowTotals(days, 'week', at).gymMs).toBe(20)
    expect(windowTotals(days, 'week', at).syncedMs).toBe(5)
    expect(windowTotals(days, 'month', at).gymMs).toBe(70)
    expect(windowTotals(days, 'all', at).gymMs).toBe(70)
  })
  it('the window metadata itself: Monday weeks, month edges, Beijing clock', () => {
    const w = windowFor('week', bj(2026, 10, 21, 9))
    expect(w).toMatchObject({ windowKey: '2026-10-19', startKey: '2026-10-19', endKey: '2026-10-26', timezone: 'Asia/Shanghai', weekStart: 1 })
    expect(windowFor('week', bj(2026, 12, 29, 0, 0)).windowKey).toBe('2026-12-28') // the week that spans new year
    expect(windowFor('week', bj(2026, 12, 29, 0, 0)).endKey).toBe('2027-01-04')
    expect(windowFor('month', bj(2026, 12, 31, 23, 59)).windowKey).toBe('2026-12')
    expect(windowFor('month', bj(2027, 1, 1, 0, 0)).windowKey).toBe('2027-01') // left-closed
    expect(windowFor('week', bj(2026, 10, 26, 0, 0)).windowKey).toBe('2026-10-26') // Monday 00:00 is the new week
    expect(windowFor('week', bj(2026, 10, 26, 0, 0) - 1).windowKey).toBe('2026-10-19')
    expect(windowFor('all', now0()).windowKey).toBe('all')
  })
})

function now0() { return bj(2026, 10, 24, 12) }
