/* The calendar and ranking half the leaderboard shares with the frontend.
 *
 * The frontend pins attribution (src/lib/leaderboard.test.js); this file pins what the server
 * itself depends on: window naming and bounds for summing published buckets, and the rank
 * order members actually see. Both sides import api/community/windows.js — these tests are the
 * server's guarantee that the module it loads is the one the contract describes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { beijingDayKey, beijingMidnight, rankRows, windowFor, TIMEZONE, CALENDAR_VERSION } from '../community/windows.js';

const bj = (y, m, d, h = 0, min = 0) => Date.UTC(y, m - 1, d, h - 8, min);

test('weeks are Beijing Mondays, half-open, across month and year edges', () => {
  const w = windowFor('week', bj(2026, 10, 21, 9));
  assert.equal(w.windowKey, '2026-10-19');
  assert.equal(w.startMs, bj(2026, 10, 19));
  assert.equal(w.endMs, bj(2026, 10, 26));
  assert.equal(w.startKey, '2026-10-19');
  assert.equal(w.endKey, '2026-10-26');
  assert.equal(w.timezone, TIMEZONE);
  assert.equal(w.weekStart, 1);
  assert.equal(w.calendarVersion, CALENDAR_VERSION);
  // Monday 00:00 itself is inside the new week; one ms earlier is the old one.
  assert.equal(windowFor('week', bj(2026, 10, 26, 0, 0)).windowKey, '2026-10-26');
  assert.equal(windowFor('week', bj(2026, 10, 26, 0, 0) - 1).windowKey, '2026-10-19');
  // The week of 2026-12-28 spills into 2027 — keys stay sortable date strings.
  const ny = windowFor('week', bj(2026, 12, 29, 12));
  assert.deepEqual([ny.startKey, ny.endKey], ['2026-12-28', '2027-01-04']);
});

test('months are Beijing natural months; December rolls the year', () => {
  assert.equal(windowFor('month', bj(2026, 10, 31, 23, 59)).windowKey, '2026-10');
  assert.equal(windowFor('month', bj(2026, 11, 1, 0, 0)).windowKey, '2026-11');
  const jan = windowFor('month', bj(2026, 12, 31, 23, 59));
  assert.equal(jan.windowKey, '2026-12');
  const next = windowFor('month', bj(2027, 1, 1, 0, 0));
  assert.equal(next.windowKey, '2027-01');
  assert.equal(next.startMs, jan.endMs); // adjacent months share the boundary, half-open
});

test("'all' has no bounds — the lifetime is the window", () => {
  const w = windowFor('all', bj(2026, 10, 24, 12));
  assert.equal(w.windowKey, 'all');
  assert.equal(w.startKey, null);
  assert.equal(w.endKey, null);
});

test('day keys and midights are the fixed UTC+8 shift, no DST', () => {
  assert.equal(beijingDayKey(Date.UTC(2026, 9, 24, 15, 59)), '2026-10-24');
  assert.equal(beijingDayKey(Date.UTC(2026, 9, 24, 16, 0)), '2026-10-25'); // UTC 16:00 = Beijing midnight
  assert.equal(beijingDayKey('nope'), null);
  assert.equal(beijingMidnight(bj(2026, 10, 24, 23, 30)), bj(2026, 10, 24));
});

test('ranking: 1,1,3 with the public id as the stable tie-break', () => {
  const rows = [
    { publicMemberId: 'bbb', totalMs: 90 },
    { publicMemberId: 'zzz', totalMs: 100 },
    { publicMemberId: 'aaa', totalMs: 100 },
    { publicMemberId: 'ccc', totalMs: 80 },
    { publicMemberId: 'ddd', totalMs: 0 }
  ];
  const ranked = rankRows(rows);
  assert.deepEqual(ranked.map(r => [r.publicMemberId, r.rank]), [
    ['aaa', 1], ['zzz', 1], ['bbb', 3], ['ccc', 4], ['ddd', 5]
  ]);
  // Pure: the caller's array is untouched.
  assert.equal(rows[0].publicMemberId, 'bbb');
  assert.equal(rows[0].rank, undefined);
});

test('an invalid window type is a programming error, answered as null', () => {
  assert.equal(windowFor('quarter', Date.now()), null);
});
