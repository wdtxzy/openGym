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
import { atomicWrite } from '../durable.js';

/** Refused operation on a shared store. `code` is stable for the API error table. */
export class StoreError extends Error {
  constructor(code, detail) {
    super(detail || code);
    this.code = code;
  }
}

/** A PID that answers signal 0 (or that we may not signal, EPERM: alive but not ours). */
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

export function createSharedStore({ file, schemaVersion, init, writer = atomicWrite, now = Date.now }) {
  const lockFile = file + '.lock';
  let data = null;        // the parsed cache; null until the first successful load
  let refused = null;     // a StoreError once the file proved unusable — sticky until restart
  let knownMtime = 0;     // our own writes update it; a different mtime means an external hand
  let locked = false;
  let queue = Promise.resolve();

  /* Best-effort single-writer guard (see header). Refuses, never repairs another live owner. */
  function lock() {
    if (locked) return;
    let pid = 0;
    try { pid = Number(fs.readFileSync(lockFile, 'utf8')) || 0; } catch { /* no lock yet */ }
    if (pid && pid !== process.pid && pidAlive(pid))
      throw new StoreError('second-writer', `pid ${pid} already owns ${file}`);
    try { fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' }); }
    catch (e) {
      if (e.code !== 'EEXIST') throw new StoreError('lock', e.message);
      // Ours already, or a stale one judged dead above: replace the content, keep the file.
      fs.writeFileSync(lockFile, String(process.pid));
    }
    locked = true;
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
      // Edits while the service runs are not supported; this only keeps a restarted-over
      // replica from answering from a snapshot the operator already replaced by hand.
      let mtime = 0;
      try { mtime = fs.statSync(file).mtimeMs; } catch { /* gone: keep the cache */ }
      if (mtime && mtime !== knownMtime) {
        try {
          const reparsed = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (reparsed && reparsed.schemaVersion === schemaVersion) { data = reparsed; knownMtime = mtime; }
        } catch { /* an operator mid-edit; the last good cache keeps serving */ }
      }
      return data;
    }
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
      knownMtime = fs.statSync(file).mtimeMs;
    } catch (e) {
      if (e.code !== 'ENOENT') { refused = new StoreError('unreadable', e.message); throw refused; }
      data = { schemaVersion, revision: 0, updatedAt: now(), ...init() };
      persist(data);
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
    /** A private copy of the current state. Refused (throws StoreError) when unusable. */
    read() {
      lock();
      return structuredClone(load());
    },

    /** Run `fn(draft)` against a private draft and persist the result. `fn`'s return value is
     *  passed back; a throw from `fn` or a failed write leaves file and cache untouched. The
     *  next transaction runs after a failure — the queue never wedges on one bad write. */
    txn(fn) {
      lock();
      const run = () => {
        const current = load();
        const draft = structuredClone(current);
        const out = fn(draft);
        draft.revision = (current.revision || 0) + 1;
        draft.updatedAt = now();
        persist(draft);
        data = draft;
        return { revision: draft.revision, out };
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
