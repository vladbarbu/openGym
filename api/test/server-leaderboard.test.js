import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';

const origin = 'http://localhost:8080';
const invite = 'test-code-for-the-friends-board';
const secret = crypto.randomBytes(32).toString('hex');
const auth = id => {
  const value = `${id}:${Date.now() + 86_400_000}:0`;
  const sig = crypto.createHmac('sha256', secret).update(value).digest('base64url');
  return { Cookie: `gymsid=${value}.${sig}` };
};

test('leaderboard routes enforce membership and stop sharing immediately on leave', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-leaderboard-'));
  const userIds = ['u_alex', 'u_bea', 'u_cami'];
  fs.writeFileSync(path.join(dir, 'secret'), secret, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({
    users: userIds.map(id => ({ id, name: id.slice(2) })),
    creds: [], subs: [], invites: []
  }));
  for (const id of userIds) {
    fs.writeFileSync(path.join(dir, `state-${id}.json`), JSON.stringify({
      workouts: [{ d: '2026-01-01', entries: [{ id: 'bench', sets: [{ w: 82, r: 4, done: true }] }] }]
    }));
  }
  const child = spawn(process.execPath, ['server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: dir, ORIGIN: origin, RP_ID: 'localhost', LEADERBOARD_INVITE_CODE: invite }
  });
  t.after(() => {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  const port = await boundPort(child, () => log);
  const endpoint = `http://127.0.0.1:${port}/api/leaderboard`;
  const get = id => fetch(endpoint + '?month=all', { headers: auth(id) }).then(r => r.json());
  const post = (id, body, from = origin) => fetch(endpoint, {
    method: 'POST',
    headers: { ...auth(id), 'Content-Type': 'application/json', Origin: from },
    body: JSON.stringify(body)
  });

  assert.equal((await fetch(endpoint)).status, 401);
  assert.deepEqual(await get('u_cami'), { joined: false });
  assert.equal((await post('u_cami', { code: 'incorrect' })).status, 403);
  assert.equal((await post('u_cami', { code: invite }, 'https://elsewhere.example')).status, 403);
  for (const id of ['u_alex', 'u_bea']) {
    const response = await post(id, { code: invite });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { joined: true, notify: true });
  }
  assert.deepEqual((await get('u_alex')).exercises[0].rows.map(row => row.id), ['u_alex', 'u_bea']);
  const quiet = await post('u_bea', { notify: false });
  assert.deepEqual(await quiet.json(), { joined: true, notify: false });
  const retry = await post('u_bea', { code: invite });
  assert.deepEqual(await retry.json(), { joined: true, notify: false });
  assert.equal((await get('u_bea')).notify, false);
  const leave = await post('u_bea', { leave: true });
  assert.deepEqual(await leave.json(), { joined: false, notify: false });
  assert.deepEqual(await get('u_bea'), { joined: false });
  assert.deepEqual((await get('u_alex')).exercises[0].rows.map(row => row.id), ['u_alex']);
});
