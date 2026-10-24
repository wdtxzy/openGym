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
  // Ownership is a random token, minted per store instance and written in the lock — never a
  // bare PID: two containers on one volume are both "pid 1", and a pid alone cannot tell them
  // apart (N05). The hostname rides along so liveness stays a same-host judgement: a lock from
  // another host/container namespace can never be proven dead, so it is honoured as live.
  const myToken = crypto.randomBytes(16).toString('hex');
  const myHost = os.hostname();
  const readLock = () => {
    try { return JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { return null; }
  };
  const readAt = f => {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
  };
  const claimLock = () => {
    const fd = fs.openSync(lockFile, 'wx');
    try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, host: myHost, token: myToken })); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  };
  const iOwn = holder => holder && holder.token === myToken;

  let data = null;        // the parsed cache; null until the first successful load
  let refused = null;     // a StoreError once the file proved unusable — sticky until restart
  let knownMtime = 0;     // our own writes update it; a different mtime means an external hand
  let locked = false;
  let queue = Promise.resolve();

  /* Best-effort single-writer guard (see header). Acquire is the atomic 'wx' create; EEXIST is
   * resolved by the holder's TOKEN, not by guessing from PIDs. Taking over a stale lock re-reads
   * the holder immediately before removing it and gives up (refuses) the moment the lock names
   * anyone else — a contender that won the stale lock after our judgement is never unseated. */
  function lock() {
    if (locked) return;
    try {
      claimLock();
      locked = true;
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw new StoreError('lock', e.message);
    }
    let holder = readLock();
    if (iOwn(holder)) { locked = true; return; }               // our own, from this store
    const judge = h => {
      if (!h || !h.token) return 'gone';                      // unreadable/garbage: free to try
      if (h.host !== myHost) return 'foreign-host';           // unverifiable: honour as live (N05)
      if (h.pid === process.pid) return 'same-pid';           // provably THIS process: may take over
      return pidAlive(h.pid) ? 'live' : 'dead';
    };
    const verdict = judge(holder);
    if (verdict === 'live' || verdict === 'foreign-host')
      throw new StoreError('second-writer', `${verdict} holder (${JSON.stringify(holder)}) owns ${file}`);
    // Stale on our host. The takeover is capture-verify-discard, never a blind delete: the
    // lock is atomically MOVED to a private tombstone (rename), and only if what the tombstone
    // captured is still the exact holder we judged dead does it get discarded and claimed. A
    // contender that replaced the lock in the meantime lands in the tombstone instead, is put
    // back, and we refuse — no live owner is ever unseated (N05).
    const before = readLock();
    const tomb = lockFile + '.take.' + crypto.randomBytes(6).toString('hex');
    let captured = null;
    try { fs.renameSync(lockFile, tomb); captured = readAt(tomb); }
    catch (e) { if (e.code !== 'ENOENT') throw new StoreError('lock', e.message); }
    // Only a captured OBJECT with a token is an owner; anything else (absent, unparseable, or
    // plain garbage like a bare number that still parses as JSON) is what we judged 'gone'.
    const contender = (captured && typeof captured === 'object' && captured.token) ? captured : null;
    if (contender && (!before || !before.token || contender.token !== before.token)) {
      // What we captured is not the stale holder: a live contender owns the lock now. Put it
      // back exactly as it was and walk away.
      try { fs.renameSync(tomb, lockFile); } catch { try { fs.unlinkSync(tomb); } catch { /* gone */ } }
      throw new StoreError('second-writer', `lost the takeover race for ${file}`);
    }
    try { fs.unlinkSync(tomb); } catch { /* already gone */ }
    try {
      claimLock();
      locked = true;
    } catch (e) {
      if (e.code === 'EEXIST') throw new StoreError('second-writer', `lost the takeover race for ${file}`);
      throw new StoreError('lock', e.message);
    }
  }

  function persist(draft) {
    try {
      writer(file, JSON.stringify(draft, null, 2) + '\n', 0o600);
      knownMtime = fs.statSync(file).mtimeMs;
    } catch (e) {
      // atomicWrite leaves the previous file in place on any failure, so the cache still
      // matches what is on disk; the caller's transaction simply did not happen.
      throw new StoreError('write-failed', e.message);
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
      lock();
      const run = async () => {
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
