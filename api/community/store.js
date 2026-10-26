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
import path from 'node:path';
import { atomicWrite, syncDir } from '../durable.js';
import os from 'node:os';
import crypto from 'node:crypto';


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

  /** H01: removing a commit marker must also remove the private commit file it recorded —
   *  a paused committer's final rename then fails ENOENT instead of overwriting the writer
   *  that took over. Both temp layers are the recorded commit's property. */
  function clearMarker() {
    try {
      const marker = readAt(commitMarker);
      if (marker && marker.tmp) {
        try { fs.unlinkSync(marker.tmp); } catch { /* already gone */ }
        try { fs.unlinkSync(marker.tmp + '.tmp'); } catch { /* inner layer */ }
      }
    } catch { /* unparseable marker: the takeover's own checks decide */ }
    try { fs.unlinkSync(commitMarker); } catch { /* already gone */ }
  }

  /** I01: publish the commit marker ATOMICALLY. The full body — token, lease owner, and the
   *  private commit file's name — is written to a private temp file and then linked into
   * place: the shared name appears fully formed or not at all. The old open('wx')+write left
   * a window where a takeover read a partial (empty) marker, could not learn which private
   * file to remove, deleted the marker anyway, and the paused committer's rename then landed
   * over the writer that had taken over. link() is the exclusive atomic create. */
  function publishMarker(tmpData) {
    const mtmp = commitMarker + '.new.' + crypto.randomBytes(6).toString('hex');
    let fd = null;
    try {
      fd = fs.openSync(mtmp, 'wx');
      // No fsync here, by measurement and by analysis: the marker is recovery ADVICE, not
      // data — a marker lost to a power cut means the crashed writer's private temp file
      // survives as harmless debris (it never renamed), and a marker that DID land is
      // cleared with its temp file by the takeover. Durability is not what the takeover
      // depends on; atomic APPEARANCE (below) is. The extra fsync cost every write ~35 ms
      // on container filesystems (verify7 capacity re-run).
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, host: myHost, token: myToken, at: now(), tmp: tmpData }));
      fs.closeSync(fd);
      fd = null;
      try { fs.linkSync(mtmp, commitMarker); }
      catch (e) {
        try { fs.unlinkSync(mtmp); } catch { /* never linked */ }
        if (e.code === 'EEXIST') throw new StoreError('second-writer', `${file}: another commit is in progress`);
        throw new StoreError('write-failed', e.message);
      }
      try { fs.unlinkSync(mtmp); } catch { /* the link already owns the inode */ }
    } catch (e) {
      if (fd != null) try { fs.closeSync(fd); } catch { /* not open */ }
      try { fs.unlinkSync(mtmp); } catch { /* never created */ }
      if (e instanceof StoreError) throw e;
      throw new StoreError('write-failed', e.message);
    }
  }

  /** I01: remove the shared commit marker only while it still names THIS exact commit. A
   *  writer paused mid-commit that comes back after a takeover must never delete the marker
   *  of the writer that now owns the critical section — that is how a third writer's takeover
   *  missed the current committer's private file and the resumed writer renamed over an
   *  acknowledged commit. Capture-verify-discard, exactly like the lock takeover: the marker
   *  is atomically MOVED to a private tombstone, and only a tombstone that still records this
   *  commit's token and temp name is discarded. Anything else is linked back into place —
   *  link is exclusive, so a marker that meanwhile reappeared is never clobbered. */
  function removeOwnMarker(tmpData) {
    const tomb = commitMarker + '.old.' + crypto.randomBytes(6).toString('hex');
    try { fs.renameSync(commitMarker, tomb); }
    catch (e) {
      if (e.code === 'ENOENT') return; // no marker: nothing of ours to remove
      throw new StoreError('write-failed', e.message);
    }
    const captured = readAt(tomb);
    if (captured && captured.token === myToken && captured.tmp === tmpData) {
      try { fs.unlinkSync(tomb); } catch { /* already gone */ }
      return;
    }
    // Not ours — a takeover recovered this commit and another writer is mid-commit. Put the
    // captured marker back, but only while the shared name is still free (EEXIST: a newer
    // marker owns it; the captured one's writer re-verifies its own marker and deposes
    // safely). The commit this pass aborted for has nothing left on disk either way: its
    // private file was already cleaned up by its own path.
    try {
      fs.linkSync(tomb, commitMarker);
      try { fs.unlinkSync(tomb); } catch { /* the link owns the inode now */ }
    } catch {
      try { fs.unlinkSync(tomb); } catch { /* already gone */ }
    }
  }
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
  let epoch = 0;          // moves every time `data` is (re)assigned: a commit, the init, an external adopt — the cheap "did anything change" key a read cache can hang off (revision alone cannot: an adopted external file may carry the same number)
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
    // A commit marker is the commit protocol's critical section (G01): fresh, the writer
    // that owns it may simply be mid-commit — refuse while that writer's LEASE is alive.
    // A fresh marker over a dead/gone lease is crash debris between the data rename and the
    // marker cleanup: the commit itself is already atomic (rename), so clearing the marker
    // and proceeding with the normal takeover loses nothing.
    try {
      const markerAge = now() - fs.statSync(commitMarker).mtimeMs;
      if (markerAge <= STALE_HOST_MS) {
        const holder = readLock();
        const leaseAlive = holder && holder.token && (holder.host !== myHost
          ? (typeof holder.at === 'number' && now() - holder.at <= STALE_HOST_MS)
          : (holder.pid === process.pid || pidAlive(holder.pid)));
        if (leaseAlive) throw new StoreError('second-writer', `${file}: a commit is in progress`);
        clearMarker();
      } else {
        clearMarker();
      }
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
    // H01: the marker recorded the paused committer's private file — remove it (both layers)
    // so its final rename fails instead of overwriting what we are about to commit.
    try {
      const marker = readAt(commitMarker);
      if (marker && marker.tmp) {
        try { fs.unlinkSync(marker.tmp); } catch { /* already gone */ }
        try { fs.unlinkSync(marker.tmp + '.tmp'); } catch { /* inner layer */ }
      }
    } catch { /* marker vanished mid-recovery: the commit-critical-section check re-runs below */ }
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

  /* The commit protocol (G01/H01/I01). A lease check and the actual write are two steps, and
   * a process paused between them must never come back and overwrite the writer that properly
   * took over — nor may its cleanup break the NEXT writer's protection:
   *   writer(tmp)                         — a PRIVATE temp file, no shared state touched
   *   publish <file>.committing (link)    — atomic + exclusive; records token AND tmp's name
   *   verify the marker still names us    — a recovered-over writer deposes here, writes nothing
   *   rename(tmp → file) + dir fsync      — the atomic commit (H06 keeps durable.js's contract)
   *   removeOwnMarker(tmp)                — ONLY while the marker still names THIS commit
   *   refresh lease
   * The exclusivity proof is the RESOURCE the rename consumes: every takeover that could
   * commit its own data first clears the marker it finds (which names the paused writer's
   * private file, and removes it), so a resumed committer's rename fails ENOENT instead of
   * landing. That guarantee holds only while NOBODY deletes a marker without handling its
   * recorded file — which is exactly what the old unconditional cleanup did (I01): a resumed
   * writer's abort deleted the CURRENT writer's marker, the next takeover then never learned
   * of that writer's private file, and the writer resumed straight over an acknowledged
   * commit. Marker creation is atomic (no partial reads) and removal is ownership-checked
   * (capture-verify-discard); a takeover sees a fresh marker and refuses, and a marker silent
   * past the stale window is crash debris it clears — with the private file it names. */
  function persist(draft) {
    if (!locked || deposed) throw new StoreError('lost-lock', `${file}: not the lease owner`);
    const tmpData = `${file}.commit.${crypto.randomBytes(6).toString('hex')}`;
    try {
      writer(tmpData, JSON.stringify(draft, null, 2) + '\n', 0o600);
    } catch (e) {
      cleanupTemp(tmpData);
      throw new StoreError('write-failed', e.message);
    }
    // I01: the marker appears ATOMICALLY and fully formed (publishMarker) — a takeover
    // can never read a half-written marker, miss the private commit file's name, and leave
    // a paused committer's rename free to land over the next writer's commit.
    publishMarker(tmpData);
    try {
      // Re-verify the MARKER (not just the lease): it is what the takeover clears.
      const marker = readAt(commitMarker);
      if (!marker || marker.token !== myToken || !iOwn(readLock())) {
        deposed = true;
        locked = false;
        refused = new StoreError('lost-lock', `${file}: another writer owns the lease now`);
        if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
        throw refused;
      }
      fs.renameSync(tmpData, file);
      knownMtime = fs.statSync(file).mtimeMs;
      syncDir(path.dirname(file)); // H06: the project's durable contract ends with a dir fsync
    } catch (e) {
      cleanupTemp(tmpData);
      // I01: the abort may remove ONLY this commit's own marker — a takeover may already
      // have replaced it with the next writer's, and deleting that one is how a resumed
      // writer's cleanup set up a later writer to overwrite an acknowledged commit.
      try { removeOwnMarker(tmpData); } catch { /* the marker stays; a takeover recovers it */ }
      if (e instanceof StoreError) throw e;
      throw new StoreError('write-failed', e.message);
    }
    // I01: same ownership rule on the success path — between this commit's rename and this
    // cleanup a full takeover cycle may have happened, and the marker on disk may already
    // be a newer writer's.
    try { removeOwnMarker(tmpData); } catch { /* recoverable debris; a takeover clears it */ }
    refreshLease(); // a long commit must not look abandoned, and a lost lease surfaces now
  }

  /** H08: the default writer wraps our private name in its own inner .tmp; both layers are
   *  this commit's property and go with it on every failure path. */
  function cleanupTemp(tmpData) {
    for (const name of [tmpData, tmpData + '.tmp']) {
      try { fs.unlinkSync(name); } catch { /* never created, or already renamed */ }
    }
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
          epoch++;
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
      epoch++;
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
    epoch++;
    return data;
  }

  return {
    /** Graceful shutdown: hand the lock back so a recreated instance starts clean (T04). */
    release,

    /** How many times the cached state object was (re)assigned — a commit, the initial
     *  load, an adopted external change. A read cache keyed on this plus its own natural
     *  key can never serve a row across a state change, even one whose revision number
     *  an external edit happened to reuse. */
    epoch() { return epoch; },

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

    /** Run `fn(view)` against the file's state and persist the result. `fn` may be async:
     *  the queue awaits it before anything is written, so a mutation made after an await
     *  lands on disk too, and the next transaction still starts only after this one
     *  settles. `fn`'s return value is passed back; a throw from `fn` or a failed write
     *  leaves file and cache untouched, and the next transaction runs after a failure —
     *  never wedged.
     *
     *  THE VIEW (the round-7 NO_WRITE cost fix): `view.state` is the live snapshot for the
     *  read/plan phase; `view.edit()` clones it ONCE, lazily, the first time the callback
     *  is about to mutate — a repeated cheer or the removal of an absent one (the common
     *  no-op) never pays the structuredClone of a 100k-entry table. After edit() the draft
     *  is the ONLY object to touch: reads from a `view.state` reference taken before the
     *  edit see the pre-clone state. `NO_WRITE` from a callback that also called edit() is
     *  a broken promise — honored as before (nothing persists), same as it ever was. */
    txn(fn) {
      // lock() lives INSIDE the queued run: a refused/deposed store must answer with a
      // REJECTION, not a synchronous throw out of txn() itself (callers await it).
      const run = async () => {
        lock();
        const current = load();
        let draft = null;
        const view = {
          get state() { return draft ?? current; },
          edit() { if (!draft) draft = structuredClone(current); return draft; }
        };
        const out = fn(view);
        const value = (out && typeof out.then === 'function') ? await out : out;
        if (value === NO_WRITE) return { revision: current.revision || 0, out: undefined };
        const target = draft ?? current;
        target.revision = (current.revision || 0) + 1;
        target.updatedAt = now();
        persist(target);
        data = target;
        epoch++;
        return { revision: target.revision, out: value };
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
