/* The leaderboard's one calendar: Asia/Shanghai, Monday weeks, natural months.
 *
 * Everyone on an instance is ranked by the same clock no matter where their phone is (PRD
 * FR-1.2R): the server names each window and sums the published day buckets into it, and the
 * client attributes every session to a Beijing day when building them — both sides import this
 * module, the way the frontend already imports the coach core, so the two can never drift into
 * disagreeing about when a week ends. One definition per concept, in pure functions with an
 * injectable clock, because a month edge or a workout that crosses midnight is exactly the kind
 * of thing a test has to be able to pin.
 *
 * Asia/Shanghai is a fixed UTC+8 — China dropped DST in 1991 and every timestamp this app has
 * seen is younger than that — so the conversion is an offset, not a timezone database. Windows
 * are half-open [start, end): a Monday 00:00 session belongs to the new week, and a session
 * that started Sunday 23:30 belongs entirely to the Sunday it began on (Q02), even where its
 * minutes spill past midnight. */
export const CALENDAR_VERSION = 1;
export const TIMEZONE = 'Asia/Shanghai';
export const WEEK_START = 1; // Monday
const BJ = 8 * 3600000;
const DAY = 86400000;

const pad = n => String(n).padStart(2, '0');
const keyOf = shiftedMs => {
  const d = new Date(shiftedMs);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

/** The Beijing calendar day an instant falls in, 'YYYY-MM-DD'; null for a non-time. */
export function beijingDayKey(ms) {
  if (!Number.isFinite(ms)) return null;
  return keyOf(ms + BJ); // keyOf reads only the calendar date of the shifted instant
}

/** Beijing midnight (as an epoch ms) of the day containing `ms`. */
export function beijingMidnight(ms) {
  if (!Number.isFinite(ms)) return null;
  return Math.floor((ms + BJ) / DAY) * DAY - BJ;
}

/** `week` → the Monday 00:00 the instant falls in; `month` → the natural month; `all` → the
 *  whole history. Every field is derived, so the same call never disagrees with itself. */
export function windowFor(windowType, nowMs) {
  const meta = { windowType, timezone: TIMEZONE, weekStart: WEEK_START, calendarVersion: CALENDAR_VERSION };
  if (windowType === 'all') return { ...meta, windowKey: 'all', startKey: null, endKey: null, startMs: null, endMs: null };
  const shifted = Math.floor(nowMs + BJ);
  const day = Math.floor(shifted / DAY) * DAY;
  if (windowType === 'week') {
    const weekday = new Date(day).getUTCDay(); // 0 Sunday … 6 Saturday
    const monday = day - ((weekday + 6) % 7) * DAY;
    return { ...meta, windowKey: keyOf(monday), startKey: keyOf(monday), endKey: keyOf(monday + 7 * DAY), startMs: monday - BJ, endMs: monday + 7 * DAY - BJ };
  }
  if (windowType === 'month') {
    const d = new Date(day);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    const start = Date.UTC(y, m, 1);
    const end = Date.UTC(m === 11 ? y + 1 : y, m === 11 ? 0 : m + 1, 1);
    return { ...meta, windowKey: `${y}-${pad(m + 1)}`, startKey: keyOf(start), endKey: keyOf(end), startMs: start - BJ, endMs: end - BJ };
  }
  return null;
}

/** Standard competition ranking (1, 1, 3) by totalMs desc, publicMemberId as the stable
 *  tie-break. Pure: returns new row objects, never mutates or re-orders the input. */
export function rankRows(rows) {
  const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const sorted = [...rows].sort((a, b) => ((b.totalMs ?? 0) - (a.totalMs ?? 0)) || byId(String(a.publicMemberId), String(b.publicMemberId)));
  let lastTotal = null;
  let lastRank = 0;
  return sorted.map((row, i) => {
    const total = row.totalMs ?? 0;
    const rank = total === lastTotal ? lastRank : i + 1;
    lastTotal = total;
    lastRank = rank;
    return { ...row, rank };
  });
}
