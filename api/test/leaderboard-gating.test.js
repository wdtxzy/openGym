/* LB-01, against the real server.js in a child: a switched-off instance has no leaderboard
 * routes at all (404, not 403 — nothing to discover), /api/config says nothing about it, and
 * no leaderboard file is ever created; switched on, the routes exist, answer 401 to a guest
 * without the public-read flag, and the store initializes its file. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function dataDir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-lb-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  fs.writeFileSync(path.join(d, 'secret'), crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  fs.writeFileSync(path.join(d, 'db.json'), JSON.stringify({ users: [], creds: [], subs: [], invites: [] }));
  return d;
}

async function start(t, d, env = {}) {
  const child = spawn(process.execPath, ['server.js'], { cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: d, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost', ...env } });
  const log = { text: '' };
  child.stdout.on('data', x => { log.text += x; });
  child.stderr.on('data', x => { log.text += x; });
  t.after(() => child.kill('SIGKILL'));
  const port = await boundPort(child, () => log.text);
  const get = async p => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`);
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { get, log };
}

test('LEADERBOARD off: no routes, no config key, no file', async t => {
  const d = dataDir(t);
  const { get } = await start(t, d); // no LEADERBOARD in env
  assert.equal((await get('/api/leaderboard?window=week')).status, 404);
  assert.equal((await get('/api/leaderboard/me')).status, 404);
  assert.equal((await get('/api/leaderboard/like')).status, 404);
  const cfg = await get('/api/config');
  assert.equal(cfg.body.leaderboard, undefined);
  assert.equal(fs.existsSync(path.join(d, 'leaderboard.json')), false, 'nothing touches the disk while off');
});

test('LEADERBOARD on: routes exist, guests without the public flag get 401, config exposes the block', async t => {
  const d = dataDir(t);
  const { get } = await start(t, d, { LEADERBOARD: '1' });
  assert.equal((await get('/api/leaderboard?window=week')).status, 401);
  assert.equal((await get('/api/leaderboard/me')).status, 401);
  const cfg = await get('/api/config');
  assert.deepEqual(cfg.body.leaderboard, { public_read: false });
  const stored = JSON.parse(fs.readFileSync(path.join(d, 'leaderboard.json'), 'utf8'));
  assert.equal(stored.schemaVersion, 1);
  assert.ok(fs.existsSync(path.join(d, 'leaderboard.json.lock')), 'the single-writer lock is taken');
});

test('LEADERBOARD on + public read: a guest sees the (empty) board, not a 401', async t => {
  const d = dataDir(t);
  const { get } = await start(t, d, { LEADERBOARD: '1', LEADERBOARD_PUBLIC_READ: '1' });
  const board = await get('/api/leaderboard?window=week');
  assert.equal(board.status, 200);
  assert.deepEqual(board.body.rows, []);
  assert.equal(board.body.window.timezone, 'Asia/Shanghai');
  const cfg = await get('/api/config');
  assert.deepEqual(cfg.body.leaderboard, { public_read: true });
});
