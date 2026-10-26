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
 * a stale lock from a crash, and is taken over.
 *
 * A commit in flight is bracketed by a per-writer marker, `<file>.committing.<lease-token>`:
 * it names the private commit file, so an acquisition that recovers a silent lease deletes
 * that file and the paused writer's final rename fails instead of landing over the new
 * owner. The token-bearing name is what makes the cleanup safe — no writer can move or hide
 * another's marker (J01), and every failure from the writer step onward cleans its own
 * private file (J06). */
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

  /* J01/J06 — per-writer commit markers. The marker's NAME carries the committer's lease
   * token (`<file>.committing.<token>`), so there is no shared name for anyone to fight
   * over: a writer's cleanup touches only the name bearing its own token and can never
   * move, hide or delete another writer's protection — the round-7 shared-name design
   * needed capture-verify-discard to say "mine", and any window where the public name was
   * absent (its tomb dance) left the current committer's private file invisible to the
   * next takeover, which is how a resumed writer renamed over an acknowledged commit. */
  const myMarker = () => file + '.committing.' + myToken;

  /** Every commit marker for THIS data file — the per-token ones plus the pre-round-8
   *  shared name and the round-7 tomb/new temps, all of which match the same prefix.
   *  A directory that cannot be read is NOT an empty set (K02): an unreadable listing
   *  means the markers — and the private commit files they name — are unknown, and
   *  unknown is not "isolated". Only a directory that truly does not exist reads empty. */
  function commitMarkers() {
    const dir = path.dirname(file);
    const base = path.basename(file);
    const prefix = base + '.committing.';
    let names;
    try { names = fs.readdirSync(dir); }
    catch (e) {
      if (e.code === 'ENOENT') return [];
      throw new StoreError('lock', `cannot list commit markers: ${e.message}`);
    }
    return names
      .filter(n => n === base + '.committing' || n.startsWith(prefix))
      .map(n => path.join(dir, n));
  }

  /** Isolate every commit marker for this data file — called ONLY while holding the
   *  lease (K01): each marker's recorded private commit file goes with it, both temp
   *  layers. That removal is what makes a paused writer's final rename fail ENOENT
   *  instead of landing over the writer that took over — so a removal that FAILED is
   *  not a removal (K02): ENOENT is the only error that proves the file gone; anything
   *  else (EIO, EACCES, …) leaves the old writer armed and REFUSES the acquisition
   *  rather than promising a success it cannot defend. A marker that does not parse
   *  cannot arm its writer (a live writer's own commit check re-reads the marker and
   *  deposes on a mismatch), so unreadable debris is simply deleted. */
  function isolateCommitMarkers() {
    for (const m of commitMarkers()) {
      const body = readAt(m);
      if (body && body.tmp) {
        for (const t of [body.tmp, body.tmp + '.tmp']) {
          try { fs.unlinkSync(t); }
          catch (e) { if (e.code !== 'ENOENT') throw new StoreError('lock', `cannot isolate ${path.basename(t)}: ${e.message}`); }
        }
      }
      try { fs.unlinkSync(m); }
      catch (e) { if (e.code !== 'ENOENT') throw new StoreError('lock', `cannot isolate ${path.basename(m)}: ${e.message}`); }
    }
  }

  /** Publish THIS writer's marker at its private (token-bearing) name: write the body —
   *  lease token and the private commit file's name — to a temp file and link it into
   *  place. The name is exclusive to this lease token, so the link cannot contend with any
   *  other writer; a leftover under this exact name is a previous commit of THIS instance
   *  and is cleared first (provably ours). Atomic appearance: the marker is never
   *  observable half-written. No fsync, by measurement and by analysis: the marker is
   *  recovery advice, not data — a marker lost to a power cut leaves a private temp file as
   *  harmless debris (its writer never renamed), and a marker that did land is cleared with
   *  its temp file by the next acquisition. */
  function publishMarker(markerFile, tmpData) {
    try { fs.unlinkSync(markerFile); } catch { /* none from this instance */ }
    const mtmp = markerFile + '.new.' + crypto.randomBytes(4).toString('hex');
    let fd = null;
    try {
      fd = fs.openSync(mtmp, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, host: myHost, token: myToken, at: now(), tmp: tmpData }));
      fs.closeSync(fd);
      fd = null;
      fs.linkSync(mtmp, markerFile);
      try { fs.unlinkSync(mtmp); } catch { /* the link owns the inode */ }
    } catch (e) {
      if (fd != null) try { fs.closeSync(fd); } catch { /* not open */ }
      try { fs.unlinkSync(mtmp); } catch { /* never created */ }
      throw new StoreError('write-failed', e.message);
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
    // Best-effort refuse only (K01): a FRESH marker over a LIVE lease means its writer is
    // mid-commit right now — do not contend. Nothing is CLEARED here: a directory listing
    // taken now is stale by the time the lease changes hands (a writer can publish its
    // marker and pass its lease check in the gap), so the authoritative isolation runs
    // AFTER this store holds the lease, where it is provably complete.
    const markersEarly = commitMarkers();
    if (markersEarly.length) {
      const holder = readLock();
      const leaseAlive = holder && holder.token && (holder.host !== myHost
        ? (typeof holder.at === 'number' && now() - holder.at <= STALE_HOST_MS)
        : (holder.pid === process.pid || pidAlive(holder.pid)));
      const anyFresh = markersEarly.some(m => {
        try { return now() - fs.statSync(m).mtimeMs <= STALE_HOST_MS; } catch { return false; }
      });
      if (anyFresh && leaseAlive) throw new StoreError('second-writer', `${file}: a commit is in progress`);
    }
    try {
      claimLock();
    } catch (e) {
      if (e.code !== 'EEXIST') throw new StoreError('lock', e.message);
      acquireStale();
    }
    acquired();
  }

  /** Everything that must hold once the lease is ours, in order (K01): isolate the
   *  commit markers a paused old writer may still be holding, and only then look alive
   *  to the outside. An isolation that cannot prove its deletions failed REFUSES the
   *  acquisition — the lease is handed back and the error is loud, never swallowed into
   *  a success an old writer can still overwrite (K02). */
  function acquired() {
    locked = true;
    try {
      isolateCommitMarkers();
    } catch (e) {
      locked = false;
      try {
        const holder = readLock();
        if (iOwn(holder)) fs.unlinkSync(lockFile);
      } catch { /* best effort: the heartbeat never started */ }
      throw e instanceof StoreError ? e : new StoreError('lock', e.message);
    }
    beat();
  }

  /** The takeover of a silent lease: judge, capture-verify-discard, claim. On success the
   *  caller runs acquired(); a refusal inside leaves the lock file where the judgement
   *  left it safe. */
  function acquireStale() {
    let holder = readLock();
    if (iOwn(holder)) return;                                  // our own, from this store: acquired() finishes
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
    // (No takeover guard file: the lock capture below is the atomic step — a contender
    // that loses it never unseats the winner, T03/N05 — and commit markers are per-writer
    // names, isolated by acquired() once the lease is held, with no shared name to guard.)
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
      throw new StoreError('second-writer', `lost the takeover race for ${file}`);
    }
    try { fs.unlinkSync(tomb); } catch { /* already gone */ }
    try {
      claimLock();
    } catch (e) {
      if (e.code === 'EEXIST') throw new StoreError('second-writer', `lost the takeover race for ${file}`);
      throw new StoreError('lock', e.message);
    }
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

  /* The commit protocol (G01/H01/I01/J01/J06). A lease check and the actual write are two
   * steps, and a process paused between them must never come back and overwrite the writer
   * that properly took over — nor may any cleanup break the NEXT writer's protection:
   *   writer(tmp)                        — a PRIVATE temp file, no shared state touched
   *   publish <file>.committing.<token>  — OUR name alone; records token AND tmp's name
   *   verify the marker and lease        — a recovered-over writer deposes here, writes nothing
   *   rename(tmp → file) + dir fsync     — the atomic commit (H06 keeps durable.js's contract)
   *   remove our marker, refresh lease
   * The exclusivity proof is the RESOURCE the rename consumes: the private commit file.
   * Every acquisition that could commit its own data first clears the commit markers it
   * finds (each with the private file it names), so a resumed committer's rename fails
   * ENOENT instead of landing. That guarantee holds because a marker's name carries its
   * writer's lease token: nobody else's cleanup can remove or hide it (J01 — the shared
   * name's capture dance once left the current committer's file invisible mid-cleanup),
   * and every failure path from the writer onward cleans the private file (J06 — the
   * marker publication step used to sit outside that cleanup). */
  function persist(draft) {
    if (!locked || deposed) throw new StoreError('lost-lock', `${file}: not the lease owner`);
    const tmpData = `${file}.commit.${crypto.randomBytes(6).toString('hex')}`;
    const markerFile = myMarker(); // our name: no other writer's marker can ever share it
    try {
      writer(tmpData, JSON.stringify(draft, null, 2) + '\n', 0o600);
      publishMarker(markerFile, tmpData);
      // Re-verify the MARKER and the lease: only a takeover removes our marker (no peer
      // cleanup can — the name carries our token), and only the lease owner may commit.
      const marker = readAt(markerFile);
      if (!marker || marker.token !== myToken || marker.tmp !== tmpData || !iOwn(readLock())) {
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
      // J01/J06: cleanup touches ONLY this commit's own resources — the private data file
      // (both temp layers, above) and the marker under OUR token-bearing name. Another
      // writer's marker is a different file and cannot be affected.
      try { fs.unlinkSync(markerFile); } catch { /* already gone */ }
      if (e instanceof StoreError) throw e;
      throw new StoreError('write-failed', e.message);
    }
    try { fs.unlinkSync(markerFile); } catch { /* crash debris: a future acquisition clears it with its tmp */ }
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
        // J05: a callback that never called edit() changed nothing — its plain result is a
        // READ-ONLY answer carrying the current revision. The old code fell through to the
        // write path with `target = current` (the LIVE cache) and mutated revision/updatedAt
        // on it before persisting, so a write failure left memory ahead of disk with
        // healthy() still true. Nothing may touch the live cache before the disk has
        // accepted the write.
        if (draft === null) return { revision: current.revision || 0, out: value };
        draft.revision = (current.revision || 0) + 1;
        draft.updatedAt = now();
        persist(draft);
        data = draft;
        epoch++;
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
