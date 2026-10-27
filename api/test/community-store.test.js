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
import { createSharedStore, StoreError, NO_WRITE } from '../community/store.js';
import { writerWorld } from './store-writer.mjs';

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
  const { revision, out } = await s.txn(view => {
    const d = view.edit(); d.members.alice = { likes: 1 }; return 'done'; });
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
  const bump = n => s.txn(async view => {
    const d = view.edit();
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
  await s.txn(view => {
    const d = view.edit(); d.members.a = 1; });
  const bytesBefore = fs.readFileSync(file, 'utf8');
  await assert.rejects(s.txn(view => {
    const d = view.edit(); throw new Error('validation failed'); }));
  assert.equal(fs.readFileSync(file, 'utf8'), bytesBefore);
  assert.equal(s.read().revision, 1);
  const { revision } = await s.txn(view => {
    const d = view.edit(); d.members.b = 2; });
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
  await s.txn(view => {
    const d = view.edit(); d.members.a = 1; });
  const bytesBefore = fs.readFileSync(file, 'utf8');
  failWrites = 1;
  await assert.rejects(s.txn(view => {
    const d = view.edit(); d.members.a = 2; }), e => e instanceof StoreError && e.code === 'write-failed');
  assert.equal(fs.readFileSync(file, 'utf8'), bytesBefore, 'the failed write changed nothing on disk');
  assert.equal(s.read().members.a, 1, 'the cache still matches the disk');
  assert.equal(s.read().revision, 1);
  const { revision } = await s.txn(view => {
    const d = view.edit(); d.members.a = 3; });
  assert.equal(revision, 2);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).members.a, 3);
});

test('a corrupt file is refused, byte for byte, by both read and txn', async () => {
  const file = path.join(dir(), 'shared.json');
  fs.writeFileSync(file, '{ this is not json');
  const s = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
  assert.equal(s.warmup().code, 'corrupt');
  assert.throws(() => s.read(), e => e.code === 'corrupt');
  await assert.rejects(s.txn(view => {
    const d = view.edit(); d.members.a = 1; }), e => e.code === 'corrupt');
  assert.equal(fs.readFileSync(file, 'utf8'), '{ this is not json', 'the damaged original survives');
});

test('an unknown schemaVersion is refused the same way', () => {
  const file = path.join(dir(), 'shared.json');
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 99, revision: 5, members: {} }));
  const s = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
  assert.equal(s.warmup().code, 'schema');
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify({ schemaVersion: 99, revision: 5, members: {} }));
});

test('O01/B01=A: a lock is refused at runtime whatever it says — live pid, dead pid, foreign host — and recovery is the documented deployment act', async () => {
  const file = path.join(dir(), 'shared.json');
  // A real second process, so pid liveness is not faked: it outlives the refusal check.
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  await new Promise(r => child.on('spawn', r));
  const fixture = { pid: child.pid, host: os.hostname(), token: 't'.repeat(32), at: Date.now() };
  fs.writeFileSync(file + '.lock', JSON.stringify(fixture));
  const first = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
  assert.equal(first.warmup().code, 'second-writer');
  // The refusal left the owner's lock byte-for-byte as it was — nothing captured, nothing moved.
  assert.deepEqual(JSON.parse(fs.readFileSync(file + '.lock', 'utf8')), fixture);
  assert.equal(fs.readdirSync(dir()).filter(n => n.includes('.lock.take.')).length, 0, 'O01: no capture attempt — no tombstone was ever created');

  // The holder dies. Even a PROVABLY dead pid is not taken over at runtime any more: the
  // judge-to-capture gap is where a live owner could be moved away (the round-13 race), so
  // the runtime answer is refusal for every residual lock, whatever it names.
  child.kill('SIGKILL');
  await new Promise(r => child.on('exit', r));
  const residual = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
  assert.equal(residual.warmup().code, 'second-writer', 'a dead holder\u2019s residual lock still refuses at runtime');
  assert.equal(JSON.parse(fs.readFileSync(file + '.lock', 'utf8')).pid, child.pid, 'the residual lock is untouched');
  // The documented recovery: every writer is confirmed stopped (the pid is gone — proven
  // above), then the residual lock is removed, then the single writer starts.
  fs.unlinkSync(file + '.lock');
  const recovered = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
  assert.equal(recovered.warmup().ok, true, 'after the documented recovery the writer claims cleanly');
  assert.equal(JSON.parse(fs.readFileSync(file + '.lock', 'utf8')).pid, process.pid);
  recovered.release();
});
test('a lock from another host (a sibling container on one volume) is honoured as live', async () => {
  const file = path.join(dir(), 'shared.json');
  // Two containers on one volume are both pid 1: a bare pid cannot tell them apart (N05) —
  // the hostname is what makes the second writer refuse. A FRESH heartbeat says the peer is
  // alive; only a silent one (crash/recreate) opens the recovery path (T04).
  fs.writeFileSync(file + '.lock', JSON.stringify({ pid: process.pid, host: 'other-container', token: 't', at: Date.now() }));
  const s = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
  assert.equal(s.warmup().code, 'second-writer');
});

test('N01/B01=A: a foreign lease is refused however long it has been silent — silence is not proof of death', () => {
  const file = path.join(dir(), 'shared.json');
  // A sibling container's lease, silent way past the old TTL window. Under the confirmed
  // conservative boundary it is NEVER taken over: the container may be paused, and a
  // resumed writer's commits must never be unseated by a guess (N01). Recovery is a
  // deployment act — confirm the old writer stopped, then remove the residual lock.
    const fixture = { pid: 1, host: 'gone-container', token: 't', at: Date.now() - 60000 };
  fs.writeFileSync(file + '.lock', JSON.stringify(fixture));
  const s = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
  const w = s.warmup();
  assert.equal(w.ok, false);
  assert.equal(w.code, 'second-writer');
  assert.ok(/writer exists/.test(w.detail), 'the refusal names the holder: ' + w.detail);
  // The refusal left the residual lock byte-for-byte where it was (S01/S03).
  assert.deepEqual(JSON.parse(fs.readFileSync(file + '.lock', 'utf8')), fixture);
});test('release() hands the lock back, so a recreated instance starts clean', async () => {
  const file = path.join(dir(), 'shared.json');
  const first = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
  assert.equal(first.warmup().ok, true);
  first.release();
  assert.equal(fs.existsSync(file + '.lock'), false);
  const second = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
  assert.equal(second.warmup().ok, true);
});

test('S03/B01=A: an unreadable lease is an unknown state — refused at any age, kept for diagnosis (F02)', () => {
  const file = path.join(dir(), 'shared.json');
  // Both flavours of non-lock: not JSON at all, and a bare number — which JSON.parse happily
  // returns, and which must never be mistaken for a live owner's lock. Neither can prove its
  // writer stopped, so neither is ever taken over (B01=A): the operator confirms every writer
  // is stopped and removes the residual lock; the code refuses unknown states.
  for (const garbage of ['not-a-pid', '99999999', '']) {
    fs.writeFileSync(file + '.lock', garbage);
    const fresh = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
    assert.equal(fresh.warmup().code, 'second-writer', `garbage ${JSON.stringify(garbage)} refused`);
    const past = new Date(Date.now() - 60000);
    fs.utimesSync(file + '.lock', past, past);
    const stale = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
    assert.equal(stale.warmup().code, 'second-writer', `long-silent garbage ${JSON.stringify(garbage)} STILL refused`);
    assert.equal(fs.readFileSync(file + '.lock', 'utf8'), garbage, 'the residual lease is kept, not cleaned');
  }
});test('F01: a deposed writer stops leasing, stops committing, and reads unhealthy', async () => {
  const file = path.join(dir(), 'shared.json');
  const a = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
  assert.equal(a.warmup().ok, true);
  assert.equal(a.healthy(), true);
  await a.txn(view => {
    const d = view.edit(); d.members.before = 1 }); // one committed change
  // While A is "paused", a peer recovers the silent lease (a fresh foreign token in its place).
  fs.writeFileSync(file + '.lock', JSON.stringify({ pid: 1, host: 'peer-container', token: 'peer', at: Date.now() }));
  // A's next commit proves the lease at the commit point — or the conditional heartbeat has
  // already deposed it; either refusal (lost-lock / second-writer) is the correct outcome.
  await assert.rejects(a.txn(view => {
    const d = view.edit(); d.members.after = 1 }), e => e.code === 'lost-lock' || e.code === 'second-writer');
  assert.equal(a.healthy(), false);
  assert.equal(JSON.parse(fs.readFileSync(file + '.lock', 'utf8')).token, 'peer', 'the deposed writer never rewrites the lease');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).members.after, undefined, 'the deposed writer never commits');
  assert.throws(() => a.read(), e => e.code === 'lost-lock');
});

test('R07: a file that corrupts after warmup refuses both reads and writes, and survives byte for byte', async () => {
  const file = path.join(dir(), 'shared.json');
  const s = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
  await s.txn(view => {
    const d = view.edit(); d.members.a = 1; });
  const damaged = '{ this is not json';
  fs.writeFileSync(file, damaged);
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(file, future, future); // mtime must move, or the change is invisible
  assert.throws(() => s.read(), e => e.code === 'corrupt');
  await assert.rejects(s.txn(view => {
    const d = view.edit(); d.members.b = 2; }), e => e.code === 'corrupt');
  assert.equal(fs.readFileSync(file, 'utf8'), damaged, 'the damaged original is never overwritten from cache');
  assert.equal(s.warmup().ok, false, 'the refusal is sticky, not a one-shot');
  assert.equal(s.warmup().code, 'corrupt');
});

test('R08: an async callback is awaited — mutations after an await reach the disk', async () => {
  const file = path.join(dir(), 'shared.json');
  const s = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
  await s.txn(async view => {
    const d = view.edit();
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
  await s.txn(view => {
    const d = view.edit(); d.members.a = 1; });
  await assert.rejects(s.txn(async view => {
    const d = view.edit();
    d.members.b = 2;
    await new Promise(r => setTimeout(r, 5));
    throw new Error('async validation failed');
  }));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).members.b, undefined);
  const { revision } = await s.txn(view => {
    const d = view.edit(); d.members.c = 3; });
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
  await s.txn(view => {
    const d = view.edit(); d.members.a = 1; });
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
  await first.txn(view => {
    const d = view.edit(); d.members.a = 1; });
  await first.txn(view => {
    const d = view.edit(); d.members.b = 2; });
  first.release(); // a restart releases first — the graceful path needs no recovery flow
  const second = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
  const { revision } = await second.txn(view => {
    const d = view.edit(); d.members.c = 3; });
  assert.equal(revision, 3);
});

test('the view (round-7 NO_WRITE cost): a no-op plans without a clone; the first mutation clones once', async () => {
  const s = makeStore();
  await s.txn(view => { const d = view.edit(); d.members.a = 1; });
  const realClone = structuredClone;
  let clones = 0;
  globalThis.structuredClone = v => { clones++; return realClone(v); };
  try {
    // The plan phase reads the live snapshot; a NO_WRITE answer costs no copy at all.
    const out = await s.txn(view => {
      assert.equal(view.state.members.a, 1);
      return NO_WRITE;
    });
    assert.deepEqual(out, { revision: 1, out: undefined });
    assert.equal(clones, 0, 'a no-op transaction never pays the clone');
    // The first mutation clones exactly once, and every later edit() hands back the same draft.
    await s.txn(view => {
      const d1 = view.edit();
      const d2 = view.edit();
      assert.equal(d1, d2, 'one clone per transaction, however many edits');
      d1.members.b = 2;
    });
    assert.equal(clones, 1);
    assert.deepEqual(s.read().members, { a: 1, b: 2 });
    assert.equal(s.read().revision, 2, 'only the mutating transaction moved the revision');
  } finally {
    globalThis.structuredClone = realClone;
  }
});

/* J05: the transaction's third outcome. A callback that returns a plain result without
 * calling edit() changed nothing — its answer is read-only and must never reach the write
 * path. The old code fell through with `target = current` (the LIVE cache) and mutated
 * revision/updatedAt on it before persisting, so an injected writer failure left memory
 * ahead of disk (peek().revision 3 on a revision-2 file) with healthy() still true. */
test('J05: a no-edit result is read-only — nothing persists, nothing mutates, even with a failing writer', async () => {
  const file = path.join(dir(), 'shared.json');
  let failWrites = false;
  let writes = 0;
  const realWrite = (dst, content, mode) => { if (failWrites) throw Object.assign(new Error('injected EIO'), { code: 'EIO' }); writes++; return fs.writeFileSync(dst, content, { mode }); };
  const s = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }), writer: realWrite });
  await s.txn(view => { view.edit().members.a = 1; });               // init + the commit itself
  const writesBefore = writes;
  const before = { disk: JSON.parse(fs.readFileSync(file, 'utf8')), cache: s.read(), epoch: s.epoch() };
  failWrites = true;
  // The replay-shaped call: a business result, no edit, with the writer set to fail. It
  // must SUCCEED (there is nothing to write), never reach the writer, and change nothing.
  const out = await s.txn(view => ({ ok: true, applied: false, at: 1 }));
  assert.deepEqual(out, { revision: 1, out: { ok: true, applied: false, at: 1 } });
  assert.equal(writes, writesBefore, 'the read-only path never calls the writer');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), before.disk);
  assert.deepEqual(s.read(), before.cache);
  assert.equal(s.epoch(), before.epoch);
  // A real edit under the same failure: refused, and file, cache and epoch stay put.
  await assert.rejects(s.txn(view => { view.edit().members.b = 2; }), e => e instanceof StoreError && e.code === 'write-failed');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), before.disk);
  assert.deepEqual(s.read(), before.cache);
  assert.equal(s.epoch(), before.epoch);
  // The queue is not wedged: with the writer back, the next transaction proceeds.
  failWrites = false;
  const { revision } = await s.txn(view => { view.edit().members.b = 2; });
  assert.equal(revision, 2);
  s.release();
});

/* J06: the marker publication step's failure exits. The writer has already produced the
 * full private data file when the marker link fails — every failure exit from that point
 * must clean the private file; ten consecutive failures must leave no complete data temp
 * and no marker debris behind. */
test('J06: marker publication failures leave no private commit files or marker debris', async () => {
  const file = path.join(dir(), 'shared.json');
  const realLink = fs.linkSync;
  let failures = 0;
  fs.linkSync = function (from, to) {
    if (String(to).includes('.committing.')) { failures++; throw Object.assign(new Error('injected link EIO'), { code: 'EIO' }); }
    return realLink(from, to);
  };
  const s = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
  try {
    let rejected = 0;
    for (let i = 0; i < 10; i++) {
      try { await s.txn(view => { view.edit().members['m' + i] = i; }); }
      catch (e) { assert.equal(e.code, 'write-failed'); rejected++; }
    }
    assert.equal(rejected, 10);
    assert.equal(failures, 10);
    const debris = fs.readdirSync(path.dirname(file))
      .filter(n => n.includes('.commit.') || n.includes('.committing'));
    assert.deepEqual(debris, [], 'no private data temp, no marker temp, no marker');
    assert.equal(fs.existsSync(file), false, 'the shared file was never created');
    // The writer works again once the link does: a normal commit goes through.
    fs.linkSync = realLink;
    const { revision } = await s.txn(view => { view.edit().members.ok = 1; });
    assert.equal(revision, 1);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).members.ok, 1);
  } finally {
    fs.linkSync = realLink;
    s.release();
  }
});

/* K01, the round-9 "stale inventory" reproduction: B's FIRST directory listing is captured
 * (and paused) BEFORE writer A enters the commit section; A then publishes its token
 * marker, passes the lease check and pauses before the final rename. The old protocol
 * cleared the markers from that stale listing, took over the silent lease and committed —
 * A's private file was never deleted, and A's resumed rename overwrote B's acknowledged
 * commit. The fix: the authoritative isolation runs AFTER the lease is ours, so the scan
 * provably covers every writer that could still rename (a writer publishes its marker
 * BEFORE its lease check, and its lease check can only pass while it holds the lease —
 * which ended the moment this store captured it). Real child processes, distinct
 * hostnames, a controllable clock. */
test('K02: an ENOENT while isolating a marker is the safe answer — the acquisition proceeds', async () => {
  const file = path.join(dir(), 'shared.json');
  // Debris from a crashed writer: the marker names a private file that no longer exists.
  fs.writeFileSync(file + '.committing.deadbeef', JSON.stringify({ pid: 99999999, host: 'elsewhere', token: 'deadbeef', at: Date.now() - 60000, tmp: file + '.commit.gone' }));
  const s = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
  try {
    assert.equal(s.warmup().ok, true);
    assert.equal(fs.existsSync(file + '.committing.deadbeef'), false, 'the marker debris is cleared');
    const { revision } = await s.txn(view => { view.edit().members.a = 1; });
    assert.equal(revision, 1);
  } finally { s.release(); }
});

/* L01, the round-10 "swallowed marker read" family. A writer that already passed its
 * final review (read its marker, matched, checked its lease) and paused before the
 * rename keeps its rename source whatever a LATER read of that marker returns — so the
 * isolation read is load-bearing and must distinguish its outcomes instead of folding
 * every failure into "no marker". Unit level first; the full paused-writer sequence is
 * the child-process test at the end. */
test('L01: an unreadable canonical marker refuses the acquisition and stays on disk', async () => {
  const file = path.join(dir(), 'shared.json');
  const marker = file + '.committing.' + 'a'.repeat(32);
  const tmp = file + '.commit.abcdef123456';
  fs.writeFileSync(tmp, JSON.stringify({ schemaVersion: 1, revision: 9 }));
  fs.writeFileSync(marker, JSON.stringify({ pid: 99999999, host: 'elsewhere', token: 'a'.repeat(32), at: Date.now() - 60000, tmp }));
  const realRead = fs.readFileSync;
  fs.readFileSync = function (p, ...args) {
    if (p === marker) { const e = new Error('injected EIO'); e.code = 'EIO'; throw e; }
    return realRead(p, ...args);
  };
  let s;
  try {
    s = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
    const w = s.warmup();
    assert.equal(w.ok, false);
    assert.equal(w.code, 'lock');
    assert.ok(/cannot verify/.test(w.detail), 'the refusal names the marker and the state: ' + w.detail);
    assert.equal(fs.existsSync(marker), true, 'the marker is kept for diagnosis');
    assert.equal(fs.existsSync(tmp), true, 'the private commit file is kept too — nothing was pretended');
  } finally {
    fs.readFileSync = realRead;
    s?.release();
  }
  // The read works again: the same acquisition proceeds and isolates both files.
  const s2 = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
  try {
    assert.equal(s2.warmup().ok, true);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(fs.existsSync(tmp), false);
    const { revision } = await s2.txn(view => { view.edit().members.a = 1; });
    assert.equal(revision, 1);
  } finally { s2.release(); }
});

test('L01: invalid marker content — unparseable, or naming a file that is not ours — refuses and is kept', async () => {
  const file = path.join(dir(), 'shared.json');
  const garbage = file + '.committing.' + 'b'.repeat(32);
  fs.writeFileSync(garbage, '{not json');
  let s = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
  const w1 = s.warmup();
  assert.equal(w1.ok, false);
  assert.equal(w1.code, 'lock');
  assert.equal(fs.existsSync(garbage), true, 'kept for diagnosis');
  s.release();
  fs.unlinkSync(garbage);
  const alien = file + '.committing.' + 'c'.repeat(32);
  fs.writeFileSync(alien, JSON.stringify({ pid: 1, host: 'x', token: 'c'.repeat(32), at: 1, tmp: '/etc/passwd' }));
  s = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
  const w2 = s.warmup();
  assert.equal(w2.ok, false);
  assert.equal(w2.code, 'lock');
  assert.equal(fs.existsSync(alien), true);
  assert.equal(fs.existsSync('/etc/passwd'), true, 'nothing outside our directory was touched');
  s.release();
});

test('L01: a marker that vanished mid-isolation (ENOENT) and non-canonical debris both proceed', async () => {
  const file = path.join(dir(), 'shared.json');
  const vanished = file + '.committing.' + 'd'.repeat(32);
  fs.writeFileSync(vanished, JSON.stringify({ tmp: file + '.commit.000000000000' }));
  const realRead = fs.readFileSync;
  fs.readFileSync = function (p, ...args) {
    if (p === vanished) { const e = new Error('gone'); e.code = 'ENOENT'; throw e; }
    return realRead(p, ...args);
  };
  let s;
  try {
    s = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
    assert.equal(s.warmup().ok, true);
  } finally { fs.readFileSync = realRead; s?.release(); }
  const torn = file + '.committing.' + 'e'.repeat(32) + '.new.' + 'f'.repeat(8);
  fs.writeFileSync(torn, '{partial');
  const s2 = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
  try {
    assert.equal(s2.warmup().ok, true);
    assert.equal(fs.existsSync(torn), false, 'the debris was cleaned');
    const { revision } = await s2.txn(view => { view.edit().members.a = 1; });
    assert.equal(revision, 1);
  } finally { s2.release(); }
});

/* L01, the full round-10 reproduction: A passed its final review and is paused before
 * the data rename; B's takeover hits a PERSISTENT read error on A's marker. The old
 * code folded the EIO into "no marker", deleted it without disarming A, and committed —
 * A's resumed rename then overwrote B's acknowledged data. The isolation must refuse
 * instead: B never promises a success it cannot defend, A (the legitimate holder,
 * never successfully deposed) completes. */
test('M01: a deposed holder\u2019s heartbeat never rewrites the lease that replaced it', async () => {
  const file = path.join(dir(), 'beaten.json');
  const s = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
  try {
    assert.equal(s.warmup().ok, true);
    const own = JSON.parse(fs.readFileSync(file + '.lock', 'utf8'));
    assert.equal(own.pid, process.pid);
    // Another host legitimately took the lease over while this process "paused" — its
    // own heartbeat already silent long enough for the takeover to be honest.
        // Another writer legitimately took the lease over while this process "paused": a
    // same-host lease whose holder pid is PROVABLY dead — the only takeoverable kind
    // (B01=A). Any token that is not ours deposes us all the same.
    const corpse = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise(r => corpse.on('exit', r));
    const foreign = { pid: corpse.pid, host: os.hostname(), token: 'f'.repeat(32), at: Date.now() - 60000 };
    fs.writeFileSync(file + '.lock', JSON.stringify(foreign));
    // The deposed holder notices at its next LEASED commit (a no-edit result is
    // read-only and never checks the lease, J05) — and stops claiming.
    await assert.rejects(s.txn(view => { view.edit().members.x = 1; }), e => e.code === 'lost-lock');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).members, {}, 'the deposed commit wrote nothing');
    // Give the (1 s) heartbeat two chances to run if it were still alive.
    await new Promise(r => setTimeout(r, 2300));
    const after = JSON.parse(fs.readFileSync(file + '.lock', 'utf8'));
    assert.equal(after.token, foreign.token, 'the foreign lease is untouched — no resurrection by heartbeat');
    // The control: after the DOCUMENTED recovery (the foreign holder is a corpse — pid
    // proven dead — so the operator removes the residual lock), the next writer claims.
    fs.unlinkSync(file + '.lock');
    const s2 = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
    try {
      assert.equal(s2.warmup().ok, true);
      const token2 = JSON.parse(fs.readFileSync(file + '.lock', 'utf8')).token;
      await new Promise(r => setTimeout(r, 2300));
      assert.equal(JSON.parse(fs.readFileSync(file + '.lock', 'utf8')).token, token2, 'a live holder keeps beating under its own token');
      const { revision } = await s2.txn(view => { view.edit().members.a = 1; });
      assert.equal(revision, 1);
    } finally { s2.release(); }
  } finally { s.release(); }
});

/* The conservative takeover world (B01=A, N01): a lease changes hands only over a holder
 * that is PROVABLY stopped. The child writers below run WITHOUT a hostname mock — they all
 * share the real host, so the judge is the pid-liveness proof — and a writer pauses inside
 * its own final data rename when its draft contains its pause key; the parent SIGKILLs it
 * there, leaving lease + marker + private commit file behind with a pid that answers
 * nothing. That is the only state a takeover may proceed over. */

/* The conservative world (B01=A, O01): a residual lock is NEVER taken over at runtime. The
 * child writers below run WITHOUT a hostname mock — they share the real host. A writer's
 * scenario has two transactions: WRITE (completes, acknowledged) and — when a pause key is
 * set — PAUSE, whose commit the writer stops inside its own final rename; the parent
 * SIGKILLs it there, leaving lease + marker + private commit file behind with a pid that
 * answers nothing. That residual lock refuses every later writer until the documented
 * recovery (confirm stopped, remove the lock) hands the file over. */
function corpseScenario(w, { writeKey, pauseKey, role, intercept, recovery }) {
  return `
import fs from 'node:fs';
import path from 'node:path';
const { createSharedStore } = await import(process.env.STORE_URL);
const file = process.env.FILE, root = process.env.ROOT;
${intercept || ''}
const store = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: { seed: 1 } }) });
console.log('WARMUP ' + JSON.stringify(store.warmup()));
${recovery ? `{ const sleeper = new Int32Array(new SharedArrayBuffer(4)); const deadline = Date.now() + 60000; while (!fs.existsSync(path.join(root, 'release-recovery')) && Date.now() < deadline) Atomics.wait(sleeper, 0, 0, 20); let lockSeen = 'absent'; try { lockSeen = fs.readFileSync(file + '.lock', 'utf8') } catch (e) { lockSeen = 'absent:' + e.code } const w2 = store.warmup(); console.log('WARMUP2 ' + JSON.stringify({ ...w2, lockSeen: lockSeen.slice(0, 120) })); }` : ''}
const txn = async key => {
  try { const r = await store.txn(v => { v.edit().members[key] = 1 }); console.log('TXN ' + JSON.stringify({ ok: true, revision: r.revision })) }
  catch (e) { console.log('TXN ' + JSON.stringify({ ok: false, code: e.code || 'unexpected' })) }
};
await txn(${JSON.stringify(writeKey)});
${pauseKey ? `await txn(${JSON.stringify(pauseKey)});` : ''}
`;
}
const renamePauseIntercept = pauseKey => `
const rename = fs.renameSync;
fs.renameSync = function (from, to) {
  if (${JSON.stringify(pauseKey)} && to === file && String(from).includes('.commit.')) {
    let mine = false;
    try { mine = !!JSON.parse(fs.readFileSync(from, 'utf8')).members[${JSON.stringify(pauseKey)}] } catch { /* not the draft */ }
    if (mine) {
      fs.writeFileSync(path.join(root, 'entered-' + process.env.ROLE), '1');
      const sleeper = new Int32Array(new SharedArrayBuffer(4));
      const deadline = Date.now() + 60000;
      while (!fs.existsSync(path.join(root, 'release-' + process.env.ROLE)) && Date.now() < deadline) Atomics.wait(sleeper, 0, 0, 20);
    }
  }
  return rename(from, to);
};
`;

/* I01's invariant, restated for the FINAL conservative policy (O01): a residual lock from a
 * confirmed-stopped writer is refused at runtime — recovery is the deployment act (confirm
 * every writer stopped, remove the lock). The recovery hands the file to the next writer,
 * whose clean claim isolates exactly the dead writer's marker and private commit file, and
 * nothing the dead writer acknowledged is ever lost. */
test('O01/B01=A: a residual lock refuses at runtime; after the documented recovery the next writer isolates exactly the dead writer\u2019s debris, and acknowledged commits survive', async () => {
  const w = writerWorld('community-store-i01-');
  const markerFiles = () => fs.readdirSync(w.root).filter(n => n.startsWith('data.json.committing.'));
  const noCapture = () => fs.readdirSync(w.root).filter(n => n.includes('.lock.take.')).length === 0;
  try {
    // Generation 1: w1 is acknowledged (revision 1); then the writer pauses inside its p1
    // commit — marker published, private file armed — and is killed there.
    const g1 = w.spawnWriter(corpseScenario(w, { writeKey: 'w1', pauseKey: 'p1', role: 'W1', intercept: renamePauseIntercept('p1') }), 'W1');
    assert.equal((await g1.warmup()).ok, true);
    assert.deepEqual(await g1.waitForLine('TXN'), { ok: true, revision: 1 }, 'w1 is acknowledged');
    await w.waitFor('W1 to reach its p1 rename', path.join(w.root, 'entered-W1'));
    assert.equal(markerFiles().length, 1, 'W1 holds a commit marker (per-writer name)');
    const token1 = JSON.parse(fs.readFileSync(w.file + '.lock', 'utf8')).token;
    g1.kill();
    await g1.exited; // provably stopped: the deployment precondition
    assert.equal(markerFiles().length, 1, 'the corpse keeps its marker and its private file');
    // The next writer REFUSES the residual lock at runtime — no capture, no tombstone.
    const g2 = w.spawnWriter(corpseScenario(w, { writeKey: 'w2', pauseKey: '', role: 'W2', intercept: renamePauseIntercept(''), recovery: true }), 'W2');
    const refuse2 = await g2.warmup();
    assert.equal(refuse2.ok, false);
    assert.equal(refuse2.code, 'second-writer');
    assert.equal(noCapture(), true, 'O01: the refusal never moved the public lock');
    assert.equal(JSON.parse(fs.readFileSync(w.file + '.lock', 'utf8')).token, token1, 'the residual lease is untouched');
    // The documented recovery: every writer is confirmed stopped (g1 is reaped — proven
    // above), remove the lock. The same writer's second attempt claims cleanly and
    // isolates exactly the dead writer\u2019s debris.
    fs.unlinkSync(w.file + '.lock');
    fs.writeFileSync(path.join(w.root, 'release-recovery'), '1');
    const claimed = await g2.waitForLine('WARMUP2');
    assert.equal(claimed.ok, true, 'after the documented recovery W2 claims');
    assert.equal(markerFiles().length, 0, 'the clean claim isolated W1\u2019s marker and private file');
    const token2 = JSON.parse(fs.readFileSync(w.file + '.lock', 'utf8')).token;
    assert.notEqual(token2, token1, 'the lease changed hands through the documented recovery');
    // W2 commits: W1\u2019s acknowledged w1 survives; W1\u2019s uncommitted draft never lands.
    assert.deepEqual(await g2.done, { ok: true, revision: 2 });
    const final = JSON.parse(fs.readFileSync(w.file, 'utf8'));
    assert.deepEqual(final.members, { seed: 1, w1: 1, w2: 1 }, 'acked data survived; no dead writer\u2019s uncommitted draft did');
    assert.equal(markerFiles().length, 0, 'no marker debris after the recovery');
  } finally { await w.teardown(); }
});

/* K02's invariant, restated: the isolation is load-bearing on EVERY clean claim — a fencing
 * unlink that fails with anything but ENOENT refuses the acquisition (the lease is given
 * back, the dead writer's evidence stays on disk untouched), and a healed retry then
 * isolates cleanly and commits. The residual lock itself refuses first (O01); recovery is
 * the documented flow. */
test('O01/B01=A: a residual lock refuses; after the documented recovery a fencing unlink EIO still refuses the acquisition, keeps the evidence, and a healed retry recovers', async () => {
  const w = writerWorld('community-store-k02-');
  const g1 = w.spawnWriter(corpseScenario(w, { writeKey: 'x1', pauseKey: 'x1', role: 'W1', intercept: renamePauseIntercept('x1') }), 'W1');
  assert.equal((await g1.warmup()).ok, true);
  await w.waitFor('W1 to reach its x1 rename', path.join(w.root, 'entered-W1'));
  const marker = fs.readdirSync(w.root).find(n => n.startsWith('data.json.committing.'));
  g1.kill();
  await g1.exited;
  const g0 = w.spawnWriter(corpseScenario(w, { writeKey: 'y0', pauseKey: '', role: 'W0', intercept: renamePauseIntercept('') }), 'W0');
  assert.equal((await g0.warmup()).code, 'second-writer');
  fs.unlinkSync(w.file + '.lock'); // the documented recovery; the debris stays for isolation
  const eioCode = `
const unlink = fs.unlinkSync;
fs.unlinkSync = function (p, ...args) {
  if (String(p).includes('.commit.')) throw Object.assign(new Error('injected fencing EIO'), { code: 'EIO' });
  return unlink(p, ...args);
};`;
  const g2 = w.spawnWriter(corpseScenario(w, { writeKey: 'y2', pauseKey: '', role: 'W2', intercept: eioCode }), 'W2');
  const cw = await g2.warmup();
  assert.equal(cw.ok, false);
  assert.equal(cw.code, 'lock');
  assert.ok(/cannot isolate/.test(cw.detail), 'the refusal names the file it could not isolate: ' + cw.detail);
  assert.deepEqual(await g2.done, { ok: false, code: 'lock' }, 'the transaction refuses too');
  assert.equal(fs.existsSync(path.join(w.root, marker)), true, 'the marker is kept for diagnosis');
  assert.equal(fs.readdirSync(w.root).filter(n => n.includes('.commit.')).length >= 1, true, 'the private commit file is kept too');
  assert.equal(fs.existsSync(w.file + '.lock'), false, 'the refused writer gave its own lease back');
  const g3 = w.spawnWriter(corpseScenario(w, { writeKey: 'w3', pauseKey: '', role: 'W3', intercept: renamePauseIntercept('') }), 'W3');
  assert.equal((await g3.warmup()).ok, true);
  assert.deepEqual(await g3.done, { ok: true, revision: 1 });
  assert.equal(fs.readdirSync(w.root).filter(n => n.startsWith('data.json.committing.')).length, 0, 'the healed claim isolated the debris');
  const final = JSON.parse(fs.readFileSync(w.file, 'utf8'));
  assert.deepEqual(final.members, { seed: 1, w3: 1 });
});

/* L01's invariant, restated: the isolation READ is load-bearing on every clean claim — a
 * canonical marker that cannot be read or verified refuses the acquisition (the marker and
 * the private file it names stay for diagnosis); once the read works again, the same claim
 * proceeds and cleans exactly what it could finally verify. The residual lock itself
 * refuses first (O01); recovery is the documented flow. */
test('O01/B01=A: a residual lock refuses; after the documented recovery an unreadable canonical marker still refuses the acquisition; a healed retry isolates and commits', async () => {
  const w = writerWorld('community-store-l01-');
  const g1 = w.spawnWriter(corpseScenario(w, { writeKey: 'x1', pauseKey: 'x1', role: 'W1', intercept: renamePauseIntercept('x1') }), 'W1');
  assert.equal((await g1.warmup()).ok, true);
  await w.waitFor('W1 to reach its x1 rename', path.join(w.root, 'entered-W1'));
  const marker = fs.readdirSync(w.root).find(n => n.startsWith('data.json.committing.'));
  const commitFile = fs.readdirSync(w.root).find(n => n.includes('.commit.') && !n.startsWith('data.json.committing.'));
  g1.kill();
  await g1.exited;
  const g0 = w.spawnWriter(corpseScenario(w, { writeKey: 'y0', pauseKey: '', role: 'W0', intercept: renamePauseIntercept('') }), 'W0');
  assert.equal((await g0.warmup()).code, 'second-writer', 'the residual lock refuses at runtime');
  fs.unlinkSync(w.file + '.lock'); // the documented recovery
  const eioCode = `
const readFile = fs.readFileSync;
fs.readFileSync = function (p, ...args) {
  const n = path.basename(String(p));
  if (n.startsWith('data.json.committing.') && (n === 'data.json.committing' || /^[0-9a-f]+$/.test(n.slice('data.json.committing.'.length))))
    throw Object.assign(new Error('injected marker read EIO'), { code: 'EIO' });
  return readFile(p, ...args);
};`;
  const g2 = w.spawnWriter(corpseScenario(w, { writeKey: 'y2', pauseKey: '', role: 'W2', intercept: eioCode }), 'W2');
  const cw = await g2.warmup();
  assert.equal(cw.ok, false);
  assert.equal(cw.code, 'lock');
  assert.ok(/cannot verify/.test(cw.detail), 'the refusal names the unreadable marker: ' + cw.detail);
  assert.deepEqual(await g2.done, { ok: false, code: 'lock' });
  assert.equal(fs.existsSync(path.join(w.root, marker)), true, 'the marker is kept');
  assert.equal(fs.existsSync(path.join(w.root, commitFile)), true, 'the private commit file is kept');
  const g3 = w.spawnWriter(corpseScenario(w, { writeKey: 'w3', pauseKey: '', role: 'W3', intercept: renamePauseIntercept('') }), 'W3');
  assert.equal((await g3.warmup()).ok, true);
  assert.deepEqual(await g3.done, { ok: true, revision: 1 });
  assert.equal(fs.existsSync(path.join(w.root, marker)), false, 'the healed claim removed the marker');
  assert.equal(fs.existsSync(path.join(w.root, commitFile)), false, 'and the private file it named');
  const final = JSON.parse(fs.readFileSync(w.file, 'utf8'));
  assert.deepEqual(final.members, { seed: 1, w3: 1 });
});
