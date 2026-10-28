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
 * A `<file>.lock` naming a live writer refuses a second API process touching the same data
 * directory (both containers mounting one volume, an accidental second `npm start`): the
 * newcomer logs a clear error and every route answers 503, instead of two processes quietly
 * erasing each other's revisions. Ownership is a random token plus hostname, never a bare PID
 * (two containers on one volume are both "pid 1"), and the runtime NEVER takes an existing
 * lock over — not even one whose PID is gone. A lock left by a crash is cleared by the
 * documented deployment flow (docs/SELF_HOSTING.md), because guessing "the writer must be
 * dead" from the outside is exactly how a paused writer's acknowledged commit is lost.
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

export function createSharedStore({ file, schemaVersion, init, writer = atomicWrite, now = Date.now }) {
  const lockFile = file + '.lock';
  // Ownership is a random token, minted per store instance and written in the lock — never a
  // bare PID: two containers on one volume are both "pid 1" (N05). Recovery is FULLY
  // conservative (B01=A, and the round-13 O01 race that closed the last gap): an existing
  // lock is NEVER taken over at runtime, whatever it says — the judge of a stale token and
  // the rename that captures the public lock are two steps, and a legitimate recovery can
  // claim the lease in between; the late capture then moves a LIVE owner away, its old
  // heartbeat comes back, and acknowledged data is lost. So the runtime has exactly two
  // writers of the public lock path: the atomic 'wx' claim of an EMPTY path, and the
  // owner's own conditional heartbeat refresh. Everything else — a dead pid, a foreign
  // host, a silent lease, an unreadable lock — refuses and waits for the deployment flow:
  // confirm every writer stopped, back up, remove the residual lock, start the single
  // writer (docs/SELF_HOSTING.md). A graceful stop releases the lock outright (release(),
  // wired to SIGTERM in server.js), so a normal recreate needs no recovery at all.
  const myToken = crypto.randomBytes(16).toString('hex');
  const myHost = os.hostname();
  const HEARTBEAT_MS = 1000;
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
   *  lease (K01). Each marker's recorded private commit file goes with it, both temp
   *  layers: that removal is what makes a paused writer's final rename fail ENOENT
   *  instead of landing over the writer that took over.
   *
   *  The marker READ is load-bearing (L01): a writer that already passed its final
   *  review — read its marker, matched token and temp name, checked its lease — and is
   *  paused just before the rename keeps its rename source no matter what a LATER read
   *  of that marker returns. A read that fails with EIO, or content that cannot be
   *  verified to name that private file, therefore means the isolation is UNKNOWN, not
   *  empty: the acquisition is refused and the marker stays on disk for an operator.
   *  Only states that PROVE safety proceed:
   *    - missing (ENOENT): the marker is gone — its writer's own final check (which
   *      re-reads the marker) fails, or a previous isolation removed the private file
   *      first; either way nothing is armed under it.
   *    - valid: parsed, and names a private commit file of THIS data file — delete the
   *      file (both layers), then the marker. ENOENT on either deletion is the proof
   *      the target is gone (K02); any other error refuses the acquisition.
   *  Non-canonical debris — publish '.new' temps (writable torn by a crash mid-write)
   *  and round-7 capture tombs — never sits at a name any writer verifies against, so
   *  it cannot arm one whatever it reads like; it is cleaned best-effort. */
  function isolateCommitMarkers() {
    const base = path.basename(file);
    const canonicalName = n => n === base + '.committing' || /^[0-9a-f]+$/.test(n.slice((base + '.committing.').length));
    const ownCommitTemp = t => typeof t === 'string' && t.startsWith(file + '.commit.') && !t.slice((file + '.commit.').length).includes('/');
    for (const m of commitMarkers()) {
      const isCanonical = canonicalName(path.basename(m));
      let body = null;
      let state = 'valid';
      try { body = JSON.parse(fs.readFileSync(m, 'utf8')); }
      catch (e) {
        if (e.code === 'ENOENT') continue; // missing: proven gone, nothing armed under it
        state = 'unreadable';
      }
      if (state === 'valid' && !(body && typeof body === 'object' && ownCommitTemp(body.tmp))) state = 'invalid';
      if (state !== 'valid') {
        if (!isCanonical) { try { fs.unlinkSync(m); } catch { /* debris: never load-bearing */ } continue; }
        // Unknown state at a name a writer verifies against: refuse, keep the file.
        throw new StoreError('lock', `cannot verify ${path.basename(m)} (${state}): refusing to take over ${file}`);
      }
      for (const t of [body.tmp, body.tmp + '.tmp']) {
        try { fs.unlinkSync(t); }
        catch (e) { if (e.code !== 'ENOENT') throw new StoreError('lock', `cannot isolate ${path.basename(t)}: ${e.message}`); }
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
  // Why the check-then-rename inside refreshLease is safe (N01/O01): the protocol gives NO
  // ONE a way to move or replace a live holder's lease — the ONLY runtime writers of the
  // public lock path are the atomic 'wx' claim of an EMPTY path and the owner's own
  // conditional refresh. There is no capture step left to race: takeovers were removed
  // entirely after the round-13 race showed that a late capture can move a live owner even
  // when the judge read a dead token. Within one process the check and the rename share a
  // thread and cannot interleave; across processes, nothing in the protocol writes here.
  // An operator removing the lock (the documented recovery, with every writer confirmed
  // stopped) is outside the protocol by definition — if it races a live writer, that is a
  // deployment error, and the heartbeat's next iOwn check deposes the writer rather than
  // fighting for the path.
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

  /* The single-writer guard (see header). Acquire is the atomic 'wx' create; EEXIST is
   * settled by the holder's TOKEN, and there is no take-over step at all: an existing lock —
   * live, crashed, foreign-hosted, silent or unparseable — is refused, and its residual is
   * removed by the deployment flow once every writer is confirmed stopped. The round-13 race
   * (O01/B01=A) is why: judging a token stale and renaming the public lock are two steps, and
   * a legitimate recovery can claim the lease in between, after which the late capture moves
   * a LIVE owner away. No check-then-act ordering fixes that; refusing does. */
  function lock() {
    if (refused) throw new StoreError(refused.code, refused.message); // settled: refuse with a clean error
    if (locked) return;
    // Best-effort refuse only (K01): a FRESH marker over a LIVE lease means its writer is
    // mid-commit right now — do not contend. Nothing is CLEARED here: a directory listing
    // taken now is stale by the time the lease changes hands (a writer can publish its
    // marker and pass its lease check in the gap), so the authoritative isolation runs
    // AFTER this store holds the lease, where it is provably complete.
    const markersEarly = commitMarkers();
    if (markersEarly.length && readLock()) {
      // Best-effort refuse only (K01): commit markers over an existing lock mean a writer
      // is mid-commit (or the lock is unownable anyway) — refuse without touching either.
      // Markers over an EMPTY path are a crashed writer's debris: the clean claim below
      // isolates them in acquired(), where the deletion is provably complete.
      throw new StoreError('second-writer', `${file}: a commit is in progress`);
    }
    try {
      claimLock();
    } catch (e) {
      if (e.code !== 'EEXIST') throw new StoreError('lock', e.message);
      // O01/B01=A, the final conservative line: an existing lock is NEVER taken over at
      // runtime — not by a TTL judgement, not even over a holder whose pid looks dead. The
      // round-13 race proved why: between judging a stale token and renaming the public
      // lock into a private tombstone, a legitimate recovery can claim the lease, and the
      // late capture then MOVES a live owner away — its old heartbeat comes back, its
      // token sits on the public path again, and an acknowledged commit is lost. There is
      // no check-then-act fix for that; the only safe runtime answer is to refuse.
      // Residual locks are cleared by the deployment flow after EVERY writer is confirmed
      // stopped (docs/SELF_HOSTING.md): stop all writers, back up, remove the lock, start
      // the single writer.
      const holder = readLock();
      throw new StoreError('second-writer',
        holder ? `${file}: a writer exists (${JSON.stringify(holder)}) — take over only after every writer is confirmed stopped (remove the lock; see docs/SELF_HOSTING.md)`
               : `${file}: locked by an unreadable lease — an unknown state is never ownerless; recover only after every writer is confirmed stopped (docs/SELF_HOSTING.md)`);
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

  /** Graceful shutdown: release the lock so a recreated instance starts clean (T04) instead
   *  of needing the operator's recovery. Best-effort — after a hard crash the residual lock
   *  stays, and the deployment flow in docs/SELF_HOSTING.md is the only way past it. */
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
        // A boot that never became usable must not keep the lease: nothing was loaded and
        // nothing was served, so the retry — this process or the next — has to be able to
        // claim. The single-writer guarantee is untouched: this instance never wrote.
        try { release(); } catch { /* best effort */ }
        if (e instanceof StoreError) return { ok: false, code: e.code, detail: e.message };
        return { ok: false, code: 'unexpected', detail: e.message };
      }
    },
  };
}
