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
import { pathToFileURL } from 'node:url';
import { createSharedStore, StoreError, NO_WRITE } from '../community/store.js';

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'community-store-i01-'));
  const file = path.join(root, 'data.json');
  const clockFile = path.join(root, 'clock');
  const base = Date.now();
  fs.writeFileSync(clockFile, String(base));
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
  console.log(JSON.stringify({ ok: true, revision: r.revision }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, code: e.code || 'unexpected' }));
}
`;
  const children = [];
  const spawnWriter = role => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childCode], {
      env: {
        ...process.env, ROLE: role, FILE: file, ROOT: root, CLOCK: clockFile,
        STORE_URL: pathToFileURL(path.join(import.meta.dirname, '../community/store.js')).href
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    children.push(child);
    const answer = new Promise((resolve, reject) => {
      child.on('exit', () => {
        const line = out.trim().split('\n').pop();
        try { resolve(JSON.parse(line)); } catch { reject(new Error(`${role} produced no result: ${out}`)); }
      });
      child.on('error', reject);
    });
    return answer;
  };
  const waitFor = async (what, p) => {
    for (let i = 0; i < 750 && !fs.existsSync(p); i++) await new Promise(r => setTimeout(r, 20));
    if (!fs.existsSync(p)) throw new Error('timed out waiting for ' + what);
  };
  const advanceClock = ms => fs.writeFileSync(clockFile, String(base + ms));
  try {
    // A: pauses between marker verify and the final rename, holding its marker.
    const markerFiles = () => fs.readdirSync(root).filter(n => n.startsWith('data.json.committing'));
    const a = spawnWriter('A');
    await waitFor('A to reach its rename', path.join(root, 'entered-A'));
    assert.ok(markerFiles().length > 0, 'A holds a commit marker (per-writer name)');

    // B (17 s of clock silence later): recovers A's lease, clears A's marker AND private
    // file, then pauses in the same spot inside its own commit.
    advanceClock(17000);
    const b = spawnWriter('B');
    await waitFor('B to reach its rename', path.join(root, 'entered-B'));
    assert.ok(markerFiles().length > 0, 'B holds a commit marker (per-writer name)');

    // A resumes and fails: its private file is gone, its abort must leave B's marker alone.
    fs.writeFileSync(path.join(root, 'release-A'), '1');
    assert.deepEqual(await a, { ok: false, code: 'write-failed' });
    assert.ok(markerFiles().length > 0, 'J01/I01: A\'s abort left B\'s marker intact — the current committer stays protected');

    // C (another 17 s): recovers B's silence — B's marker names B's private file, so the
    // takeover removes both — and commits. The acknowledged answer must survive B resuming.
    advanceClock(34000);
    const c = spawnWriter('C');
    assert.deepEqual(await c, { ok: true, revision: 1 });

    fs.writeFileSync(path.join(root, 'release-B'), '1');
    assert.deepEqual(await b, { ok: false, code: 'write-failed' });

    const final = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(final.members, { seed: 1, C: 1 }, 'C\'s acknowledged commit survives every resumed old writer');
    assert.equal(final.revision, 1);
  } finally {
    for (const child of children) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
    await new Promise(r => setTimeout(r, 50));
    fs.rmSync(root, { recursive: true, force: true });
  }
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
