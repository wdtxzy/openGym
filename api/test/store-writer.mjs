/* The child-process harness for the shared-store protocol tests.
 *
 * The takeover/marker scenarios (I01, K01, K02, L01, M01) each drive REAL writer
 * processes — distinct hostnames, a controllable clock (so a lease goes silent in
 * milliseconds, not sixteen real seconds) and pause points installed by the scenario's
 * own code. What every one of them shares is the mechanics collected here: spawn a
 * writer with its ROLE, collect its stdout AND stderr, wait for its boot line or its
 * final TXN line (on 'close', after stdio has flushed — 'exit' fires before the last
 * chunk and races the parse), wait for a stage file to appear, and kill everything at
 * the end. Every wait is bounded: a hung regression fails loudly instead of pinning the
 * suite, and the failure carries the writer's own output so the diagnosis does not
 * depend on reproducing the hang.
 *
 * A scenario writer prints two kinds of lines: `WARMUP {json}` once its store is up,
 * and `TXN {json}` per transaction outcome (the LAST one is what `done` resolves with).
 * The scenario code itself — which hooks to install, where to pause — stays in each
 * test, where the timing it pins is readable. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BOOT_TIMEOUT_MS = 30000;

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
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    const lines = () => out.trim().split('\n').filter(Boolean);
    const pick = prefix => {
      // Malformed scenario output must not kill the test with a parse throw — skip the
      // line and let the timeout/closer report the raw output instead.
      for (const l of [...lines()].reverse()) {
        if (!l.startsWith(prefix + ' ')) continue;
        try { return JSON.parse(l.slice(prefix.length + 1)); } catch { return null; }
      }
      return null;
    };
    const bail = why => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      return new Error(`${role}: ${why}\nstdout: ${out}\nstderr: ${err}`);
    };
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(bail('no final TXN line within ' + BOOT_TIMEOUT_MS + 'ms')), BOOT_TIMEOUT_MS);
      child.on('close', () => {
        clearTimeout(timer);
        const txn = pick('TXN');
        if (txn) resolve(txn); else reject(bail('closed without a final TXN line'));
      });
      child.on('error', e => { clearTimeout(timer); reject(bail('spawn failed: ' + e.message)); });
    });
    done.catch(() => {}); // killed children must not mask the real failure (the world is SIGKILLed)
    /** Resolve with the first `prefix` line's JSON once it appears — for scenarios where a
     *  writer pauses after printing an intermediate line and never exits. */
    const waitForLine = (prefix, timeoutMs = BOOT_TIMEOUT_MS) => new Promise((resolve, reject) => {
      const seen = () => { const l = lines().find(x => x.startsWith(prefix + ' ')); return l ? JSON.parse(l.slice(prefix.length + 1)) : null; };
      const iv = setInterval(() => { const v = seen(); if (v) { clearInterval(iv); clearTimeout(timer); resolve(v); } }, 5);
      const timer = setTimeout(() => { clearInterval(iv); try { child.kill('SIGKILL'); } catch { /* already gone */ } reject(bail('no ' + prefix + ' line within ' + timeoutMs + 'ms')); }, timeoutMs);
      child.on('close', () => { clearInterval(iv); clearTimeout(timer); const v = seen(); if (v) resolve(v); else reject(bail('closed before printing ' + prefix)); });
    });
    const warmup = () => new Promise((resolve, reject) => {
      const seen = () => { const l = lines().find(x => x.startsWith('WARMUP ')); return l ? JSON.parse(l.slice(7)) : null; };
      // Resolve the moment the boot line appears — writers that pause mid-scenario never
      // exit, so waiting for 'close' here would deadlock every pause-point test. The
      // timeout and the close handler are the failure paths (a crashed writer reports
      // its output instead of hanging the suite).
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } reject(bail('no WARMUP line within ' + BOOT_TIMEOUT_MS + 'ms')); }, BOOT_TIMEOUT_MS);
      const iv = setInterval(() => { const wm = seen(); if (wm) { clearInterval(iv); clearTimeout(timer); resolve(wm); } }, 5);
      child.on('close', () => {
        clearInterval(iv); clearTimeout(timer);
        const wm = seen();
        if (wm) resolve(wm); else reject(bail('exited before printing WARMUP'));
      });
    });
    return { done, warmup, waitForLine, pid: child.pid, kill: () => child.kill('SIGKILL'), out: () => out + (err ? ' | stderr: ' + err : ''),
             /** Resolves when the process is REALLY gone ('close' reaps it) — the proof a
              *  same-host takeover needs before it may judge the holder dead. */
             exited: new Promise(resolve => child.on('close', resolve)) };
  };
  const teardown = async () => {
    for (const child of children) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
    await new Promise(r => setTimeout(r, 50));
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { root, file, clockFile, advanceClock, waitFor, spawnWriter, teardown };
}
