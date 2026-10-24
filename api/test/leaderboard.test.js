/* The leaderboard server half, driven at both layers: the domain with an injected clock (so
 * week and month edges are pinned, not lucky), and the routes with the fake req/res pattern
 * the coach tests use — the layer server.js actually wires. The LB acceptance numbers map to
 * the PRD: LB-02 same window for all, LB-03 no-app cross-period recompute, LB-04 concurrent
 * and stale reports, LB-05 no daily detail out, LB-06 like idempotency and window separation,
 * LB-08 withdrawal keeps received cheers, LB-09 admin suspension. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSharedStore } from '../community/store.js';
import { createLeaderboard, LeaderboardError, DISCLOSURE_VERSION } from '../community/leaderboard.js';
import { leaderboardRoutes } from '../community/leaderboard-routes.js';
import { beijingDayKey } from '../community/windows.js';

const bj = (y, m, d, h = 0, min = 0) => Date.UTC(y, m - 1, d, h - 8, min);
const MIN = 60000;
const DAY = 86400000;

/* ------------------------------- the domain, clocked ------------------------------- */

function domainFixture(startAt = bj(2026, 10, 22, 10)) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lb-test-')), 'leaderboard.json');
  const store = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {}, likes: {}, adminActions: [] }) });
  let clock = startAt;
  const lb = createLeaderboard({ store, now: () => clock });
  const setClock = t => { clock = t; };
  return { lb, store, setClock, clock: () => clock };
}

const reportBody = (over = {}) => ({
  schemaVersion: 1, algorithmVersion: 1, calendarVersion: 1,
  consentVersion: 1, baseReportRev: 0, requestId: 'r1',
  dataAsOf: bj(2026, 10, 22, 9),
  coverageStart: '2026-10-12', coverageEnd: '2026-10-22',
  days: [{ date: '2026-10-20', gymMs: 60 * MIN, syncedMs: 15 * MIN, gymSessions: 1, syncedSessions: 1 }],
  lifetime: { gymMs: 3 * 60 * MIN, syncedMs: 30 * MIN, gymSessions: 3, syncedSessions: 2 },
  ...over
});

const join = (lb, uid, base = 0, over = {}) => lb.consent(uid, { enabled: true, disclosureVersion: DISCLOSURE_VERSION, baseConsentVersion: base, displayName: uid, ...over });
const rejects = (p, status, code) => assert.rejects(p, e => e instanceof LeaderboardError && e.status === status && e.code === code);

test('join stores an identity once; a rejoin reuses it (stable tie-break, Q05)', async () => {
  const { lb } = domainFixture();
  await join(lb, 'u1');
  const firstId = lb.me('u1').publicMemberId;
  assert.ok(firstId);
  await lb.consent('u1', { enabled: false, baseConsentVersion: 1 });
  await join(lb, 'u1', 2);
  assert.equal(lb.me('u1').publicMemberId, firstId);
});

test('consent: a stale base version is refused — an offline device cannot undo a withdrawal (LB-04)', async () => {
  const { lb } = domainFixture();
  await join(lb, 'u1');
  const seq = lb.me('u1').consentVersion;
  await lb.consent('u1', { enabled: false, baseConsentVersion: seq });
  // The phone that never saw the withdrawal still holds consentVersion = seq.
  await rejects(lb.report('u1', reportBody({ consentVersion: seq })), 403, 'not-participating');
  await rejects(lb.consent('u1', { enabled: true, disclosureVersion: DISCLOSURE_VERSION, baseConsentVersion: seq }), 409, 'consent-stale');
});

test('consent: joining under an old disclosure text is refused with the current version', async () => {
  const { lb } = domainFixture();
  await rejects(
    lb.consent('u1', { enabled: true, disclosureVersion: DISCLOSURE_VERSION - 1, baseConsentVersion: 0 }),
    409, 'disclosure-stale'
  );
  // And a member parked on an old text is hidden from the board until they re-confirm.
  const { lb: lb2, store } = domainFixture();
  await join(lb2, 'u1');
  await lb2.report('u1', reportBody({}));
  await store.txn(d => { d.members.u1.disclosureVersion = 0; });
  assert.equal(lb2.board('week', null).rows.length, 0);
});

test('report: publish, optimistic compare, requestId replay and conflict (LB-04)', async () => {
  const { lb } = domainFixture();
  await join(lb, 'u1');
  const r1 = await lb.report('u1', reportBody({}));
  assert.equal(r1.reportRev, 1);
  await rejects(lb.report('u1', reportBody({ requestId: 'r2' })), 409, 'report-stale');
  // Same requestId, same content: the same answer again, marked as a replay.
  const replay = await lb.report('u1', reportBody({ baseReportRev: 99 })); // base ignored for a replay
  assert.deepEqual([replay.reportRev, replay.replayed], [1, true]);
  // Same requestId, different content: a conflict, never a silent second publish.
  await rejects(lb.report('u1', reportBody({ days: [] })), 409, 'request-conflict');
  const r2 = await lb.report('u1', reportBody({ requestId: 'r3', baseReportRev: 1 }));
  assert.equal(r2.reportRev, 2);
});

test('report: validation — coverage, future days, junk fields, wrong versions', async () => {
  const { lb } = domainFixture(bj(2026, 10, 22, 10));
  await join(lb, 'u1');
  await rejects(lb.report('u1', reportBody({ requestId: 'r-cov', coverageStart: '2026-07-01' })), 400, 'coverage-too-wide');
  await rejects(lb.report('u1', reportBody({ requestId: 'r-fut', days: [{ date: '2026-10-23', gymMs: 1, syncedMs: 0, gymSessions: 1, syncedSessions: 0 }] })), 400, 'future-date');
  await rejects(lb.report('u1', reportBody({ requestId: 'r-neg', days: [{ date: '2026-10-20', gymMs: -5, syncedMs: 0, gymSessions: 1, syncedSessions: 0 }] })), 400, 'day-field');
  await rejects(lb.report('u1', reportBody({ requestId: 'r-big', days: [{ date: '2026-10-20', gymMs: 1, syncedMs: 0, gymSessions: 1e9, syncedSessions: 0 }] })), 400, 'day-field');
  await rejects(lb.report('u1', reportBody({ requestId: 'r-lt', lifetime: { gymMs: 1, syncedMs: 0, gymSessions: 1, syncedSessions: 'x' } })), 400, 'lifetime-field');
  await rejects(lb.report('u1', reportBody({ requestId: 'r-ver', schemaVersion: 9 })), 409, 'version-stale');
  await rejects(lb.report('u1', reportBody({ requestId: 'r-cons', consentVersion: 7 })), 409, 'consent-stale');
  // A day outside the declared coverage is dropped, not stored.
  await lb.report('u1', reportBody({ requestId: 'rx', days: [
    { date: '2026-10-20', gymMs: 60 * MIN, syncedMs: 0, gymSessions: 1, syncedSessions: 0 },
    { date: '2026-10-10', gymMs: 60 * MIN, syncedMs: 0, gymSessions: 1, syncedSessions: 0 } // before coverageStart
  ] }));
  const board = lb.board('week', null);
  assert.equal(board.rows[0].gymMs, 60 * MIN, 'only the in-coverage day counted');
});

test('board: same window for everyone, summed from buckets — no app open needed (LB-02/LB-03)', async () => {
  const { lb, setClock } = domainFixture(bj(2026, 10, 22, 10)); // Thursday, week of 10-19
  await join(lb, 'u1');
  await lb.report('u1', reportBody({}));
  // The week rolls over with nobody publishing: the old week's hour simply is not in the new one.
  setClock(bj(2026, 10, 27, 10)); // next week
  const w = lb.board('week', null);
  assert.equal(w.rows.length, 1);
  assert.equal(w.rows[0].gymMs, 0);
  assert.equal(w.rows[0].dataAsOf, reportBody().dataAsOf); // freshness, not a silent refresh
  const m = lb.board('month', null);
  assert.equal(m.rows[0].gymMs, 60 * MIN); // October still holds it
});

test('board: all reads the lifetime, week/month read their buckets; ties are 1,1,3 (LB-05)', async () => {
  const { lb } = domainFixture();
  await join(lb, 'u1');
  await lb.report('u1', reportBody({}));
  await join(lb, 'u2');
  await lb.report('u2', reportBody({
    requestId: 'u2r', consentVersion: 1,
    days: [{ date: '2026-10-21', gymMs: 75 * MIN, syncedMs: 0, gymSessions: 1, syncedSessions: 0 }],
    lifetime: { gymMs: 4 * 60 * MIN, syncedMs: 0, gymSessions: 4, syncedSessions: 0 }
  }));
  const all = lb.board('all', null);
  assert.deepEqual(all.rows.map(r => [r.publicMemberId, r.totalMs, r.rank]).sort((a, b) => a[2] - b[2]),
    all.rows.map(r => [r.publicMemberId, r.totalMs, r.rank])); // ranked order
  assert.equal(all.rows[0].totalMs, 240 * MIN); // lifetime, not a re-sum of the 93 buckets
  assert.deepEqual(all.rows.map(r => r.rank), [1, 2]);
  // A tie in the week: u2 has 75, u1 60+15=75 — both rank 1.
  const week = lb.board('week', null);
  assert.deepEqual(week.rows.map(r => r.rank), [1, 1]);
  // DTO whitelist: exactly these keys, nothing internal.
  assert.deepEqual(Object.keys(week.rows[0]).sort(), [
    'dataAsOf', 'displayName', 'emoji', 'gymMs', 'gymSessions', 'likeCount',
    'publicMemberId', 'rank', 'syncedMs', 'syncedSessions', 'totalMs', 'viewerLiked'
  ]);
});

test('likes: idempotent, window-separated, self-refused, period-expired refused (LB-06)', async () => {
  const { lb, setClock } = domainFixture(bj(2026, 10, 22, 10));
  await join(lb, 'u1');
  await lb.report('u1', reportBody({}));
  await join(lb, 'u2');
  const target = lb.me('u1').publicMemberId;
  const weekKey = '2026-10-19';
  const a = await lb.like({ actorUid: 'u2', targetPublicId: target, windowType: 'week', windowKey: weekKey, on: true });
  assert.deepEqual([a.liked, a.likeCount], [true, 1]);
  await lb.like({ actorUid: 'u2', targetPublicId: target, windowType: 'week', windowKey: weekKey, on: true }); // repeat: free
  const month = await lb.like({ actorUid: 'u2', targetPublicId: target, windowType: 'month', windowKey: '2026-10', on: true });
  const allTime = await lb.like({ actorUid: 'u2', targetPublicId: target, windowType: 'all', windowKey: 'all', on: true });
  assert.deepEqual([month.likeCount, allTime.likeCount], [1, 1]); // separate counters, not a sum
  assert.equal(lb.board('week', 'u2').rows.find(r => r.publicMemberId === target).viewerLiked, true);
  assert.equal(lb.board('week', null).rows.find(r => r.publicMemberId === target).viewerLiked, false);
  await rejects(lb.like({ actorUid: 'u1', targetPublicId: target, windowType: 'week', windowKey: weekKey, on: true }), 403, 'self');
  await rejects(lb.like({ actorUid: 'u2', targetPublicId: 'nope', windowType: 'week', windowKey: weekKey, on: true }), 404, 'no-such-member');
  // The week rolls: the old key now answers 409 with the current one.
  setClock(bj(2026, 10, 27, 10));
  await rejects(lb.like({ actorUid: 'u2', targetPublicId: target, windowType: 'week', windowKey: weekKey, on: true }), 409, 'window-expired');
  // And unlike works through the same window the like lives in (expired for the old week —
  // remove it before the roll instead, which is what a client actually does).
});

test('withdrawal hides but keeps received cheers; rejoining restores them (LB-08, Q05)', async () => {
  const { lb } = domainFixture(bj(2026, 10, 22, 10));
  await join(lb, 'u1');
  await lb.report('u1', reportBody({}));
  await join(lb, 'u2');
  const target = lb.me('u1').publicMemberId;
  await lb.like({ actorUid: 'u2', targetPublicId: target, windowType: 'week', windowKey: '2026-10-19', on: true });
  await lb.like({ actorUid: 'u2', targetPublicId: target, windowType: 'all', windowKey: 'all', on: true });

  await lb.consent('u1', { enabled: false, baseConsentVersion: 1 });
  assert.equal(lb.board('week', 'u2').rows.some(r => r.publicMemberId === target), false, 'the withdrawn member is gone');
  await rejects(lb.like({ actorUid: 'u2', targetPublicId: target, windowType: 'month', windowKey: '2026-10', on: true }), 404, 'no-such-member');

  await join(lb, 'u1', 2);
  const seq = lb.me('u1').consentVersion;
  await lb.report('u1', reportBody({ requestId: 'again', consentVersion: seq }));
  const week = lb.board('week', 'u2').rows.find(r => r.publicMemberId === target);
  assert.equal(week.likeCount, 1); // the cheer from before the withdrawal is back
  assert.equal(lb.board('all', 'u2').rows.find(r => r.publicMemberId === target).likeCount, 1);
});

test('admin suspension: reasoned, idempotent, survives rejoin, touches nothing personal (LB-09, Q20)', async () => {
  const { lb } = domainFixture();
  await join(lb, 'u1');
  await lb.report('u1', reportBody({}));
  await rejects(lb.adminStatus({ actorUid: 'admin', targetUid: 'u1', suspended: true, reason: '  ', actionId: 'a1' }), 400, 'reason-required');
  await rejects(lb.adminStatus({ actorUid: 'admin', targetUid: 'ghost', suspended: true, reason: 'x', actionId: 'a1' }), 404, 'no-such-member');
  const r1 = await lb.adminStatus({ actorUid: 'admin', targetUid: 'u1', suspended: true, reason: 'score looks off', actionId: 'a1' });
  assert.equal(r1.applied, true);
  const r2 = await lb.adminStatus({ actorUid: 'admin', targetUid: 'u1', suspended: true, reason: 'score looks off', actionId: 'a1' });
  assert.equal(r2.applied, false); // idempotent by actionId
  assert.equal(lb.board('week', null).rows.length, 0);
  assert.equal(lb.me('u1').suspended, true);
  await rejects(lb.report('u1', reportBody({ requestId: 'r9' })), 403, 'suspended');
  // Rejoin does not launder the suspension.
  await lb.consent('u1', { enabled: false, baseConsentVersion: 1 });
  await join(lb, 'u1', 2);
  assert.equal(lb.me('u1').suspended, true);
  await rejects(lb.report('u1', reportBody({ requestId: 'r10', consentVersion: lb.me('u1').consentVersion })), 403, 'suspended');
  const off = await lb.adminStatus({ actorUid: 'admin', targetUid: 'u1', suspended: false, actionId: 'a2' });
  assert.equal(off.applied, true);
  await lb.report('u1', reportBody({ requestId: 'r11', consentVersion: lb.me('u1').consentVersion })); // publishing works again
  assert.equal(lb.board('week', null).rows.length, 1);
});

test('forget: account deletion removes the member and every like relationship, both directions', async () => {
  const { lb } = domainFixture(bj(2026, 10, 22, 10));
  await join(lb, 'u1');
  await lb.report('u1', reportBody({}));
  await join(lb, 'u2');
  await join(lb, 'u3');
  const target = lb.me('u1').publicMemberId;
  const key = '2026-10-19';
  await lb.like({ actorUid: 'u2', targetPublicId: target, windowType: 'week', windowKey: key, on: true });
  await lb.like({ actorUid: 'u1', targetPublicId: lb.me('u3').publicMemberId, windowType: 'week', windowKey: key, on: true });
  const r = await lb.forget('u1');
  assert.deepEqual(r, { removed: true });
  assert.equal(lb.board('week', null).rows.some(x => x.publicMemberId === target), false);
  assert.equal(lb.me('u1').enabled, false);
  assert.equal((await lb.forget('u1')).removed, false); // idempotent
  // u3's row lost u1's cheer; u2's own cheer to u1 is gone with the member.
  const u3row = lb.board('week', null).rows.find(x => x.publicMemberId === lb.me('u3').publicMemberId);
  assert.equal(u3row.likeCount, 0);
});

test('concurrent reports and likes serialize through the store queue', async () => {
  const { lb } = domainFixture();
  await join(lb, 'u1');
  await join(lb, 'u2');
  await join(lb, 'u3');
  const target = lb.me('u1').publicMemberId;
  const weekKey = lb.board('week', null).window.windowKey;
  await Promise.all([
    lb.report('u1', reportBody({})),
    lb.report('u2', reportBody({ requestId: 'u2' })),
    lb.report('u3', reportBody({ requestId: 'u3' })),
    lb.like({ actorUid: 'u2', targetPublicId: target, windowType: 'week', windowKey: weekKey, on: true }),
    lb.like({ actorUid: 'u3', targetPublicId: target, windowType: 'week', windowKey: weekKey, on: true })
  ]);
  const week = lb.board('week', null);
  assert.equal(week.rows.length, 3);
  assert.equal(week.rows.find(r => r.publicMemberId === target).likeCount, 2);
});

/* --------------------------------- the routes layer --------------------------------- */

function routeFixture({ publicRead = true } = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lb-routes-')), 'leaderboard.json');
  const store = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {}, likes: {}, adminActions: [] }) });
  const domain = createLeaderboard({ store });
  const audited = [];
  const users = {
    alice: { id: 'alice', name: 'Alice' }, bob: { id: 'bob', name: 'Bob' },
    carol: { id: 'carol', name: 'Carol' }, dave: { id: 'dave', name: 'Dave' },
    erin: { id: 'erin', name: 'Erin' }, frank: { id: 'frank', name: 'Frank' }
  };
  const routes = leaderboardRoutes({
    domain,
    json: (res, code, obj, headers) => { res.status = code; res.body = obj; res.headers = headers; },
    readBody: async req => req._body || {},
    readSession: req => req._user || null,
    requireAdmin: (req, res) => {
      if (req._user?.admin) return req._user;
      res.status = 403; res.body = { error: 'forbidden' };
      return null;
    },
    audit: (req, event, data) => audited.push([event, data]),
    publicRead
  });
  const call = async (route, { body, user, url } = {}) => {
    const res = {};
    const req = { _body: body, _user: user, url: url || (route.startsWith('GET') ? route.split(' ')[1] : route.split(' ')[1]) };
    await routes[route](req, res);
    return res;
  };
  return { routes, call, audited, users, store };
}

test('routes: auth, guest gating, error shape, rate limit, audit', async () => {
  const { call, audited, users } = routeFixture();
  // Guest on a closed instance: 401. On an open one: rows without viewerLiked.
  const closed = routeFixture({ publicRead: false });
  assert.equal((await closed.call('GET /api/leaderboard', {})).status, 401);
  const guest = await call('GET /api/leaderboard', { url: '/api/leaderboard?window=week' });
  assert.equal(guest.status, 200);
  for (const row of guest.body.rows) assert.equal('viewerLiked' in row, false);

  // Not signed in on member routes.
  assert.equal((await call('PUT /api/leaderboard/consent', { body: { enabled: true } })).status, 401);
  assert.equal((await call('GET /api/leaderboard/me', {})).status, 401);

  // Alice joins, publishes, appears.
  assert.equal((await call('PUT /api/leaderboard/consent', { body: { enabled: true, disclosureVersion: DISCLOSURE_VERSION, baseConsentVersion: 0 }, user: users.alice })).status, 200);
  const today = beijingDayKey(Date.now());
  assert.equal((await call('PUT /api/leaderboard/report', {
    user: users.alice,
    body: {
      schemaVersion: 1, algorithmVersion: 1, calendarVersion: 1, consentVersion: 1,
      baseReportRev: 0, requestId: 'q1', dataAsOf: Date.now(),
      coverageStart: today, coverageEnd: today,
      days: [{ date: today, gymMs: 60000, syncedMs: 0, gymSessions: 1, syncedSessions: 0 }],
      lifetime: { gymMs: 60000, syncedMs: 0, gymSessions: 1, syncedSessions: 0 }
    }
  })).status, 200);
  const mine = await call('GET /api/leaderboard/me', { user: users.alice });
  assert.equal(mine.body.enabled, true);

  // Bad window answers 400 with a code, and joins/withdrawals land in the audit log.
  assert.equal((await call('GET /api/leaderboard', { url: '/api/leaderboard?window=quarter', user: users.alice })).body.code, 'window');
  assert.ok(audited.some(([e]) => e === 'leaderboard.join'));

  // Bob cannot admin; the admin (Alice, flagged) can suspend with an actionId.
  assert.equal((await call('PUT /api/admin/leaderboard/member-status', { body: { targetUid: 'bob', suspended: true, reason: 'x', actionId: 'z1' }, user: users.bob })).status, 403);
  const admin = { ...users.alice, admin: true };
  assert.equal((await call('PUT /api/admin/leaderboard/member-status', { body: { targetUid: 'alice', suspended: false, actionId: 'z2' }, user: admin })).status, 200);
  assert.ok(audited.some(([e]) => e === 'leaderboard.admin.status'));

  // Like rate limit: 30 per minute per account, then 429 with Retry-After.
  assert.equal((await call('PUT /api/leaderboard/consent', { body: { enabled: true, disclosureVersion: DISCLOSURE_VERSION, baseConsentVersion: 0 }, user: users.bob })).status, 200);
  const me = await call('GET /api/leaderboard/me', { user: users.alice });
  const target = me.body.publicMemberId;
  const key = guest.body.window.windowKey; // the server's own current week, not a local guess
  let last = null;
  for (let i = 0; i < 32; i++) {
    last = await call('PUT /api/leaderboard/like', { user: users.bob, body: { targetPublicId: target, windowType: 'week', windowKey: key } });
  }
  assert.equal(last.status, 429);
  assert.ok(last.headers && last.headers['Retry-After']);
});

/* ----------------- batch-5 regressions: capacity, limits, validation ----------------- */

test('R13: a lifetime of 1001+ sessions publishes; the day cap still applies per day', async () => {
  const { lb } = domainFixture();
  await join(lb, 'u1');
  const big = await lb.report('u1', reportBody({
    requestId: 'big',
    lifetime: { gymMs: 3600000, syncedMs: 0, gymSessions: 1001, syncedSessions: 0 }
  }));
  assert.equal(big.reportRev, 1);
  assert.equal(lb.board('all', null).rows[0].gymSessions, 1001);
  await rejects(lb.report('u1', reportBody({
    requestId: 'big2', baseReportRev: 1,
    days: [{ date: '2026-10-20', gymMs: 1, syncedMs: 0, gymSessions: 1001, syncedSessions: 0 }]
  })), 400, 'day-field');
});

test('S08: an unknown calendar version is a conflict, never reinterpreted', async () => {
  const { lb } = domainFixture();
  await join(lb, 'u1');
  await rejects(lb.report('u1', reportBody({ requestId: 'cal', calendarVersion: 99 })), 409, 'version-stale');
});

test('S09: dates must survive the calendar round trip — Feb 30 and friends are refused', async () => {
  const { lb } = domainFixture(bj(2026, 10, 22, 10));
  await join(lb, 'u1');
  const day = (d, rq) => lb.report('u1', reportBody({ requestId: rq, days: [{ date: d, gymMs: 1, syncedMs: 0, gymSessions: 1, syncedSessions: 0 }] }));
  await rejects(day('2026-02-30', 'd1'), 400, 'day-key');   // normalizes to Mar 2 — not a real day
  await rejects(day('2027-02-29', 'd2'), 400, 'day-key');   // 2027 is not a leap year
  await rejects(day('2026-13-01', 'd3'), 400, 'day-key');
  await rejects(lb.report('u1', reportBody({ requestId: 'd4', coverageStart: '2026-02-30' })), 400, 'coverage');
  const leap = await day('2024-02-29', 'd5');               // a real leap day (past) passes
  assert.equal(leap.reportRev, 1);
});

test('S07: expired week/month cheers are pruned past a working-set size; current and all-time stay', async () => {
  const { lb, store } = domainFixture(bj(2026, 10, 22, 10)); // week of 2026-10-19
  await join(lb, 'u1');
  await join(lb, 'u2');
  await lb.report('u1', reportBody({}));
  const target = lb.me('u1').publicMemberId;
  // 2000 expired cheers (last week / last month), plus the ones that must survive.
  await store.txn(d => {
    for (let i = 0; i < 1000; i++) d.likes[`actor${i}|u1|week|2026-10-12`] = { createdAt: 1 };
    for (let i = 1000; i < 2000; i++) d.likes[`actor${i}|u1|month|2026-09`] = { createdAt: 1 };
  });
  await lb.like({ actorUid: 'u2', targetPublicId: target, windowType: 'week', windowKey: '2026-10-19', on: true });
  await lb.like({ actorUid: 'u2', targetPublicId: target, windowType: 'all', windowKey: 'all', on: true });
  const data = store.read();
  assert.equal(data.likes['u2|u1|week|2026-10-12'], undefined, 'the expired week cheer is gone');
  assert.equal(Object.keys(data.likes).some(k => k.endsWith('|month|2026-09')), false, 'the expired month cheers are gone');
  assert.ok(data.likes['u2|u1|week|2026-10-19'], 'the current week cheer stays');
  assert.ok(data.likes['u2|u1|all|all'], 'the all-time cheer stays');
  assert.equal(lb.board('week', null).rows.find(r => r.publicMemberId === target).likeCount, 1);
});

test('S06: a burst of accounts from one address hits the IP budget, not just their own', async () => {
  const { call, users } = routeFixture();
  for (const who of [users.alice, users.bob, users.carol, users.dave, users.erin]) {
    assert.equal((await call('PUT /api/leaderboard/consent', { body: { enabled: true, disclosureVersion: DISCLOSURE_VERSION, baseConsentVersion: 0 }, user: who })).status, 200);
  }
  const me = await call('GET /api/leaderboard/me', { user: users.alice });
  const target = me.body.publicMemberId;
  const key = (await call('GET /api/leaderboard', { url: '/api/leaderboard?window=week' })).body.window.windowKey;
  let last = null;
  for (const who of [users.bob, users.carol, users.dave, users.erin, users.frank]) {
    for (let i = 0; i < 24; i++) {
      last = await call('PUT /api/leaderboard/like', { user: who, body: { targetPublicId: target, windowType: 'week', windowKey: key } });
    }
  }
  // 5 accounts x 24 = 120 from one address: at the budget. frank's account is fresh, but the
  // address is not — his 24 went through while the earlier four filled it; the 121st from any
  // fresh account must refuse on the IP budget alone.
  const fresh = { id: 'grace', name: 'Grace' };
  const refused = await call('PUT /api/leaderboard/like', { user: fresh, body: { targetPublicId: target, windowType: 'week', windowKey: key } });
  assert.equal(refused.status, 429);
  assert.equal(refused.body.code, 'rate');
});

test('R06: 500 members and 100k cheers answer a board read in well under a second', async () => {
  const { lb, store } = domainFixture(bj(2026, 10, 22, 10));
  await store.txn(d => {
    for (let i = 0; i < 500; i++) {
      const uid = 'm' + i;
      d.members[uid] = {
        publicMemberId: 'pub' + i, displayName: 'M' + i, emoji: '💪', enabled: true,
        disclosureVersion: 1, consentSeq: 1, reportSeq: 1, reportRequests: {},
        suspended: false, suspendedReason: null, suspendedAt: null,
        days: { '2026-10-20': { gymMs: 3600000 + i, syncedMs: 0, gymSessions: 1, syncedSessions: 0 } },
        lifetime: { gymMs: 3600000, syncedMs: 0, gymSessions: 1, syncedSessions: 0 }, dataAsOf: 1
      };
    }
    for (let i = 0; i < 100000; i++) {
      d.likes[`actor${i}|m${i % 500}|week|2026-10-19`] = { createdAt: 1 };
    }
  });
  const t0 = process.hrtime.bigint();
  const board = lb.board('week', 'm0');
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(board.rows.length, 500);
  assert.equal(board.rows[0].likeCount, 200);
  assert.ok(ms < 500, `board read took ${ms}ms — the per-member scan is back`);
});

/* ------------------------- S01/S02/S05: identity and admin list ------------------------- */

test('profile: the member sets their own public name and a controlled emoji', async () => {
  const { lb } = domainFixture();
  await join(lb, 'u1');
  const out = await lb.profile('u1', { displayName: '  Night Owl  ', emoji: '🔥' });
  assert.deepEqual(out, { displayName: 'Night Owl', emoji: '🔥' });
  assert.equal(lb.board('week', null).rows[0].displayName, 'Night Owl');
  assert.equal(lb.board('week', null).rows[0].emoji, '🔥');
  await rejects(lb.profile('u1', { emoji: '🙋' }), 400, 'emoji');       // not in the controlled set
  await rejects(lb.profile('u1', { displayName: 'x'.repeat(41) }), 400, 'display-name');
  // An empty name is the anonymous fallback, not an error.
  assert.equal((await lb.profile('u1', { displayName: '' })).displayName, '');
  // Someone who never joined has nothing to style.
  await rejects(lb.profile('ghost', { emoji: '🔥' }), 403, 'not-participating');
});

test('adminMembers: identity and status per joined member, nothing else', async () => {
  const { lb } = domainFixture();
  await join(lb, 'u1');
  await lb.report('u1', reportBody({}));
  await join(lb, 'u2');
  await lb.adminStatus({ actorUid: 'admin', targetUid: 'u2', suspended: true, reason: 'check', actionId: 'x1' });
  const members = lb.adminMembers();
  assert.equal(members.length, 2);
  const u2 = members.find(m => m.uid === 'u2');
  assert.deepEqual(Object.keys(u2).sort(), ['displayName', 'emoji', 'enabled', 'publicMemberId', 'suspended', 'suspendedReason', 'uid']);
  assert.equal(u2.suspended, true);
  assert.equal(u2.suspendedReason, 'check');
});
