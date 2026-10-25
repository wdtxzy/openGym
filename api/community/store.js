/* One shared JSON file, changed only through serialized read-modify-write transactions.
 *
 * The community features (leaderboard, social) keep their data in DATA_DIR/leaderboard.json and
 * DATA_DIR/social.json — flat files like everything else this API owns, no database, per the
 * PRD's single-writer capacity decision (50–500 members, one API write process). But a plain
 * load-modify-save is not enough when a dozen async request handlers can interleave between
 * awaits: two likes landing together would each read the same snapshot and one would silently
 * lose the other's write. So every mutation goes through `txn`, which chains all read-modify-
 * write sections into one queue — inside a single process that is the whole concurrency story.
 *
 * The file is written the way every other file here is (durable.js: temp name, fsync, rename,
 * fsync of the directory), and it carries `schemaVersion` and `revision` so a client can do
 * optimistic compares and an operator can see the shape. A file that is not JSON, or carries a
 * schemaVersion this build does not know, is refused — never re-initialized over: the PRD is
 * explicit that a damaged shared file must survive untouched for an operator to look at, so
 * every route then answers 503 until the process is restarted with the file fixed or removed.
 *
 * A `<file>.lock` holding a live PID refuses a second API process touching the same data
 * directory (both containers mounting one volume, an accidental second `npm start`): the
 * newcomer logs a clear error and every route answers 503, instead of two processes quietly
 * erasing each other's revisions. The check is best-effort — a PID file without a live PID is
 * a stale lock from a crash, and is taken over. */
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { atomicWrite } from '../durable.js';

/** Refused operation on a shared store. `code` is stable for the API error table. */
export class StoreError extends Error {
  constructor(code, detail) {
    super(detail || code);
    this.code = code;
  }
}

/** Returned from a transaction callback when it changed nothing: the file is not rewritten,
 *  the revision does not move, and the answer carries the current revision (N07 — a repeated
 *  cheer or the removal of an absent one must not cost a full-file fsync). */
export const NO_WRITE = Symbol('no-write');

/** A PID that answers signal 0 (or that we may not signal, EPERM: alive but not ours). */
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

export function createSharedStore({ file, schemaVersion, init, writer = atomicWrite, now = Date.now }) {
  const lockFile = file + '.lock';
  const commitMarker = file + '.committing';
  // Ownership is a random token, minted per store instance and written in the lock — never a
  // bare PID: two containers on one volume are both "pid 1" (N05). The hostname rides along so
  // liveness stays a same-host judgement; a foreign-host holder is honoured as live UNLESS its
  // heartbeat went silent past STALE_HOST_MS — the cross-container recovery path for a crash
  // or a `docker rm` that no signal could clean up after (T04). A graceful stop releases the
  // lock outright (release(), wired to SIGTERM in server.js), so a normal recreate needs no
  // window at all.
  const myToken = crypto.randomBytes(16).toString('hex');
  const myHost = os.hostname();
  const HEARTBEAT_MS = 1000;
  const STALE_HOST_MS = 15000;
  const readLock = () => {
    try { return JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { return null; }
  };
  const readAt = f => {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
  };
  const lockBody = () => JSON.stringify({ pid: process.pid, host: myHost, token: myToken, at: now() });
  const claimLock = () => {
    const fd = fs.openSync(lockFile, 'wx');
    try { fs.writeSync(fd, lockBody()); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  };
  const iOwn = holder => holder && holder.token === myToken;
  // The lease is rewritten ATOMICALLY (temp + rename), never by truncating the lock in place:
  // a truncating write leaves a moment where the lock reads empty and a peer would take the
  // file for ownerless (F02). Deposition (F01): a holder whose lease was taken over while it
  // was paused must not simply write its token back — every refresh is CONDITIONAL on the
  // lock still naming us, and a holder that finds someone else's token deposes itself: no
  // further leases, no further commits, until the process restarts.
  let heartbeat = null;
  let deposed = false;      // another writer took the lease from us: refuse everything since
  const refreshLease = () => {
    if (!locked || deposed) return false;
    const holder = readLock();
    if (!iOwn(holder)) {
      // Not our lock anymore (a peer recovered it while this process was paused/crashed).
      // Stop claiming to be the writer: leases stop, commits stop, reads refuse.
      deposed = true;
      locked = false;
      refused = new StoreError('lost-lock', `${file}: another writer owns the lease now`);
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
      return false;
    }
    const tmp = lockFile + '.beat.' + crypto.randomBytes(4).toString('hex');
    try {
      fs.writeFileSync(tmp, lockBody());
      fs.renameSync(tmp, lockFile);
      return true;
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* never got created */ }
      return false; // a hand we will notice on the next refresh or at commit
    }
  };
  const beat = () => {
    if (heartbeat || !locked) return;
    heartbeat = setInterval(() => {
      if (!locked || deposed) { clearInterval(heartbeat); heartbeat = null; return; }
      refreshLease();
    }, HEARTBEAT_MS);
    heartbeat.unref?.();
  };

  let data = null;        // the parsed cache; null until the first successful load
  let refused = null;     // a StoreError once the file proved unusable — sticky until restart
  let knownMtime = 0;     // our own writes update it; a different mtime means an external hand
  let locked = false;
  let queue = Promise.resolve();

  /* Best-effort single-writer guard (see header). Acquire is the atomic 'wx' create; EEXIST is
   * resolved by the holder's TOKEN, not by guessing from PIDs. Taking over a stale lock re-reads
   * the holder immediately before removing it and gives up (refuses) the moment the lock names
   * anyone else — a contender that won the stale lock after our judgement is never unseated.
   * A lock that exists but does not parse is NOT automatically ownerless (F02): fresh, it is
   * someone's mid-write or damaged lease and we refuse; only silent past the stale window may
   * it be recovered, exactly like a crashed foreign holder. */
  function lock() {
    if (refused) throw new StoreError(refused.code, refused.message); // settled: refuse with a clean error
    if (locked) return;
    // A commit marker is the commit protocol's critical section (G01): fresh, the "dead"
    // writer may simply be mid-commit — refuse. Silent past the stale window, it is debris
    // from a crash between rename and cleanup, and the takeover may clear it.
    try {
      const markerAge = now() - fs.statSync(commitMarker).mtimeMs;
      if (markerAge <= STALE_HOST_MS) throw new StoreError('second-writer', `${file}: a commit is in progress`);
      fs.unlinkSync(commitMarker);
    } catch (e) {
      if (e instanceof StoreError) throw e;
      if (e.code !== 'ENOENT') throw new StoreError('lock', e.message);
    }
    try {
      claimLock();
      locked = true;
      beat();
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw new StoreError('lock', e.message);
    }
    let holder = readLock();
    if (iOwn(holder)) { locked = true; beat(); return; }       // our own, from this store
    const lockAge = () => {
      try { return now() - fs.statSync(lockFile).mtimeMs; } catch { return STALE_HOST_MS + 1; }
    };
    const judge = h => {
      if (h && h.token) {
        if (h.host !== myHost) {
          // Cross-container: live while the heartbeat is fresh; silent past STALE_HOST_MS, the
          // holder crashed without a signal and a recreated instance may recover the file (T04).
          const age = typeof h.at === 'number' ? now() - h.at : Infinity;
          return age <= STALE_HOST_MS ? 'foreign-host' : 'foreign-stale';
        }
        if (h.pid === process.pid) return 'same-pid';         // provably THIS process: may take over
        return pidAlive(h.pid) ? 'live' : 'dead';
      }
      // Unparseable or token-less: garbage from before this protocol, or a lease damaged in
      // flight. Fresh, it is not ours to touch (F02); silent, it may be recovered.
      return lockAge() <= STALE_HOST_MS ? 'unreadable-fresh' : 'gone';
    };
    const verdict = judge(holder);
    if (verdict === 'live' || verdict === 'foreign-host' || verdict === 'unreadable-fresh')
      throw new StoreError('second-writer', `${verdict} holder (${JSON.stringify(holder)}) owns ${file}`);
    // Stale. The takeover is capture-verify-discard against THE HOLDER WE JUDGED (the first
    // read) — never against a fresher re-read, which a live contender could already own (T03):
    // the lock is atomically MOVED to a private tombstone, and only what that captured —
    // still the judged holder's token, or still nothing — is discarded and claimed. Anything
    // else is put back and we refuse.
    let markerFd = null;
    try {
      markerFd = fs.openSync(commitMarker, 'wx');
      fs.closeSync(markerFd);
      markerFd = null;
    } catch (e) {
      if (e.code === 'EEXIST') throw new StoreError('second-writer', `${file}: another commit is in progress`);
      throw new StoreError('lock', e.message);
    }
    const tomb = lockFile + '.take.' + crypto.randomBytes(6).toString('hex');
    let captured = null;
    try { fs.renameSync(lockFile, tomb); captured = readAt(tomb); }
    catch (e) { if (e.code !== 'ENOENT') throw new StoreError('lock', e.message); }
    const judgedToken = holder && typeof holder === 'object' && holder.token ? holder.token : null;
    const capturedToken = captured && typeof captured === 'object' && captured.token ? captured.token : null;
    const safeToDiscard = judgedToken ? capturedToken === judgedToken : !capturedToken;
    if (!safeToDiscard) {
      // What the tombstone captured is not what we judged: a contender owns the lock now.
      try { fs.renameSync(tomb, lockFile); } catch { try { fs.unlinkSync(tomb); } catch { /* gone */ } }
      try { fs.unlinkSync(commitMarker); } catch { /* keep recovery honest */ }
      throw new StoreError('second-writer', `lost the takeover race for ${file}`);
    }
    try { fs.unlinkSync(tomb); } catch { /* already gone */ }
    try {
      claimLock();
      locked = true;
      beat();
    } catch (e) {
      try { fs.unlinkSync(commitMarker); } catch { /* keep recovery honest */ }
      if (e.code === 'EEXIST') throw new StoreError('second-writer', `lost the takeover race for ${file}`);
      throw new StoreError('lock', e.message);
    }
    try { fs.unlinkSync(commitMarker); } catch { /* keep recovery honest */ }
  }

  /** Graceful shutdown: release the lock so a recreated instance starts clean instead of
   *  waiting out the heartbeat window (T04). Best-effort — a crash leaves the stale-heartbeat
   *  path as the fallback. */
  function release() {
    if (!locked) return;
    locked = false;
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    try {
      const holder = readLock();
      if (iOwn(holder)) fs.unlinkSync(lockFile);
    } catch { /* nothing more we can do honestly */ }
  }

  /* The commit protocol (G01): a lease check and the actual write are two steps, and a
   * process paused between them used to come back and overwrite the writer that had properly
   * taken over. Now the injectable writer only ever produces a PRIVATE temp file; the real
   * file is reached through a commit marker that a takeover must honour:
   *   writer(tmp) — no shared state touched, however long this takes
   *   create <file>.committing (wx)      — only one committer at a time, anywhere
   *   verify the lease still ours        — a recovered-over writer deposes here, writes nothing
   *   rename(tmp → file)                 — the atomic commit
   *   remove marker, refresh lease
   * A takeover sees a fresh marker and refuses (the "dead" writer is mid-commit); a marker
   * silent past the stale window is crash debris and is removed. */
  function persist(draft) {
    if (!locked || deposed) throw new StoreError('lost-lock', `${file}: not the lease owner`);
    const tmpData = `${file}.commit.${crypto.randomBytes(6).toString('hex')}`;
    try {
      writer(tmpData, JSON.stringify(draft, null, 2) + '\n', 0o600);
    } catch (e) {
      try { fs.unlinkSync(tmpData); } catch { /* never got written */ }
      throw new StoreError('write-failed', e.message);
    }
    let markerFd = null;
    try {
      markerFd = fs.openSync(commitMarker, 'wx');
      fs.writeSync(markerFd, JSON.stringify({ pid: process.pid, host: myHost, token: myToken, at: now() }));
      fs.closeSync(markerFd);
      markerFd = null;
    } catch (e) {
      try { fs.closeSync(markerFd); } catch { /* not open */ }
      markerFd = null;
      try { fs.unlinkSync(tmpData); } catch { /* keep the disk honest */ }
      if (e.code === 'EEXIST') throw new StoreError('second-writer', `${file}: another commit is in progress`);
      throw new StoreError('write-failed', e.message);
    }
    try {
      if (!iOwn(readLock())) {
        deposed = true;
        locked = false;
        refused = new StoreError('lost-lock', `${file}: another writer owns the lease now`);
        if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
        throw refused;
      }
      fs.renameSync(tmpData, file);
      knownMtime = fs.statSync(file).mtimeMs;
    } catch (e) {
      try { fs.unlinkSync(tmpData); } catch { /* already renamed or never written */ }
      try { fs.unlinkSync(commitMarker); } catch { /* keep recovery honest */ }
      if (e instanceof StoreError) throw e;
      throw new StoreError('write-failed', e.message);
    }
    try { fs.unlinkSync(commitMarker); } catch { /* a crash here leaves recoverable debris */ }
    refreshLease(); // a long commit must not look abandoned, and a lost lease surfaces now
  }

  function load() {
    if (refused) throw refused;
    if (data) {
      // Edits while the service runs are not supported. An external change we can still
      // validate is adopted; one we cannot (unparseable, wrong schema, file gone) refuses the
      // store — sticky, until restart — rather than serving or overwriting from a cache the
      // operator has already moved past: the damaged original has to survive for a person.
      let mtime = 0;
      try { mtime = fs.statSync(file).mtimeMs; } catch { mtime = -1; }
      if (mtime !== 0 && mtime !== knownMtime) {
        if (mtime === -1) { refused = new StoreError('missing', `${file} disappeared underneath us`); throw refused; }
        try {
          const reparsed = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (!reparsed || reparsed.schemaVersion !== schemaVersion) throw new Error('schema');
          data = reparsed;
          knownMtime = mtime;
        } catch (e) {
          refused = new StoreError('corrupt', `external change is not readable (${e.message})`);
          throw refused;
        }
      }
      return data;
    }
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
      knownMtime = fs.statSync(file).mtimeMs;
    } catch (e) {
      if (e.code !== 'ENOENT') { refused = new StoreError('unreadable', e.message); throw refused; }
      // Initialize disk-first: a failed initial write leaves no cache, so the next warmup
      // retries honestly instead of reporting an ok that exists only in memory.
      const fresh = { schemaVersion, revision: 0, updatedAt: now(), ...init() };
      persist(fresh);
      data = fresh;
      return data;
    }
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) { refused = new StoreError('corrupt', e.message); throw refused; }
    if (!parsed || typeof parsed !== 'object' || parsed.schemaVersion !== schemaVersion) {
      refused = new StoreError('schema', `expected schemaVersion ${schemaVersion}, found ${JSON.stringify(parsed?.schemaVersion)}`);
      throw refused;
    }
    data = parsed;
    return data;
  }

  return {
    /** Graceful shutdown: hand the lock back so a recreated instance starts clean (T04). */
    release,

    /** Cheap liveness for a deploy probe: false once the store refused (second writer,
     *  damaged file) — the container is up but this feature is not. */
    healthy() {
      // Ownership, not just cache presence (F01): a deposed writer must read as unavailable.
      return !refused && data != null && locked && !deposed;
    },

    /** The live cached object, NOT copied — for read-only request paths over a large shared
     *  file (board reads), where cloning every like on every GET is the difference between
     *  milliseconds and the load-test timeouts (N07). Callers must not mutate it; anything
     *  that does belongs in a txn, where the draft is a private clone. */
    peek() {
      lock();
      return load();
    },

    /** A private copy of the current state. Refused (throws StoreError) when unusable. */
    read() {
      lock();
      return structuredClone(load());
    },

    /** Run `fn(draft)` against a private draft and persist the result. `fn` may be async:
     *  the queue awaits it before anything is written, so a mutation made after an await
     *  lands on disk too, and the next transaction still starts only after this one settles.
     *  `fn`'s return value is passed back; a throw from `fn` or a failed write leaves file
     *  and cache untouched, and the next transaction runs after a failure — never wedged. */
    txn(fn) {
      // lock() lives INSIDE the queued run: a refused/deposed store must answer with a
      // REJECTION, not a synchronous throw out of txn() itself (callers await it).
      const run = async () => {
        lock();
        const current = load();
        const draft = structuredClone(current);
        const out = fn(draft);
        const value = (out && typeof out.then === 'function') ? await out : out;
        if (value === NO_WRITE) return { revision: current.revision || 0, out: undefined };
        draft.revision = (current.revision || 0) + 1;
        draft.updatedAt = now();
        persist(draft);
        data = draft;
        return { revision: draft.revision, out: value };
      };
      const p = queue.then(run, run);
      queue = p.catch(() => {});
      return p;
    },

    /** Boot-time probe: takes the lock, loads (or initializes) the file. `{ ok }` rather than
     *  a throw so server.js can log the exact refusal and keep /api/health answering. */
    warmup() {
      try { lock(); load(); return { ok: true, revision: data.revision || 0 }; }
      catch (e) {
        if (e instanceof StoreError) return { ok: false, code: e.code, detail: e.message };
        return { ok: false, code: 'unexpected', detail: e.message };
      }
    },
  };
}
