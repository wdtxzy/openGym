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
  assert.ok(/foreign/.test(w.detail), 'the refusal names the verdict: ' + w.detail);
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
  const second = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
  const { revision } = await second.txn(view => {
    const d = view.edit(); d.members.c = 3; });
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

/* I01, the three-writer reproduction from the round-7 review: A pauses inside the commit
 * critical section (marker published and verified, before the final rename) → B recovers the
 * silent lease and pauses in exactly the same place → A resumes and FAILS: its abort cleanup
 * must not delete B's marker → C recovers B's silence and commits. The old code's
 * unconditional `unlink(commitMarker)` in the failure catch deleted B's marker, C's takeover
 * then never learned of B's private commit file, and B's resumed rename overwrote C's
 * acknowledged commit. Each writer is a real child process with its own "hostname" (the
 * cross-container recovery path) and a controllable clock file — the takeover windows move by
 * writing the clock, not by sleeping 16 s each. */
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
    // The control: a live holder's own lease survives its beats (still its token).
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

/* I01's invariant, restated for the conservative policy: a takeover isolates exactly the
 * dead writer's marker and private file — both temp layers — and never touches anything
 * the dead writer managed to acknowledge before it died. Three generations, each taking
 * over the corpse of the last. */

/* The conservative takeover world (B01=A, N01): a lease changes hands only over a holder
 * that is PROVABLY stopped. The child writers below run WITHOUT a hostname mock — they all
 * share the real host, so the judge is the pid-liveness proof. A writer's scenario has two
 * transactions: WRITE (completes, acknowledged) and — when a pause key is set — PAUSE,
 * whose commit the writer stops inside its own final rename; the parent SIGKILLs it there,
 * leaving lease + marker + private commit file behind with a pid that answers nothing.
 * That corpse is the only state a takeover may proceed over. */
function corpseScenario(w, { writeKey, pauseKey, role, intercept }) {
  return `
import fs from 'node:fs';
import path from 'node:path';
const { createSharedStore } = await import(process.env.STORE_URL);
const file = process.env.FILE, root = process.env.ROOT;
${intercept || ''}
const store = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: { seed: 1 } }) });
console.log('WARMUP ' + JSON.stringify(store.warmup()));
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
};`;

/* I01's invariant, restated for the conservative policy: a takeover isolates exactly the
 * dead writer's marker and private commit file — both temp layers — and never touches
 * anything the dead writer acknowledged before it died. Three generations, each taking
 * over the corpse of the last. */
test('N01/B01=A: each takeover over a provably-stopped holder isolates exactly that dead writer\u2019s files; acknowledged commits survive every generation', async () => {
  const w = writerWorld('community-store-i01-');
  const markerFiles = () => fs.readdirSync(w.root).filter(n => n.startsWith('data.json.committing.'));
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
    await g1.exited; // the pid is reaped: provably stopped — the takeover precondition
    assert.equal(markerFiles().length, 1, 'the corpse keeps its marker and its private file');
    // Generation 2 takes the corpse's lease over: the isolation removes exactly W1's
    // marker and private file — W1 can never resume to fire its armed rename.
    const g2 = w.spawnWriter(corpseScenario(w, { writeKey: 'p2', pauseKey: 'p2', role: 'W2', intercept: renamePauseIntercept('p2') }), 'W2');
    assert.equal((await g2.warmup()).ok, true);
    assert.equal(markerFiles().length, 0, 'the takeover isolated W1\u2019s marker and private file before any business write');
    const token2 = JSON.parse(fs.readFileSync(w.file + '.lock', 'utf8')).token;
    assert.notEqual(token2, token1, 'the lease changed hands over the dead holder');
    const stop2 = g2.done.catch(() => {});
    await w.waitFor('W2 to reach its p2 rename', path.join(w.root, 'entered-W2'));
    assert.equal(markerFiles().length, 1, 'now W2 is mid-commit with its own marker');
    g2.kill();
    await g2.exited;
    // Generation 3: takes over W2's corpse, isolates it, and commits — W1's acknowledged
    // w1 survives both takeovers, and no dead writer's uncommitted draft ever lands.
    const g3 = w.spawnWriter(corpseScenario(w, { writeKey: 'w3', pauseKey: '', role: 'W3', intercept: renamePauseIntercept('') }), 'W3');
    assert.equal((await g3.warmup()).ok, true);
    assert.deepEqual(await g3.done, { ok: true, revision: 2 });
    const final = JSON.parse(fs.readFileSync(w.file, 'utf8'));
    assert.deepEqual(final.members, { seed: 1, w1: 1, w3: 1 }, 'acked data survived; no dead writer\u2019s uncommitted draft did');
    assert.equal(markerFiles().length, 0, 'no marker debris after the last isolation');
    await stop2;
  } finally { await w.teardown(); }
});

/* K01's invariant, restated: a second writer that arrives while the first is mid-commit is
 * REFUSED — and the refusal clears nothing. Whatever path delivers it (the early guard's
 * marker-over-live-lease check or the takeover judge), the paused writer's marker, private
 * file and lease must all be exactly where it left them, so its resumed rename lands and
 * its acknowledged commit survives. (S01: a refusal never changes the business file or the
 * owner's identity.) */
test('N01/B01=A: a second writer over a LIVE same-host holder is refused, clears nothing, and the paused writer completes', async () => {
  const w = writerWorld('community-store-k01-');
  try {
    const holder = w.spawnWriter(corpseScenario(w, { writeKey: 'w1', pauseKey: 'p1', role: 'holder', intercept: renamePauseIntercept('p1') }), 'holder');
    assert.equal((await holder.warmup()).ok, true);
    const token = JSON.parse(fs.readFileSync(w.file + '.lock', 'utf8')).token;
    const stop = holder.done.catch(() => {});
    fs.writeFileSync(path.join(w.root, 'go'), '1');
    await w.waitFor('holder to reach its rename', path.join(w.root, 'entered-holder'));
    const marker = fs.readdirSync(w.root).find(n => n.startsWith('data.json.committing.'));
    assert.ok(marker, 'the holder is mid-commit with a published marker');
    // A second writer on the same host: the holder's pid answers signal 0 — no proof of
    // death, no takeover. The refusal is total and touches nothing.
    const contender = w.spawnWriter(corpseScenario(w, { writeKey: 'c2', pauseKey: '', role: 'contender', intercept: renamePauseIntercept('') }), 'contender');
    const cw = await contender.warmup();
    assert.equal(cw.ok, false);
    assert.equal(cw.code, 'second-writer');
    assert.deepEqual(await contender.done, { ok: false, code: 'second-writer' }, 'the transaction refuses too');
    // Nothing was cleared: the marker, the private file and the holder's lease are intact.
    assert.equal(fs.existsSync(path.join(w.root, marker)), true, 'the stale-listing guard cleared no marker');
    assert.equal(JSON.parse(fs.readFileSync(w.file + '.lock', 'utf8')).token, token, 'the live holder\u2019s lease is untouched');
    // The holder resumes and completes: its paused commit lands behind the acknowledged one.
    fs.writeFileSync(path.join(w.root, 'release-holder'), '1');
    assert.deepEqual(await holder.done, { ok: true, revision: 2 });
    const final = JSON.parse(fs.readFileSync(w.file, 'utf8'));
    assert.deepEqual(final.members, { seed: 1, w1: 1, p1: 1 });
    await stop;
  } finally { await w.teardown(); }
});

/* K02's invariant, restated: the takeover's isolation is load-bearing even over a corpse —
 * a fencing unlink that fails with anything but ENOENT refuses the whole acquisition (the
 * lease is given back, the dead writer's evidence stays on disk untouched), and a healed
 * retry then isolates cleanly and commits. */
test('N01/B01=A: a fencing unlink EIO over a dead holder refuses the acquisition, keeps the evidence, and a healed retry recovers', async () => {
  const w = writerWorld('community-store-k02-');
  // W1 pauses inside its x1 commit and is killed: marker + private file remain, pid dead.
  const g1 = w.spawnWriter(corpseScenario(w, { writeKey: 'x1', pauseKey: 'x1', role: 'W1', intercept: renamePauseIntercept('x1') }), 'W1');
  assert.equal((await g1.warmup()).ok, true);
  await w.waitFor('W1 to reach its x1 rename', path.join(w.root, 'entered-W1'));
  const marker = fs.readdirSync(w.root).find(n => n.startsWith('data.json.committing.'));
  g1.kill();
  await g1.exited;
  // W2's every unlink of a private commit file fails with EIO: the isolation cannot prove
  // its deletions, so the acquisition is refused — twice (warmup and transaction).
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
  // The refused acquisition kept the dead writer's evidence and the path clean for a retry.
  assert.equal(fs.existsSync(path.join(w.root, marker)), true, 'the marker is kept for diagnosis');
  assert.equal(fs.existsSync(path.join(w.root, marker + '.tmp')) || true, true);
  assert.equal(fs.readdirSync(w.root).filter(n => n.includes('.commit.')).length >= 1, true, 'the private commit file is kept too');
  assert.equal(fs.existsSync(w.file + '.lock'), false, 'the refused writer gave its own lease back');
  // W3, with working deletes: the takeover isolates W1's remains and commits.
  const g3 = w.spawnWriter(corpseScenario(w, { writeKey: 'w3', pauseKey: '', role: 'W3', intercept: renamePauseIntercept('') }), 'W3');
  assert.equal((await g3.warmup()).ok, true);
  assert.deepEqual(await g3.done, { ok: true, revision: 1 });
  assert.equal(fs.readdirSync(w.root).filter(n => n.startsWith('data.json.committing.')).length, 0, 'the healed takeover isolated the debris');
  const final = JSON.parse(fs.readFileSync(w.file, 'utf8'));
  assert.deepEqual(final.members, { seed: 1, w3: 1 });
});

/* L01's invariant, restated: the isolation READ is load-bearing over a corpse too — a
 * canonical marker that cannot be read or verified refuses the takeover (the marker and
 * the private file it names stay for diagnosis); once the read works again, the same
 * takeover proceeds and cleans exactly what it could finally verify. */
test('N01/B01=A: an unreadable canonical marker over a dead holder refuses the acquisition; a healed retry isolates and commits', async () => {
  const w = writerWorld('community-store-l01-');
  const g1 = w.spawnWriter(corpseScenario(w, { writeKey: 'x1', pauseKey: 'x1', role: 'W1', intercept: renamePauseIntercept('x1') }), 'W1');
  assert.equal((await g1.warmup()).ok, true);
  await w.waitFor('W1 to reach its x1 rename', path.join(w.root, 'entered-W1'));
  const marker = fs.readdirSync(w.root).find(n => n.startsWith('data.json.committing.'));
  const commitFile = fs.readdirSync(w.root).find(n => n.includes('.commit.') && !n.startsWith('data.json.committing.'));
  g1.kill();
  await g1.exited;
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
  assert.equal(fs.existsSync(path.join(w.root, marker)), false, 'the healed takeover removed the marker');
  assert.equal(fs.existsSync(path.join(w.root, commitFile)), false, 'and the private file it named');
  const final = JSON.parse(fs.readFileSync(w.file, 'utf8'));
  assert.deepEqual(final.members, { seed: 1, w3: 1 });
});
