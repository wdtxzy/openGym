/* The audit queue's lifecycle against the real server (round-7 I03/I07): a shared
   leaderboard.json written by the pre-pendingAudits build boots into THIS build and its
   stranded events deliver on their own; and an audit line that landed while its pending-queue
   confirmation failed is never written twice — the replay confirms it instead. Real
   server.js in a child, same harness as server-admin-delete.test.js; the confirmation
   failure is a one-shot renameSync injection in the child process only. */
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
const mintSession = uid => {
  const payload = `${uid}:${Date.now() + 86400000}:0`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
};
const ADMIN = 'u_adm_1';
const as = uid => ({ Cookie: `gymsid=${mintSession(uid)}`, 'Content-Type': 'application/json' });

function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-audit-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users: [{ id: ADMIN, name: 'Admin', created: new Date().toISOString(), admin: true }],
    creds: [], subs: [], invites: []
  }));
  fs.writeFileSync(path.join(dataDir, 'leaderboard.json'), JSON.stringify({
    schemaVersion: 1, revision: 1,
    members: {
      b: {
        enabled: true, suspended: false, disclosureVersion: 1, publicMemberId: 'pub-b',
        displayName: 'TestMember', consentSeq: 1, reportSeq: 0, reportRequests: {},
        days: {}, lifetime: { gymMs: 0, syncedMs: 0, gymSessions: 0, syncedSessions: 0 }
      }
    },
    likes: {}, adminActions: []
  }));
  return dataDir;
}

async function startServer(t, dataDir, extra = {}) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, LEADERBOARD: '1', LEADERBOARD_PUBLIC_READ: '1', ...extra },
  });
  const h = { log: '', dataDir, child };
  child.stdout.on('data', d => { h.log += d; });
  child.stderr.on('data', d => { h.log += d; });
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  h.port = await boundPort(child, () => h.log);
  h.api = `http://127.0.0.1:${h.port}`;
  return h;
}

const sharedFile = dir => JSON.parse(fs.readFileSync(path.join(dir, 'leaderboard.json'), 'utf8'));
const auditRows = dir => {
  try { return fs.readFileSync(path.join(dir, 'audit.log'), 'utf8').trim().split('\n').filter(Boolean).map(x => JSON.parse(x)); }
  catch { return []; }
};
const waitFor = async (fn, what) => {
  for (let i = 0; i < 500; i++) {
    const v = fn();
    if (v) return v;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('timed out waiting for ' + what);
};

test('I03: a legacy-format shared file delivers its stranded events on boot', async t => {
  const dir = fixture();
  // The pre-pendingAudits build: an accepted, undelivered event parked in the reviewed
  // history, and no pendingAudits at all.
  const data = sharedFile(dir);
  data.adminActions = [{ actionId: 'legacy-boot-1', at: Date.now(), actor: ADMIN, targetUid: 'b', suspended: true, reason: 'accepted before the upgrade', audited: false }];
  delete data.pendingAudits;
  fs.writeFileSync(path.join(dir, 'leaderboard.json'), JSON.stringify(data));
  const h = await startServer(t, dir);
  // The migration runs before the boot delivery pass, so the stranded event lands on its
  // own — no admin action needed.
  await waitFor(() => auditRows(dir).some(r => r.meta?.actionId === 'legacy-boot-1'), 'the legacy event to be delivered');
  assert.equal(sharedFile(dir).pendingAudits.length, 0, 'the queue drains once delivered');
  assert.equal(sharedFile(dir).auditQueueVersion, 2, 'the migration is stamped and will not rerun');
  assert.equal(sharedFile(dir).adminActions.find(a => a.actionId === 'legacy-boot-1').audited, true, 'the history copy is reviewed');
});

test('I07: a delivered line whose confirmation failed is confirmed by the retry, never re-written', async t => {
  const dir = fixture();
  // A one-shot EIO on the CONFIRMATION rename (the pending queue's final transaction) in
  // the child process only: the audit line lands, the queue confirmation does not.
  const inject = path.join(dir, 'confirm-failure.mjs');
  fs.writeFileSync(inject, `import fs from 'node:fs';import path from 'node:path';const original=fs.renameSync;let fired=false;fs.renameSync=function(a,b){if(!fired&&b===path.join(process.env.DATA_DIR,'leaderboard.json')&&String(a).includes('.commit.')){const data=JSON.parse(fs.readFileSync(a,'utf8'));if(data.adminActions?.some(x=>x.actionId==='confirm-failure')&&data.pendingAudits?.length===0){fired=true;throw Object.assign(new Error('injected confirmation rename failure'),{code:'EIO'})}}return original(a,b)};`);
  const h = await startServer(t, dir, { NODE_OPTIONS: '--import=' + inject });
  const body = { targetUid: 'b', suspended: true, reason: 'one accepted action', actionId: 'confirm-failure' };
  const put = async () => {
    const r = await fetch(`${h.api}/api/admin/leaderboard/member-status`, { method: 'PUT', headers: as(ADMIN), body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const first = await put();
  assert.equal(first.status, 200);
  assert.equal(first.body.applied, true);
  // The line is on disk; the confirmation failed — the event is still pending.
  await waitFor(() => auditRows(dir).some(r => r.meta?.actionId === 'confirm-failure'), 'the audit line to land');
  await waitFor(() => sharedFile(dir).pendingAudits?.length === 1, 'the undelivered confirmation to be visible');
  // The replay is idempotent and the SAME pipeline dedupes: one line, one confirmation.
  const replay = await put();
  assert.equal(replay.status, 200);
  assert.equal(replay.body.applied, false, 'a replay of a pending action is already applied');
  await waitFor(() => sharedFile(dir).pendingAudits?.length === 0, 'the confirmation to settle');
  const rows = auditRows(dir).filter(r => r.meta?.actionId === 'confirm-failure');
  assert.equal(rows.length, 1, 'exactly one audit event for the action: ' + JSON.stringify(rows));
  assert.equal(rows[0].meta.applied, true);
});

/* J03: a first-write migration failure must recover IN THE SAME PROCESS. The round-8
   failure: the boot catch armed a delivery-only retry loop; the migration never re-ran,
   the new queue stayed empty, the deliverer declared itself done and cleared its timer.
   One-shot EIO on the migration's final rename, then the disk heals — no restart, no new
   admin action: the unified recovery pipeline (migrate → deliver → confirm) has to finish
   the job on its own. */
test('J03: after a one-shot migration failure the running process recovers on its own', async t => {
  const dir = fixture();
  const data = sharedFile(dir);
  data.adminActions = [{ actionId: 'legacy-j03', at: Date.now(), actor: ADMIN, targetUid: 'b', suspended: true, reason: 'accepted before upgrade', audited: false }];
  delete data.pendingAudits;
  fs.writeFileSync(path.join(dir, 'leaderboard.json'), JSON.stringify(data));
  const inject = path.join(dir, 'migration-failure.mjs');
  fs.writeFileSync(inject, `import fs from 'node:fs';import path from 'node:path';let fired=false;const original=fs.renameSync;fs.renameSync=function(a,b){if(!fired&&b===path.join(process.env.DATA_DIR,'leaderboard.json')&&String(a).includes('.commit.')&&JSON.parse(fs.readFileSync(a)).auditQueueVersion===2){fired=true;throw Object.assign(new Error('injected first migration EIO'),{code:'EIO'})}return original(a,b)};`);
  const h = await startServer(t, dir, { NODE_OPTIONS: '--import=' + inject });
  // The first migration attempt failed: logged, nothing migrated, nothing delivered yet.
  await waitFor(() => h.log.includes('leaderboard audit migration failed'), 'the migration failure to be logged');
  // The same process retries the FULL pipeline — migration included — and finishes it.
  // (The queue confirmation is its own retryable transaction after the line lands, so both
  // are awaited, in order, the way a real operator would observe them.)
  await waitFor(() => auditRows(dir).some(r => r.meta?.actionId === 'legacy-j03'), 'the legacy event to be delivered');
  await waitFor(() => sharedFile(dir).pendingAudits?.length === 0, 'the delivered event to be confirmed off the queue');
  const after = sharedFile(dir);
  assert.equal(after.auditQueueVersion, 2, 'the migration stamped in the same process');
  assert.equal(after.pendingAudits.length, 0, 'the queue drained');
  assert.equal(after.adminActions.some(a => a.audited === false), false, 'no undelivered events remain in the history');
  assert.equal(auditRows(dir).filter(r => r.meta?.actionId === 'legacy-j03').length, 1, 'exactly one audit line');
});
