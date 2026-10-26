/* The child-process harness for the shared-store protocol tests.
 *
 * The takeover/marker scenarios (I01, K01, K02, L01) each drive REAL writer processes —
 * distinct hostnames, a controllable clock (so a lease goes silent in milliseconds, not
 * sixteen real seconds) and pause points installed by the scenario's own code. What
 * every one of them shares is the mechanics collected here: spawn a writer with its
 * ROLE, collect its stdout, wait for its boot line or its final TXN line (on 'close',
 * after stdio has flushed — 'exit' fires before the last chunk and races the parse),
 * wait for a stage file to appear, and kill everything at the end.
 *
 * A scenario writer prints two lines: `WARMUP {json}` once its store is up, and
 * `TXN {json}` as its single transaction's outcome. The scenario code itself — which
 * hooks to install, where to pause — stays in each test, where the timing it pins is
 * readable. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** A fresh scratch world: data file, clock file, stage helpers, teardown. */
export function writerWorld(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const file = path.join(root, 'data.json');
  const clockFile = path.join(root, 'clock');
  const base = Date.now();
  fs.writeFileSync(clockFile, String(base));
  const children = [];
  const advanceClock = ms => fs.writeFileSync(clockFile, String(base + ms));
  const waitFor = async (what, p) => {
    for (let i = 0; i < 750 && !fs.existsSync(p); i++) await new Promise(r => setTimeout(r, 20));
    if (!fs.existsSync(p)) throw new Error('timed out waiting for ' + what);
  };
  /** Spawn a writer for `childCode` (self-contained module source) under `role`; the
   *  scenario code reads process.env.ROLE, FILE, ROOT, CLOCK and STORE_URL. */
  const spawnWriter = (childCode, role) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childCode], {
      env: {
        ...process.env, ROLE: role, FILE: file, ROOT: root, CLOCK: clockFile,
        STORE_URL: pathToFileURL(path.join(import.meta.dirname, '../community/store.js')).href
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    children.push(child);
    let out = '';
    child.stdout.on('data', d => { out += d; });
    const lines = () => out.trim().split('\n').filter(Boolean);
    const pick = prefix => lines()
      .map(l => (l.startsWith(prefix + ' ') ? JSON.parse(l.slice(prefix.length + 1)) : null))
      .filter(Boolean).pop();
    const done = new Promise((resolve, reject) => {
      child.on('close', () => {
        const txn = pick('TXN');
        if (txn) resolve(txn); else reject(new Error(`${role} produced no txn result: ${out}`));
      });
      child.on('error', reject);
    });
    done.catch(() => {}); // killed children must not mask the real failure (the world is SIGKILLed)
    const warmup = () => new Promise((resolve, reject) => {
      const seen = () => { const l = lines().find(x => x.startsWith('WARMUP ')); return l ? JSON.parse(l.slice(7)) : null; };
      const iv = setInterval(() => { const w = seen(); if (w) { clearInterval(iv); resolve(w); } }, 5);
      child.on('close', () => { clearInterval(iv); const w = seen(); if (w) resolve(w); else reject(new Error(`${role} exited before warmup: ${out}`)); });
    });
    return { done, warmup };
  };
  const teardown = async () => {
    for (const child of children) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
    await new Promise(r => setTimeout(r, 50));
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { root, file, clockFile, advanceClock, waitFor, spawnWriter, teardown };
}
