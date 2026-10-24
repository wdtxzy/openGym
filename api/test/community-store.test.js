/* The transactional core under leaderboard.json and social.json.
 *
 * Everything the community features share a file for stands or falls here: mutations are
 * serialized (two interleaved likes cannot lose each other), a failed write leaves file and
 * cache exactly where they were, a damaged file is refused rather than re-initialized over
 * (the PRD keeps it for the operator to look at), and a second live API process on the same
 * data directory is turned away by the PID lock. The failing writer is injected — the point
 * is the contract, not this disk. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSharedStore, StoreError } from '../community/store.js';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'community-store-'));

function makeStore(opts = {}) {
  return createSharedStore({
    file: path.join(dir(), 'shared.json'),
    schemaVersion: 1,
    init: () => ({ members: {} }),
    ...opts
  });
}

test('a missing file is initialized with the given shape and revision 0', () => {
  const file = path.join(dir(), 'shared.json');
  const s = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
  const r = s.warmup();
  assert.equal(r.ok, true);
  assert.equal(r.revision, 0);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.schemaVersion, 1);
  assert.equal(onDisk.revision, 0);
  assert.deepEqual(onDisk.members, {});
});

test('a txn mutates, bumps the revision, persists, and read() returns a private copy', async () => {
  const file = path.join(dir(), 'shared.json');
  const s = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
  const { revision, out } = await s.txn(d => { d.members.alice = { likes: 1 }; return 'done'; });
  assert.equal(out, 'done');
  assert.equal(revision, 1);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).members.alice.likes, 1);
  // A caller cannot reach the cache through a read: mutating the copy changes nothing.
  const copy = s.read();
  copy.members.alice.likes = 99;
  assert.equal(s.read().members.alice.likes, 1);
  assert.equal(s.read().revision, 1);
});

test('interleaved transactions serialize — no update is lost between awaits', async () => {
  const s = makeStore();
  // Every transaction awaits inside fn: without the queue, two of them would clone the same
  // base and the slower write would erase the faster one's increment.
  const bump = n => s.txn(async d => {
    d.members.n = (d.members.n || 0) + 1;
    await new Promise(r => setTimeout(r, Math.random() * 3));
    return n;
  });
  await Promise.all(Array.from({ length: 120 }, (_, i) => bump(i)));
  assert.equal(s.read().members.n, 120);
  assert.equal(s.read().revision, 120);
});

test('a throwing fn writes nothing, keeps the revision, and does not wedge the queue', async () => {
  const file = path.join(dir(), 'shared.json');
  const s = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
  await s.txn(d => { d.members.a = 1; });
  const bytesBefore = fs.readFileSync(file, 'utf8');
  await assert.rejects(s.txn(d => { throw new Error('validation failed'); }));
  assert.equal(fs.readFileSync(file, 'utf8'), bytesBefore);
  assert.equal(s.read().revision, 1);
  const { revision } = await s.txn(d => { d.members.b = 2; });
  assert.equal(revision, 2, 'the queue survived the rejected transaction');
});

test('a failed write leaves file and cache untouched, and the next txn still runs', async () => {
  const file = path.join(dir(), 'shared.json');
  let failWrites = 0;
  const s = createSharedStore({
    file, schemaVersion: 1, init: () => ({ members: {} }),
    writer: (f, content) => {
      if (failWrites > 0) { failWrites -= 1; throw new Error('disk full (injected)'); }
      fs.writeFileSync(f, content);
    }
  });
  await s.txn(d => { d.members.a = 1; });
  const bytesBefore = fs.readFileSync(file, 'utf8');
  failWrites = 1;
  await assert.rejects(s.txn(d => { d.members.a = 2; }), e => e instanceof StoreError && e.code === 'write-failed');
  assert.equal(fs.readFileSync(file, 'utf8'), bytesBefore, 'the failed write changed nothing on disk');
  assert.equal(s.read().members.a, 1, 'the cache still matches the disk');
  assert.equal(s.read().revision, 1);
  const { revision } = await s.txn(d => { d.members.a = 3; });
  assert.equal(revision, 2);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).members.a, 3);
});

test('a corrupt file is refused, byte for byte, by both read and txn', async () => {
  const file = path.join(dir(), 'shared.json');
  fs.writeFileSync(file, '{ this is not json');
  const s = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
  assert.equal(s.warmup().code, 'corrupt');
  assert.throws(() => s.read(), e => e.code === 'corrupt');
  await assert.rejects(s.txn(d => { d.members.a = 1; }), e => e.code === 'corrupt');
  assert.equal(fs.readFileSync(file, 'utf8'), '{ this is not json', 'the damaged original survives');
});

test('an unknown schemaVersion is refused the same way', () => {
  const file = path.join(dir(), 'shared.json');
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 99, revision: 5, members: {} }));
  const s = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
  assert.equal(s.warmup().code, 'schema');
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify({ schemaVersion: 99, revision: 5, members: {} }));
});

test('a foreign live PID in the lock is refused; a dead one is taken over', async () => {
  const file = path.join(dir(), 'shared.json');
  // A real second process, so PID liveness is not faked: it outlives the refusal check.
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  await new Promise(r => child.on('spawn', r));
  fs.writeFileSync(file + '.lock', JSON.stringify({ pid: child.pid, host: os.hostname(), token: 'live-foreign' }));
  const first = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
  assert.equal(first.warmup().code, 'second-writer');
  // The refusal left the live owner's lock exactly as it was — never trampled.
  assert.deepEqual(JSON.parse(fs.readFileSync(file + '.lock', 'utf8')), { pid: child.pid, host: os.hostname(), token: 'live-foreign' });

  child.kill('SIGKILL');
  await new Promise(r => child.on('exit', r));
  const second = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
  assert.equal(second.warmup().ok, true, 'a stale lock from a crash does not wedge the feature');
  assert.equal(JSON.parse(fs.readFileSync(file + '.lock', 'utf8')).pid, process.pid);
});

test('a lock from another host (a sibling container on one volume) is honoured as live', async () => {
  const file = path.join(dir(), 'shared.json');
  // Two containers on one volume are both pid 1: a bare pid cannot tell them apart (N05) —
  // the hostname is what makes the second writer refuse.
  fs.writeFileSync(file + '.lock', JSON.stringify({ pid: process.pid, host: 'other-container', token: 't' }));
  const s = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
  assert.equal(s.warmup().code, 'second-writer');
});

test('a lock that is not readable at all is stale garbage, taken over', () => {
  const file = path.join(dir(), 'shared.json');
  // Both flavours of garbage: not JSON at all, and a bare number — which JSON.parse happily
  // returns, and which must never be mistaken for a live owner's lock.
  for (const garbage of ['not-a-pid', '99999999']) {
    fs.writeFileSync(file + '.lock', garbage);
    const s = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
    assert.equal(s.warmup().ok, true, `garbage lock ${JSON.stringify(garbage)}`);
    assert.equal(JSON.parse(fs.readFileSync(file + '.lock', 'utf8')).pid, process.pid);
  }
});

test('R07: a file that corrupts after warmup refuses both reads and writes, and survives byte for byte', async () => {
  const file = path.join(dir(), 'shared.json');
  const s = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
  await s.txn(d => { d.members.a = 1; });
  const damaged = '{ this is not json';
  fs.writeFileSync(file, damaged);
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(file, future, future); // mtime must move, or the change is invisible
  assert.throws(() => s.read(), e => e.code === 'corrupt');
  await assert.rejects(s.txn(d => { d.members.b = 2; }), e => e.code === 'corrupt');
  assert.equal(fs.readFileSync(file, 'utf8'), damaged, 'the damaged original is never overwritten from cache');
  assert.equal(s.warmup().ok, false, 'the refusal is sticky, not a one-shot');
  assert.equal(s.warmup().code, 'corrupt');
});

test('R08: an async callback is awaited — mutations after an await reach the disk', async () => {
  const file = path.join(dir(), 'shared.json');
  const s = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
  await s.txn(async d => {
    d.members.before = 1;
    await new Promise(r => setTimeout(r, 5));
    d.members.afterAwait = 1; // before this fix, the disk was already written without it
  });
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.members.afterAwait, 1);
  assert.equal(s.read().members.afterAwait, 1);
});

test('R08: an async rejection writes nothing and does not wedge the queue', async () => {
  const file = path.join(dir(), 'shared.json');
  const s = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
  await s.txn(d => { d.members.a = 1; });
  await assert.rejects(s.txn(async d => {
    d.members.b = 2;
    await new Promise(r => setTimeout(r, 5));
    throw new Error('async validation failed');
  }));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).members.b, undefined);
  const { revision } = await s.txn(d => { d.members.c = 3; });
  assert.equal(revision, 2);
});

test('R09: a failed first initialization is retried honestly, never cached as ok', () => {
  const file = path.join(dir(), 'shared.json');
  let diskFull = true;
  const mk = () => createSharedStore({
    file, schemaVersion: 1, init: () => ({ members: {} }),
    writer: (f, content) => {
      if (diskFull) throw new Error('disk full (injected)');
      fs.writeFileSync(f, content);
    }
  });
  assert.equal(mk().warmup().ok, false);
  assert.equal(mk().warmup().ok, false, 'the second warmup does not report an in-memory success');
  assert.equal(fs.existsSync(file), false);
  diskFull = false;
  assert.equal(mk().warmup().ok, true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).schemaVersion, 1);
});

test('an external rewrite of the file (operator edit) is picked up by read()', async () => {
  const file = path.join(dir(), 'shared.json');
  const s = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
  await s.txn(d => { d.members.a = 1; });
  // Supported only while stopped, in practice — this just keeps a long-lived cache from
  // answering from a snapshot the operator already replaced before this process saw it.
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, revision: 50, members: { b: 2 } }));
  const now = s.read();
  assert.equal(now.revision, 50);
  assert.deepEqual(now.members, { b: 2 });
});

test('a restart continues the revision from what is on disk', async () => {
  const file = path.join(dir(), 'shared.json');
  const first = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
  await first.txn(d => { d.members.a = 1; });
  await first.txn(d => { d.members.b = 2; });
  const second = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
  const { revision } = await second.txn(d => { d.members.c = 3; });
  assert.equal(revision, 3);
});

test('N05: a contender that lands during the takeover is captured, restored and refused — never deleted', async () => {
  const file = path.join(dir(), 'shared.json');
  const lock = file + '.lock';
  // A genuinely dead stale lock, and a genuinely live second process.
  fs.writeFileSync(lock, JSON.stringify({ pid: 99999999, host: os.hostname(), token: 'dead-token' }));
  const owner = spawn(process.execPath, ['-e', 'setInterval(()=>{},10000)'], { stdio: 'ignore' });
  await new Promise(r => owner.on('spawn', r));
  const live = JSON.stringify({ pid: owner.pid, host: os.hostname(), token: 'live-contender' });
  // The worst window: the contender replaces the lock in the instant our takeover reaches for
  // it. Hooking rename is the only place that can happen now — unlink no longer touches it.
  const rename = fs.renameSync;
  let injected = false;
  fs.renameSync = function (from, to) {
    if (from === lock && !injected) { injected = true; fs.writeFileSync(lock, live); }
    return rename(from, to);
  };
  try {
    const s = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
    assert.equal(s.warmup().code, 'second-writer');
    assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).token, 'live-contender', 'the live owner keeps the lock');
  } finally {
    fs.renameSync = rename;
    owner.kill('SIGKILL');
    await new Promise(r => owner.on('exit', r));
  }
  // With the contender gone the stale lock really is stale: a retry takes it over cleanly.
  const s2 = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
  assert.equal(s2.warmup().ok, true);
});
