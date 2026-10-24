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
  fs.writeFileSync(file + '.lock', String(child.pid));
  const first = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
  assert.equal(first.warmup().code, 'second-writer');

  child.kill('SIGKILL');
  await new Promise(r => child.on('exit', r));
  const second = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
  assert.equal(second.warmup().ok, true, 'a stale lock from a crash does not wedge the feature');
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
