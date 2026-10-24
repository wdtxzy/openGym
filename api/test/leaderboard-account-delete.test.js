/* R02 against the real server: deleting an account removes the person from the shared
 * leaderboard — name, totals and like relationships — before the personal files go, and a
 * failure there aborts the delete so it can be retried. What the review found instead: the
 * delete route cleaned db/state/uploads and left the member row public forever, with no way
 * left for the deleted member to withdraw. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = crypto.randomBytes(32).toString('hex');

const cookie = uid => {
  const p = `${uid}:${Date.now() + 86400000}:0`;
  return `gymsid=${p}.${crypto.createHmac('sha256', SECRET).update(p).digest('base64url')}`;
};

test('deleting a member clears the public leaderboard and their like relationships', async t => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-lbdel-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  fs.writeFileSync(path.join(d, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(d, 'db.json'), JSON.stringify({
    users: [
      { id: 'admin1', name: 'Ada', created: new Date().toISOString(), admin: true },
      { id: 'u_b', name: 'Bruno', created: new Date().toISOString() },
      { id: 'u_c', name: 'Carla', created: new Date().toISOString() }
    ], creds: [], subs: [], invites: []
  }));

  const child = spawn(process.execPath, ['server.js'], { cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: d, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost', LEADERBOARD: '1', LEADERBOARD_PUBLIC_READ: '1' } });
  t.after(() => child.kill('SIGKILL'));
  const log = { text: '' };
  child.stdout.on('data', x => { log.text += x; });
  child.stderr.on('data', x => { log.text += x; });
  const port = await boundPort(child, () => log.text);

  const call = async (method, p, body, who) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: { 'content-type': 'application/json', ...(who ? { cookie: who.cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const ADMIN = { cookie: cookie('admin1') };
  const B = { cookie: cookie('u_b') };
  const C = { cookie: cookie('u_c') };
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);

  // Bruno joins, publishes an hour; Carla joins and cheers him.
  let r = await call('PUT', '/api/leaderboard/consent', { enabled: true, disclosureVersion: 1, baseConsentVersion: 0 }, B);
  assert.equal(r.status, 200);
  r = await call('PUT', '/api/leaderboard/report', {
    schemaVersion: 1, algorithmVersion: 1, calendarVersion: 1, consentVersion: 1, baseReportRev: 0,
    requestId: 'del-1', dataAsOf: Date.now(), coverageStart: today, coverageEnd: today,
    days: [{ date: today, gymMs: 3600000, syncedMs: 0, gymSessions: 1, syncedSessions: 0 }],
    lifetime: { gymMs: 3600000, syncedMs: 0, gymSessions: 1, syncedSessions: 0 }
  }, B);
  assert.equal(r.status, 200);
  const pub = (await call('GET', '/api/leaderboard?window=all', null, null)).body.rows[0].publicMemberId;
  await call('PUT', '/api/leaderboard/consent', { enabled: true, disclosureVersion: 1, baseConsentVersion: 0 }, C);
  const win = (await call('GET', '/api/leaderboard?window=all', null, null)).body.window;
  r = await call('PUT', '/api/leaderboard/like', { targetPublicId: pub, windowType: 'all', windowKey: 'all' }, C);
  assert.equal(r.status, 200);

  // Admin deletes Bruno: the shared cleanup runs before the account goes.
  r = await call('POST', '/api/admin/user/delete', { id: 'u_b' }, ADMIN);
  assert.equal(r.status, 200);

  // A guest (and every member) no longer sees Bruno's name, totals, or identity.
  r = await call('GET', '/api/leaderboard?window=all', null, null);
  assert.equal(r.body.rows.some(x => x.publicMemberId === pub), false, 'the deleted member is gone from the public board');
  assert.equal(r.body.rows.some(x => x.displayName === 'Bruno'), false);
  r = await call('GET', '/api/leaderboard?window=all', null, C);
  assert.equal(r.body.rows.some(x => x.publicMemberId === pub), false);
  // And the shared file itself carries neither his row nor the like relationship.
  const shared = JSON.parse(fs.readFileSync(path.join(d, 'leaderboard.json'), 'utf8'));
  assert.equal(shared.members.u_b, undefined);
  assert.deepEqual(Object.keys(shared.likes), []);

  // The audit trail says what happened to whom.
  const auditText = fs.readFileSync(path.join(d, 'audit.log'), 'utf8');
  assert.match(auditText, /admin\.user\.delete/);
});
