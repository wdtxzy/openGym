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

test('a foreign-host lock whose heartbeat went silent is recovered (crash / rm, no signal)', () => {
  const file = path.join(dir(), 'shared.json');
  fs.writeFileSync(file + '.lock', JSON.stringify({ pid: 1, host: 'gone-container', token: 't', at: Date.now() - 60000 }));
  const s = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
  assert.equal(s.warmup().ok, true, 'a peer silent past the window no longer blocks the feature');
  assert.equal(JSON.parse(fs.readFileSync(file + '.lock', 'utf8')).host, os.hostname());
});

test('release() hands the lock back, so a recreated instance starts clean', async () => {
  const file = path.join(dir(), 'shared.json');
  const first = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
  assert.equal(first.warmup().ok, true);
  first.release();
  assert.equal(fs.existsSync(file + '.lock'), false);
  const second = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
  assert.equal(second.warmup().ok, true);
});

test('an unreadable lock is refused while fresh, recoverable once silent (F02)', () => {
  const file = path.join(dir(), 'shared.json');
  // Both flavours of non-lock: not JSON at all, and a bare number — which JSON.parse happily
  // returns, and which must never be mistaken for a live owner's lock. FRESH, either could be
  // a holder's damaged lease (a truncating write window): refuse. SILENT past the stale
  // window, it is recoverable garbage from before the token protocol.
  for (const garbage of ['not-a-pid', '99999999', '']) {
    fs.writeFileSync(file + '.lock', garbage);
    const fresh = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
    assert.equal(fresh.warmup().code, 'second-writer', `fresh garbage ${JSON.stringify(garbage)} refused`);
    const past = new Date(Date.now() - 60000);
    fs.utimesSync(file + '.lock', past, past);
    const s = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
    assert.equal(s.warmup().ok, true, `silent garbage ${JSON.stringify(garbage)} recovered`);
    assert.equal(JSON.parse(fs.readFileSync(file + '.lock', 'utf8')).pid, process.pid);
  }
});

test('F01: a deposed writer stops leasing, stops committing, and reads unhealthy', async () => {
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
test('I01: a resumed old writer never deletes the current committer’s marker — three takeovers keep the acknowledged commit', async () => {
  const w = writerWorld('community-store-i01-');
  const childCode = `
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
os.hostname = () => 'i01-writer-' + process.env.ROLE;
const clock = () => { try { return Number(fs.readFileSync(process.env.CLOCK, 'utf8')) } catch { return Date.now() } };
const { createSharedStore } = await import(process.env.STORE_URL);
const role = process.env.ROLE, file = process.env.FILE, root = process.env.ROOT;
const realRename = fs.renameSync;
let blocked = false;
fs.renameSync = function (from, to) {
  if ((role === 'A' || role === 'B') && !blocked && to === file && String(from).includes('.commit.')) {
    let mine = false;
    try { mine = !!JSON.parse(fs.readFileSync(from, 'utf8')).members[role] } catch { /* not the draft */ }
    if (mine) {
      blocked = true;
      fs.writeFileSync(path.join(root, 'entered-' + role), '1');
      const sleeper = new Int32Array(new SharedArrayBuffer(4));
      const deadline = Date.now() + 60000;
      while (!fs.existsSync(path.join(root, 'release-' + role)) && Date.now() < deadline) Atomics.wait(sleeper, 0, 0, 20);
    }
  }
  return realRename(from, to);
};
const store = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: { seed: 1 } }), now: clock });
try {
  const r = await store.txn(view => {
    const d = view.edit(); d.members[role] = 1 });
  console.log('TXN ' + JSON.stringify({ ok: true, revision: r.revision }));
} catch (e) {
  console.log('TXN ' + JSON.stringify({ ok: false, code: e.code || 'unexpected' }));
}
`;
  try {
    // A: pauses between marker verify and the final rename, holding its marker.
    const markerFiles = () => fs.readdirSync(w.root).filter(n => n.startsWith('data.json.committing'));
    const a = w.spawnWriter(childCode, 'A');
    await w.waitFor('A to reach its rename', path.join(w.root, 'entered-A'));
    assert.ok(markerFiles().length > 0, 'A holds a commit marker (per-writer name)');

    // B (17 s of clock silence later): recovers A's lease, clears A's marker AND private
    // file, then pauses in the same spot inside its own commit.
    w.advanceClock(17000);
    const b = w.spawnWriter(childCode, 'B');
    await w.waitFor('B to reach its rename', path.join(w.root, 'entered-B'));
    assert.ok(markerFiles().length > 0, 'B holds a commit marker (per-writer name)');

    // A resumes and fails: its private file is gone, its abort must leave B's marker alone.
    fs.writeFileSync(path.join(w.root, 'release-A'), '1');
    assert.deepEqual(await a.done, { ok: false, code: 'write-failed' });
    assert.ok(markerFiles().length > 0, 'J01/I01: A\'s abort left B\'s marker intact — the current committer stays protected');

    // C (another 17 s): recovers B's silence — B's marker names B's private file, so the
    // takeover removes both — and commits. The acknowledged answer must survive B resuming.
    w.advanceClock(34000);
    const c = w.spawnWriter(childCode, 'C');
    assert.deepEqual(await c.done, { ok: true, revision: 1 });

    fs.writeFileSync(path.join(w.root, 'release-B'), '1');
    assert.deepEqual(await b.done, { ok: false, code: 'write-failed' });

    const final = JSON.parse(fs.readFileSync(w.file, 'utf8'));
    assert.deepEqual(final.members, { seed: 1, C: 1 }, 'C\'s acknowledged commit survives every resumed old writer');
    assert.equal(final.revision, 1);
  } finally { await w.teardown(); }
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
test('K01: a takeover ignores the stale listing — the post-lease isolation disarms the late-committing old writer', async () => {
  const w = writerWorld('community-store-k01-');
  const childCode = `
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
os.hostname = () => 'k01-writer-' + process.env.ROLE;
const clock = () => { try { return Number(fs.readFileSync(process.env.CLOCK, 'utf8')) } catch { return Date.now() } };
const { createSharedStore } = await import(process.env.STORE_URL);
const role = process.env.ROLE, file = process.env.FILE, root = process.env.ROOT;
const waitFor = f => { while (!fs.existsSync(f)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); };
const pause = name => { fs.writeFileSync(path.join(root, 'entered-' + name), '1'); waitFor(path.join(root, 'release-' + name)); };
if (role === 'A') {
  const rename = fs.renameSync; let paused = false;
  fs.renameSync = function (from, to) {
    if (!paused && to === file && String(from).includes('.commit.') && JSON.parse(fs.readFileSync(from, 'utf8')).members.A) {
      paused = true; pause('A');
    }
    return rename(from, to);
  };
}
if (role === 'B') {
  const read = fs.readdirSync; let scanned = false;
  fs.readdirSync = function (p, ...args) {
    const out = read(p, ...args);
    if (!scanned && String(p) === root) { scanned = true; pause('inventory'); }
    return out;
  };
}
const store = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: { seed: 1 } }), now: clock });
console.log('WARMUP ' + JSON.stringify(store.warmup()));
if (role === 'A') waitFor(path.join(root, 'go-A'));
try {
  const r = await store.txn(v => { v.edit().members[role] = 1 });
  console.log('TXN ' + JSON.stringify({ ok: true, revision: r.revision }));
} catch (e) {
  console.log('TXN ' + JSON.stringify({ ok: false, code: e.code || 'unexpected' }));
}
`;
  try {
    // A is up first and holds the lease.
    const a = w.spawnWriter(childCode, 'A');
    assert.deepEqual(await a.warmup(), { ok: true, revision: 0 });
    // B boots, captures its (empty) marker listing, and pauses before returning it.
    const b = w.spawnWriter(childCode, 'B');
    await w.waitFor('B to capture its inventory', path.join(w.root, 'entered-inventory'));
    // NOW A enters the commit section: marker published, lease check passed, paused
    // before the final rename — after B's listing was taken.
    fs.writeFileSync(path.join(w.root, 'go-A'), '1');
    const aAnswer = a.done;
    await w.waitFor('A to reach its rename', path.join(w.root, 'entered-A'));
    // A's heartbeat is frozen (the pause blocks its event loop): the lease goes silent.
    w.advanceClock(17000);
    // B resumes with the stale empty listing — and must still not let A's rename land:
    // the post-acquisition isolation re-scans, sees A's marker, deletes A's private file.
    fs.writeFileSync(path.join(w.root, 'release-inventory'), '1');
    assert.deepEqual(await b.done, { ok: true, revision: 1 }, 'B commits');
    fs.writeFileSync(path.join(w.root, 'release-A'), '1');
    assert.deepEqual(await aAnswer, { ok: false, code: 'write-failed' }, 'A is disarmed');
    const final = JSON.parse(fs.readFileSync(w.file, 'utf8'));
    assert.deepEqual(final.members, { seed: 1, B: 1 }, 'K01: B\'s acknowledged commit survives the late-committing old writer');
    assert.equal(final.revision, 1);
  } finally { await w.teardown(); }
});

/* K02, the round-9 "swallowed fencing error" reproduction: the takeover DID see A's
 * marker, but the unlink of A's private commit file fails with EIO — which is not
 * "already gone". The old protocol swallowed the error, deleted the marker, took the
 * lease and committed; A's file survived and A's resumed rename overwrote the
 * acknowledged commit. The fix: an isolation that cannot PROVE its deletions refuses
 * the acquisition (lease handed back, loud 'lock' error) — B never promises a success
 * it cannot defend. A persistent EIO here means B never commits and A — the legitimate
 * lease holder, never successfully deposed — completes. */
test('K02: a fencing unlink that fails with EIO refuses the takeover — no success is promised it cannot defend', async () => {
  const w = writerWorld('community-store-k02-');
  const childCode = `
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
os.hostname = () => 'k02-writer-' + process.env.ROLE;
const clock = () => { try { return Number(fs.readFileSync(process.env.CLOCK, 'utf8')) } catch { return Date.now() } };
const { createSharedStore } = await import(process.env.STORE_URL);
const role = process.env.ROLE, file = process.env.FILE, root = process.env.ROOT;
const waitFor = f => { while (!fs.existsSync(f)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); };
const pause = name => { fs.writeFileSync(path.join(root, 'entered-' + name), '1'); waitFor(path.join(root, 'release-' + name)); };
if (role === 'A') {
  const rename = fs.renameSync; let paused = false;
  fs.renameSync = function (from, to) {
    if (!paused && to === file && String(from).includes('.commit.') && JSON.parse(fs.readFileSync(from, 'utf8')).members.A) {
      paused = true; pause('A');
    }
    return rename(from, to);
  };
  const store = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: { seed: 1 } }), now: clock });
  console.log('WARMUP ' + JSON.stringify(store.warmup()));
  waitFor(path.join(root, 'go-A'));
  try { const r = await store.txn(v => { v.edit().members.A = 1 }); console.log('TXN ' + JSON.stringify({ ok: true, revision: r.revision })) }
  catch (e) { console.log('TXN ' + JSON.stringify({ ok: false, code: e.code || 'unexpected' })) }
} else {
  // B: EVERY unlink of a private commit file (not the inner .tmp, not the marker) fails —
  // a persistent fencing fault, not a one-shot.
  const unlink = fs.unlinkSync;
  fs.unlinkSync = function (p, ...args) {
    if (String(p).includes('.commit.') && !String(p).endsWith('.tmp') && !String(p).includes('.committing'))
      throw Object.assign(new Error('injected fencing EIO'), { code: 'EIO' });
    return unlink(p, ...args);
  };
  const store = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: { seed: 1 } }), now: clock });
  console.log('WARMUP ' + JSON.stringify(store.warmup()));
  try { const r = await store.txn(v => { v.edit().members.B = 1 }); console.log('TXN ' + JSON.stringify({ ok: true, revision: r.revision })) }
  catch (e) { console.log('TXN ' + JSON.stringify({ ok: false, code: e.code || 'unexpected' })) }
}
`;
  try {
    // A commits and pauses before the final rename; its heartbeat freezes.
    const a = w.spawnWriter(childCode, 'A');
    assert.deepEqual(await a.warmup(), { ok: true, revision: 0 });
    fs.writeFileSync(path.join(w.root, 'go-A'), '1');
    await w.waitFor('A to reach its rename', path.join(w.root, 'entered-A'));
    w.advanceClock(17000); // the lease goes silent
    // B boots under a PERSISTENT fencing fault: the takeover is refused, loudly, every
    // time — B never commits and never promises a success an old writer can overwrite.
    const b = w.spawnWriter(childCode, 'B');
    const bWarmup = await b.warmup();
    assert.equal(bWarmup.ok, false);
    assert.equal(bWarmup.code, 'lock', 'the boot takeover refuses on the fencing EIO');
    assert.deepEqual(await b.done, { ok: false, code: 'lock' }, 'the transaction refuses too — no swallowed success');
    // A, the legitimate holder never successfully deposed, completes its commit.
    fs.writeFileSync(path.join(w.root, 'release-A'), '1');
    assert.deepEqual(await a.done, { ok: true, revision: 1 });
    const final = JSON.parse(fs.readFileSync(w.file, 'utf8'));
    assert.deepEqual(final.members, { seed: 1, A: 1 }, 'K02: no acknowledged write was lost — A completes, B never pretended');
  } finally { await w.teardown(); }
});

/* K02's benign twin: an ENOENT during isolation IS the proof the file is gone — a marker
 * whose recorded private file was already cleaned up (crash debris) clears normally and
 * never refuses the acquisition. */
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
test('L01: a paused, fully-reviewed old writer plus a marker-read EIO — the takeover refuses, the acknowledged write survives', async () => {
  const w = writerWorld('community-store-l01-');
  const childCode = `
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
os.hostname = () => 'l01-writer-' + process.env.ROLE;
const clock = () => { try { return Number(fs.readFileSync(process.env.CLOCK, 'utf8')) } catch { return Date.now() } };
const { createSharedStore } = await import(process.env.STORE_URL);
const role = process.env.ROLE, file = process.env.FILE, root = process.env.ROOT;
const waitFor = f => { while (!fs.existsSync(f)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); };
const pause = name => { fs.writeFileSync(path.join(root, 'entered-' + name), '1'); waitFor(path.join(root, 'release-' + name)); };
if (role === 'A') {
  const rename = fs.renameSync; let paused = false;
  fs.renameSync = function (from, to) {
    if (!paused && to === file && String(from).includes('.commit.') && JSON.parse(fs.readFileSync(from, 'utf8')).members.A) {
      paused = true; pause('A');
    }
    return rename(from, to);
  };
} else {
  // B: every read of a canonical commit marker fails — the isolation cannot verify.
  const readFile = fs.readFileSync;
  fs.readFileSync = function (p, ...args) {
    const n = path.basename(String(p));
    if (n.startsWith('data.json.committing.') && (n === 'data.json.committing' || /^[0-9a-f]+$/.test(n.slice('data.json.committing.'.length))))
      throw Object.assign(new Error('injected marker read EIO'), { code: 'EIO' });
    return readFile(p, ...args);
  };
}
const store = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: { seed: 1 } }), now: clock });
console.log('WARMUP ' + JSON.stringify(store.warmup()));
if (role === 'A') waitFor(path.join(root, 'go-A'));
try { const r = await store.txn(v => { v.edit().members[role] = 1 }); console.log('TXN ' + JSON.stringify({ ok: true, revision: r.revision })) }
catch (e) { console.log('TXN ' + JSON.stringify({ ok: false, code: e.code || 'unexpected' })) }
`;
  try {
    const a = w.spawnWriter(childCode, 'A');
    assert.equal((await a.warmup()).ok, true);
    fs.writeFileSync(path.join(w.root, 'go-A'), '1');
    await w.waitFor('A to reach its rename', path.join(w.root, 'entered-A'));
    w.advanceClock(17000); // A's heartbeat goes silent
    const b = w.spawnWriter(childCode, 'B');
    const bWarmup = await b.warmup();
    assert.equal(bWarmup.ok, false);
    assert.equal(bWarmup.code, 'lock', 'the takeover refuses on the unreadable marker');
    assert.ok(/cannot verify/.test(bWarmup.detail || ''), 'the refusal is diagnosable: ' + bWarmup.detail);
    assert.deepEqual(await b.done, { ok: false, code: 'lock' }, 'the transaction refuses too — no swallowed success');
    fs.writeFileSync(path.join(w.root, 'release-A'), '1');
    assert.deepEqual(await a.done, { ok: true, revision: 1 });
    const final = JSON.parse(fs.readFileSync(w.file, 'utf8'));
    assert.deepEqual(final.members, { seed: 1, A: 1 }, 'L01: no acknowledged write was lost — A completes, B never pretended');
    assert.equal(fs.readdirSync(w.root).filter(n => n.startsWith('data.json.committing.')).length, 0, 'A cleaned its own marker on the success path');
  } finally { await w.teardown(); }
});

/* M01, the round-11 takeover-restore race: a refused contender used to put the captured
 * lease back with a plain rename — which OVERWRITES whatever claimed the emptied public
 * path while the capture held it. Here B judges the dead fixture's stale lease, pauses
 * around its capture; C takes over for real and pauses; B's capture then grabs C's lease
 * (the public path stands empty); D claims the empty path, commits D1 and pauses inside
 * D2's final rename. The old restore wrote C's lease OVER D's: C's own token sat on the
 * public path again, C passed its lease check and committed, and D's resumed rename
 * erased C's acknowledged data. Now the restore is exclusive (link, EEXIST on any
 * existing target): B refuses, D's lease stays the authority, C — deposed — refuses, and
 * D's acknowledged commits survive. */
test('M01: a refused takeover never restores the captured lease over the current holder — the acknowledged commits survive', async () => {
  const w = writerWorld('community-store-m01-');
  // A dead holder's stale lease, as a crash would leave it: foreign host, silent way
  // past the takeover window. The clock file stays at `base` the whole scenario, so
  // only this fixture is ever stale.
  fs.writeFileSync(w.file, JSON.stringify({ schemaVersion: 1, revision: 0, updatedAt: Date.now(), members: { seed: 1 } }));
  fs.writeFileSync(w.file + '.lock', JSON.stringify({ pid: 99999999, host: 'dead-fixture', token: '0'.repeat(32), at: Date.now() - 60000 }));
  const childCode = `
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
os.hostname = () => 'm01-writer-' + process.env.ROLE;
const clock = () => { try { return Number(fs.readFileSync(process.env.CLOCK, 'utf8')) } catch { return Date.now() } };
const { createSharedStore } = await import(process.env.STORE_URL);
const role = process.env.ROLE, file = process.env.FILE, root = process.env.ROOT;
const waitFor = f => { while (!fs.existsSync(f)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); };
const pause = name => { fs.writeFileSync(path.join(root, 'entered-' + name), '1'); waitFor(path.join(root, 'release-' + name)); };
const rename = fs.renameSync;
let intercepted = false;
fs.renameSync = function (from, to) {
  if (role === 'B' && !intercepted && from === file + '.lock' && String(to).startsWith(file + '.lock.take.')) {
    intercepted = true;
    pause('B-before-capture');
    const out = rename(from, to);
    pause('B-after-capture');
    return out;
  }
  if (role === 'D' && to === file && String(from).includes('.commit.') && JSON.parse(fs.readFileSync(from, 'utf8')).members.D2) pause('D2-verified');
  return rename(from, to);
};
const store = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: { seed: 1 } }), now: clock });
const warmup = store.warmup();
console.log('WARMUP ' + JSON.stringify(warmup));
if (role === 'C' && warmup.ok) pause('C-ready');
if (role !== 'B') {
  const txn = async key => {
    try { const r = await store.txn(v => { v.edit().members[key] = 1 }); console.log('TXN ' + JSON.stringify({ key, ok: true, revision: r.revision })) }
    catch (e) { console.log('TXN ' + JSON.stringify({ key, ok: false, code: e.code || 'unexpected' })) }
  };
  if (role === 'D') { await txn('D1'); await txn('D2') } else await txn('C');
}
`;
  const lockToken = () => { try { return JSON.parse(fs.readFileSync(w.file + '.lock', 'utf8')).token } catch { return null } };
  try {
    // B judges the dead fixture stale and pauses right before its capture.
    const b = w.spawnWriter(childCode, 'B');
    await w.waitFor('B to reach its capture', path.join(w.root, 'entered-B-before-capture'));
    // C takes the stale lease over for real and holds it, paused before any business write.
    const c = w.spawnWriter(childCode, 'C');
    await w.waitFor('C to hold its lease', path.join(w.root, 'entered-C-ready'));
    const cToken = lockToken();
    assert.ok(cToken && cToken !== '0'.repeat(32), 'C owns the lease now');
    // B's capture moves the PUBLIC lock — C's lease — into B's private tombstone.
    fs.writeFileSync(path.join(w.root, 'release-B-before-capture'), '1');
    await w.waitFor('B to finish its capture', path.join(w.root, 'entered-B-after-capture'));
    assert.equal(lockToken(), null, 'the public path stands empty while the capture holds the lease');
    // D claims the emptied path, commits D1, and pauses inside D2's final rename —
    // marker published, lease review passed.
    const d = w.spawnWriter(childCode, 'D');
    await w.waitFor('D to reach its D2 rename', path.join(w.root, 'entered-D2-verified'));
    const dToken = lockToken();
    assert.ok(dToken && dToken !== cToken, 'D claimed the path while B held the tomb');
    const afterD1 = JSON.parse(fs.readFileSync(w.file, 'utf8'));
    assert.deepEqual(afterD1.members, { seed: 1, D1: 1 }, 'D1 is acknowledged before the race resolves');
    // B resumes, sees it captured C instead of the judged fixture, and refuses — the
    // restore must not be able to unseat D.
    fs.writeFileSync(path.join(w.root, 'release-B-after-capture'), '1');
    const bWarmup = await b.warmup();
    assert.equal(bWarmup.ok, false);
    assert.equal(bWarmup.code, 'second-writer', 'B refuses the race it lost');
    assert.equal(lockToken(), dToken, 'M01: the refused contender did not restore C\u2019s lease over D\u2019s');
    assert.equal(fs.readdirSync(w.root).filter(n => n.includes('.lock.take.')).length, 0, 'the tombstone went with the refusal');
    // C resumes: its token is nowhere — the deposed writer refuses instead of committing.
    fs.writeFileSync(path.join(w.root, 'release-C-ready'), '1');
    const cResult = await c.done;
    assert.equal(cResult.ok, false, 'the deposed writer refuses (a deposed commit would be the resurrection)');
    // D completes D2: the acknowledged data survives every resumed writer.
    fs.writeFileSync(path.join(w.root, 'release-D2-verified'), '1');
    const dResult = await d.done;
    assert.deepEqual(dResult, { key: 'D2', ok: true, revision: 2 });
    const final = JSON.parse(fs.readFileSync(w.file, 'utf8'));
    assert.deepEqual(final.members, { seed: 1, D1: 1, D2: 1 }, 'M01: D\u2019s acknowledged commits are all still there');
  } finally { await w.teardown(); }
});

/* The heartbeat is the other way a dead token could come back: a holder that lost its
 * lease while paused must not write its lease over the public path when it resumes. The
 * refresh is conditional on the path still naming us — a foreign token there deposes the
 * paused holder instead of being clobbered. */
test('M01: a deposed holder\u2019s heartbeat never rewrites the lease that replaced it', async () => {
  const file = path.join(dir(), 'beaten.json');
  const s = createSharedStore({ file, schemaVersion: 1, init: () => ({ members: {} }) });
  try {
    assert.equal(s.warmup().ok, true);
    const own = JSON.parse(fs.readFileSync(file + '.lock', 'utf8'));
    assert.equal(own.pid, process.pid);
    // Another host legitimately took the lease over while this process "paused" — its
    // own heartbeat already silent long enough for the takeover to be honest.
    const foreign = { pid: 424242, host: 'recovered-elsewhere', token: 'f'.repeat(32), at: Date.now() - 60000 };
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
