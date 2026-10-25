/* The leaderboard's client half: turning personal state into day buckets and a report.
 *
 * The calendar itself (Asia/Shanghai days, Monday weeks, month edges) lives in
 * api/community/windows.js and is imported from here the same way the coach core is — one
 * definition, used by both the app that builds the buckets and the server that sums them, so
 * the two cannot disagree about which day or week a session belongs to.
 *
 * What this module owns:
 *   - attribution: a session belongs entirely to the Beijing day it STARTED on, even across
 *     midnight (Q02) — never split between two days or two weeks.
 *   - the gym/synced split: gym time is the app's own recorded session duration; synced time
 *     is health-activity time MINUS the parts that overlap formal training (Q11's interval
 *     subtraction — the union of training intervals is removed, never double-removed where two
 *     workouts overlap each other).
 *   - report building: a full replacement of the last REPORT_DAYS day buckets plus an
 *     independently computed lifetime, with declared coverage so an unstated day reads as
 *     zero rather than as "unknown".
 *
 * Pure functions throughout; `now` is always injectable. Anything that decides what lands on
 * the leaderboard lives here with a test beside it, per the repo's own rule. */
import { beijingDayKey, windowFor, CALENDAR_VERSION } from '../../../api/community/windows.js';
import { workoutDuration } from './history.js';

export const REPORT_SCHEMA_VERSION = 1;
export const ALGORITHM_VERSION = 1;
export const REPORT_DAYS = 93; // weeks and the current month never need more than this

const DAY = 86400000;
const isMs = v => Number.isFinite(v) && v >= 0 && Number.isSafeInteger(v);

/* ---------- interval arithmetic (Q11: subtract the training union, once) ---------- */

/** Total length of the union of [start, end) intervals — overlapping pieces counted once. */
export function unionLength(intervals) {
  const spans = intervals
    .filter(([s, e]) => isMs(s) && isMs(e) && e > s)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let end = -Infinity;
  for (const [s, e] of spans) {
    if (s >= end) { total += e - s; end = e; }
    else if (e > end) { total += e - end; end = e; }
  }
  return total;
}

/** An activity's remaining milliseconds: its own length minus whatever overlaps formal
 *  training. Two workouts that overlap each other by 5 min still remove their union, not their
 *  sum — the PRD's own example (60 − 45 = 15; 20 + 15 with 5 shared removes 30, not 35). */
export function remainingMs(activityStart, activityEnd, workoutIntervals) {
  if (!isMs(activityStart) || !isMs(activityEnd) || activityEnd <= activityStart) return 0;
  return Math.max(0, (activityEnd - activityStart) - unionLength(
    workoutIntervals.map(([s, e]) => [Math.max(s, activityStart), Math.min(e, activityEnd)])
  ));
}

/* ---------- aggregation: personal facts → day buckets + lifetime ---------- */

const emptyTotals = () => ({ gymMs: 0, syncedMs: 0, gymSessions: 0, syncedSessions: 0 });
const bucket = (days, dayKey) => (days[dayKey] ??= emptyTotals());

/** A workout lands on the Beijing day of its start timestamp; a record with no valid times but
 *  a date still counts as a session (0 ms — no duration is invented, PRD FR-1.6R); a record
 *  with neither is not on any day and is skipped entirely. "Valid" start means a real epoch:
 *  timestamps before 2000 are placeholder zeros (a 1970 bucket would swallow fixtures and
 *  hand-migrated records whole), so they fall through to the recorded date like a missing one. */
const PLAUSIBLE_START = Date.UTC(2000, 0, 1);
export function gymBuckets(workouts = []) {
  const days = {};
  for (const w of workouts || []) {
    const start = Number.isFinite(w?.start) ? w.start : null;
    const dayKey = (start !== null && start >= PLAUSIBLE_START && Number.isSafeInteger(start) ? beijingDayKey(start) : null)
      || (/^\d{4}-\d{2}-\d{2}$/.test(String(w?.d || '')) ? w.d : null);
    if (!dayKey) continue;
    const b = bucket(days, dayKey);
    b.gymMs += workoutDuration(w);
    b.gymSessions += 1;
  }
  return days;
}

/** Health activities: excluded, source-deleted or converted ones never count; an activity
 *  counts once, for its remaining (post-overlap) time, on the Beijing day it started on —
 *  remaining fragments that cross midnight are not split out of that day (PRD FR-1.6R). */
export function syncedBuckets(activities = [], workouts = []) {
  const training = (workouts || [])
    .filter(w => Number.isFinite(w?.start) && Number.isFinite(w?.end))
    .map(w => [w.start, w.end]);
  const days = {};
  for (const a of activities || []) {
    if (!a || a.userExcluded || a.sourceDeleted || a.linkedWorkoutId) continue;
    const left = remainingMs(a.startMs, a.endMs, training);
    if (left <= 0) continue; // fully overlapping or timeless: no time, and no session either
    const b = bucket(days, beijingDayKey(a.startMs));
    b.syncedMs += left;
    b.syncedSessions += 1;
  }
  return days;
}

/** The full personal aggregate: per-day buckets over all history plus an independently
 *  computed lifetime (never a re-sum of a truncated report). */
export function aggregate(workouts = [], activities = []) {
  const days = {};
  for (const source of [gymBuckets(workouts), syncedBuckets(activities, workouts)]) {
    for (const [dayKey, totals] of Object.entries(source)) {
      const b = bucket(days, dayKey);
      b.gymMs += totals.gymMs; b.syncedMs += totals.syncedMs;
      b.gymSessions += totals.gymSessions; b.syncedSessions += totals.syncedSessions;
    }
  }
  const lifetime = emptyTotals();
  for (const b of Object.values(days)) {
    lifetime.gymMs += b.gymMs; lifetime.syncedMs += b.syncedMs;
    lifetime.gymSessions += b.gymSessions; lifetime.syncedSessions += b.syncedSessions;
  }
  return { days, lifetime };
}

/* ---------- report building (FR-1.5R) ---------- */

const keyToMs = key => Date.parse(key + 'T00:00:00Z');

/** A report fully replaces the published buckets inside the coverage window — days outside it
 *  are dropped (the server prunes what it holds anyway), days inside it that are absent are
 *  zero by the declared coverage, so only non-zero buckets are sent. `lifetime` always covers
 *  all history regardless of the 93-day window. */
export function buildReport({ workouts, activities }, { consentVersion, baseReportRev, requestId, now }) {
  const { days, lifetime } = aggregate(workouts, activities);
  const todayMs = keyToMs(beijingDayKey(now));
  const coverageStartMs = todayMs - (REPORT_DAYS - 1) * DAY;
  const coverageStart = beijingDayKey(coverageStartMs);
  const coverageEnd = beijingDayKey(todayMs);
  const outDays = Object.entries(days)
    .filter(([dayKey]) => dayKey >= coverageStart && dayKey <= coverageEnd)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, b]) => ({
      date,
      gymMs: b.gymMs, syncedMs: b.syncedMs,
      gymSessions: b.gymSessions, syncedSessions: b.syncedSessions
    }));
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    algorithmVersion: ALGORITHM_VERSION,
    calendarVersion: CALENDAR_VERSION,
    consentVersion,
    baseReportRev,
    requestId,
    dataAsOf: now,
    coverageStart,
    coverageEnd,
    days: outDays,
    lifetime
  };
}

/** Sum of the buckets that fall in a window — what the server ranks on, and what a
 *  signed-out or pre-join preview can show from the same buckets. For 'all' the window has
 *  no bounds, so every bucket lands in the sum (it is the lifetime). */
export function windowTotals(days = {}, windowType, now) {
  const w = windowFor(windowType, now);
  const totals = emptyTotals();
  for (const [dayKey, b] of Object.entries(days || {})) {
    if (w.startKey && (dayKey < w.startKey || dayKey >= w.endKey)) continue;
    totals.gymMs += b.gymMs; totals.syncedMs += b.syncedMs;
    totals.gymSessions += b.gymSessions; totals.syncedSessions += b.syncedSessions;
  }
  return totals;
}

/* ---------- publish fingerprint (G02) ---------- */

/** The aggregate inputs a report is built from, hashed cheaply: edits to an OLD session or a
 *  same-count activity swap move it, not just counts. Pure — the publisher and the client use
 *  it to name exactly which facts the server accepted. */
export function fingerprintOf(S) {
  const w = (S?.workouts || []).map(x => [x.id, x.d, x.start ?? 0, x.end ?? 0])
  const a = (S?.activities || []).map(x => [x.id, x.startMs ?? 0, x.endMs ?? 0, !!x.userExcluded, !!x.sourceDeleted, x.linkedWorkoutId ?? null])
  return JSON.stringify([w, a])
}
