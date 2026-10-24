#!/usr/bin/env node
/* End-to-end smoke of the leaderboard against a real server.js child — the LB acceptance in
 * one pass: guest read (public), join under the current disclosure, publish a day bucket,
 * see the ranked row, cheer it from a second account, suspend via admin (row gone, publish
 * refused), unsuspend. Cookie signing is the same HMAC the api tests use. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-e2e-'));
const SECRET = crypto.randomBytes(32).toString('hex');
fs.writeFileSync(path.join(DIR, 'secret'), SECRET, { mode: 0o600 });
fs.writeFileSync(path.join(DIR, 'db.json'), JSON.stringify({
  users: [
    { id: 'u_a', name: 'Anna', created: new Date().toISOString(), admin: true },
    { id: 'u_b', name: 'Bruno', created: new Date().toISOString() }
  ], creds: [], subs: [], invites: []
}));

const child = spawn(process.execPath, ['server.js'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, PORT: '0', DATA_DIR: DIR, LEADERBOARD: '1', LEADERBOARD_PUBLIC_READ: '1' },
  stdio: ['ignore', 'pipe', 'inherit']
});
let log = '';
child.stdout.on('data', d => { log += d; });
const port = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('no port: ' + log)), 15000);
  child.stdout.on('data', d => { const m = /gym-api on :(\d+)/.exec(log); if (m) { clearTimeout(t); resolve(+m[1]); } });
});

const cookie = uid => {
  const p = `${uid}:${Date.now() + 86400000}:0`;
  return `gymsid=${p}.${crypto.createHmac('sha256', SECRET).update(p).digest('base64url')}`;
};
const A = { cookie: cookie('u_a') };
const B = { cookie: cookie('u_b') };
const call = async (method, p, body, who) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(who ? { cookie: who.cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const assert = (cond, what) => { if (!cond) { console.error('FAIL:', what); process.exit(1); } console.log('ok:', what); };

// Beijing "today" for the bucket.
const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);

let r = await call('GET', '/api/leaderboard?window=week', null, null);
assert(r.status === 200 && r.body.rows.length === 0, 'guest sees the empty open board');
assert(!('viewerLiked' in (r.body.rows[0] || {})), 'no viewer field for guests (vacuous but pinned)');

r = await call('GET', '/api/leaderboard/me', null, A);
assert(r.status === 200 && r.body.enabled === false, 'me starts not participating');
const dv = r.body.currentDisclosureVersion;

r = await call('PUT', '/api/leaderboard/consent', { enabled: true, disclosureVersion: dv, baseConsentVersion: r.body.consentVersion }, A);
assert(r.status === 200 && r.body.enabled === true, 'Anna joins under the current disclosure');

r = await call('PUT', '/api/leaderboard/report', {
  schemaVersion: 1, algorithmVersion: 1, calendarVersion: 1, consentVersion: r.body.consentVersion,
  baseReportRev: 0, requestId: 'e2e-1', dataAsOf: Date.now(),
  coverageStart: today, coverageEnd: today,
  days: [{ date: today, gymMs: 3600000, syncedMs: 900000, gymSessions: 1, syncedSessions: 1 }],
  lifetime: { gymMs: 3600000, syncedMs: 900000, gymSessions: 1, syncedSessions: 1 }
}, A);
assert(r.status === 200 && r.body.reportRev === 1, 'Anna publishes a day bucket');

r = await call('PUT', '/api/leaderboard/report', {
  schemaVersion: 1, algorithmVersion: 1, calendarVersion: 1, consentVersion: 1,
  baseReportRev: 0, requestId: 'e2e-2', dataAsOf: Date.now(),
  coverageStart: today, coverageEnd: today, days: [], lifetime: { gymMs: 0, syncedMs: 0, gymSessions: 0, syncedSessions: 0 }
}, A);
assert(r.status === 409 && r.body.error === 'report-stale', 'a stale base is refused with the code');

r = await call('GET', '/api/leaderboard?window=week', null, null);
assert(r.status === 200 && r.body.rows.length === 1 && r.body.rows[0].gymMs === 3600000, 'the board shows Anna\'s hour');
const pub = r.body.rows[0].publicMemberId;
const key = r.body.window.windowKey;

r = await call('PUT', '/api/leaderboard/like', { targetPublicId: pub, windowType: 'week', windowKey: key }, B);
assert(r.status === 200 && r.body.likeCount === 1, 'Bruno cheers Anna');

r = await call('PUT', '/api/leaderboard/like', { targetPublicId: pub, windowType: 'week', windowKey: '2001-01-01' }, B);
assert(r.status === 409 && r.body.error === 'window-expired', 'an expired window key answers 409');

r = await call('PUT', '/api/admin/leaderboard/member-status', { targetUid: 'u_a', suspended: true, reason: 'e2e check', actionId: 'e2e-a1' }, A);
assert(r.status === 200 && r.body.applied === true, 'admin suspends Anna (reasoned)');
r = await call('PUT', '/api/admin/leaderboard/member-status', { targetUid: 'u_a', suspended: true, reason: 'e2e check', actionId: 'e2e-a1' }, A);
assert(r.status === 200 && r.body.applied === false, 'the same actionId is idempotent');

r = await call('GET', '/api/leaderboard?window=week', null, null);
assert(r.rows === undefined && r.body.rows.length === 0, 'suspension hides Anna from the board');
r = await call('PUT', '/api/leaderboard/report', {
  schemaVersion: 1, algorithmVersion: 1, calendarVersion: 1, consentVersion: 1, baseReportRev: 1,
  requestId: 'e2e-3', dataAsOf: Date.now(), coverageStart: today, coverageEnd: today, days: [],
  lifetime: { gymMs: 1, syncedMs: 0, gymSessions: 0, syncedSessions: 0 }
}, A);
assert(r.status === 403 && r.body.error === 'suspended', 'suspended members cannot publish');

r = await call('PUT', '/api/admin/leaderboard/member-status', { targetUid: 'u_a', suspended: false, actionId: 'e2e-a2' }, A);
assert(r.status === 200, 'admin restores Anna');
r = await call('GET', '/api/leaderboard?window=week', null, B);
assert(r.body.rows.length === 1 && r.body.rows[0].likeCount === 1 && r.body.rows[0].viewerLiked === true, 'back on the board, cheer intact, Bruno sees his own cheer');

child.kill('SIGKILL');
fs.rmSync(DIR, { recursive: true, force: true });
console.log('\nE2E OK — all leaderboard acceptance steps passed against the real server.');
