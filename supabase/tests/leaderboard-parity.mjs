import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { leaderboard, previousLeaderboardMonth } from '../../api/leaderboard.js';

const api = 'http://127.0.0.1:56421';
const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = JSON.parse(
  execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
);
assert.equal(API_URL, api, 'the CLI must point to the local openGym stack');
assert.ok(ANON_KEY && SERVICE_ROLE_KEY, 'local anon and service role keys are required');

const now = new Date();
const today = now.toISOString().slice(0, 10);
const currentMonth = today.slice(0, 7);
const previousMonth = previousLeaderboardMonth(now);
const tomorrow = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
const runId = randomUUID();
const password = randomUUID();
const createdUsers = [];
const createdGroups = [];

async function request(path, { method = 'GET', body, user, admin = false } = {}) {
  const key = admin ? SERVICE_ROLE_KEY : ANON_KEY;
  const response = await fetch(api + path, {
    method,
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + (user?.token ?? key),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const raw = await response.text();
  return {
    status: response.status,
    data: response.headers.get('content-type')?.includes('application/json') && raw ? JSON.parse(raw) : raw
  };
}

function expect(response, status = 200) {
  assert.equal(response.status, status, JSON.stringify(response.data).slice(0, 1000));
  return response.data;
}

const rpc = (user, name, body = {}) => request('/rest/v1/rpc/' + name, { method: 'POST', user, body });

function expectError(response, status, code, message) {
  const error = expect(response, status);
  assert.equal(error.code, code);
  assert.equal(error.message, message);
  return error;
}

async function createUser(name, metadata = { name }) {
  const email = `${name.toLowerCase() === 'outside' ? 'outside' : 'fixture'}-${createdUsers.length}-${runId}@example.com`;
  const account = expect(await request('/auth/v1/admin/users', {
    method: 'POST', admin: true, body: { email, password, email_confirm: true, user_metadata: metadata }
  }));
  createdUsers.push(account.id);
  const session = expect(await request('/auth/v1/token?grant_type=password', {
    method: 'POST', body: { email, password }
  }));
  return { id: account.id, name: metadata.name === undefined ? email.split('@')[0] : name, token: session.access_token };
}

async function createGroup(user, name) {
  const result = expect(await rpc(user, 'create_group', { name }));
  const { code } = result.group;
  createdGroups.push(code);
  assert.match(code, /^[A-Z2-7]{20}$/);
  assert.deepStrictEqual(result, { joined: true, notify: true, group: { name, code } });
  return result.group;
}

const set = (w, r, extra = {}) => ({ w, r, done: true, ...extra });
const training = (d, sets, other = {}) => ({ d, entries: [{ id: 'bench', sets }], ...other });

function fixtures() {
  // Ranking and consistency fixtures from api/test/leaderboard.test.js.
  const doc = [
    { workouts: [
      training('2026-11-02', [set(100, 2), set(300, 3, { phase: 'warmup' }), set(400, 3, { done: false })], { note: 'private' }),
      training('2026-11-02', [set(85, 10)]),
      training('2026-10-28', [set(110, 1)]),
      training('2026-11-30', [set(500, 1)])
    ] },
    { unit: 'lb', customEx: [{ id: 'private-lift' }], workouts: [training('2026-11-03', [set(225, 3)])] },
    { workouts: ['02', '03', '04', '09', '09', '09', '10', '16', '17', '18', '23', '24', '25']
      .map(day => training('2026-11-' + day, [set(0, 10)])) },
    { unit: 'lb', customEx: { malformed: true }, workouts: [] }
  ];

  // Explicit ties, invalid shapes, both warmup rules, and rounding before a volume tie-break.
  for (const i of [0, 2]) {
    doc[i].workouts.push(
      { d: '2026-10-02', vol: 50000.0001, entries: [{ id: 'tie', sets: [set(' 0x20 ', '3')] }] },
      { d: '2026-10-03', vol: 50000.0002, entries: [{ id: 'tie', sets: [set(32, 3)] }] }
    );
  }
  doc[1].workouts.push({
    d: '2026-11-04', vol: '12345', entries: [
      null, false, { id: 'invalid id', sets: [set(999, 4)] },
      { id: 'private-lift', sets: [set(999, 4)] },
      { id: 'carry', target: { mode: 'time' }, sets: [
        set('1e2', 5, { mode: 'amrap' }), set(900, 5), set(500, 5, { mode: 'reps', phase: '', warmup: true })
      ] },
      { id: 'row', sets: [
        null, set(99, 4, { warmup: true }), set(37, 6, { done: 'yes' }), set('Infinity', 4),
        set(99, 2.1), set(99, 4, { sides: [] }), set({}, 4)
      ] }
    ]
  });
  doc[3].workouts.push(
    { d: '0000-02-29', entries: [{ id: 'ancient', sets: [set(10, 2)] }] },
    { d: '2026-11-04', entries: { malformed: true }, vol: -1 },
    { d: '2026-11-04', entries: [{ id: 'row', sets: {} }] }
  );

  let seed = 0x6f70656e;
  function random(limit) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return Math.floor(seed / 2 ** 32 * limit);
  }
  const pick = choices => choices[random(choices.length)];
  const dates = Array.from({ length: 66 }, (_, i) => new Date(Date.UTC(2026, 9, i + 1)).toISOString().slice(0, 10));
  dates.push(tomorrow, '9999-12-31', '2026-11-31', '2026-02-29', '2026-00-02', '2026-11-2', null);
  for (const state of doc) {
    for (let i = 0; i < 50; i++) {
      const workout = {
        d: pick(dates),
        entries: Array.from({ length: 1 + random(3) }, () => ({
          id: pick(['bench', 'deadlift', 'row', 'press', 'private-lift', 'not a lift']),
          target: { dbLoad: pick(['each', 'total', undefined]), mode: pick(['reps', 'amrap', 'time', undefined]) },
          sets: Array.from({ length: 1 + random(4) }, () => {
            const row = () => set(random(20001) / 100, pick([1, 5, 8, '10', 0]), { done: random(4) !== 0 });
            return {
              ...row(),
              phase: pick(['warmup', 'working', undefined, undefined, null]),
              warmup: random(6) === 0,
              mode: pick(['amrap', 'distance', undefined, undefined]),
              ...(random(4) === 0 ? { sides: { L: row(), R: row() } } : {})
            };
          })
        }))
      };
      if (random(3) === 0) workout.vol = random(2501) / 2;
      state.workouts.push(workout);
    }
  }
  return doc;
}

function sortedExercises(exercises) {
  return [...exercises].sort((a, b) => a.exercise.localeCompare(b.exercise) || a.basis.localeCompare(b.basis));
}

async function checkBoard(caller, members, docs, month, group, notify = true) {
  const expected = leaderboard(
    members.map(({ id, name }) => ({ id, name, leaderboardJoined: '2000-01' })),
    id => docs.get(id), month, today
  );
  const actual = expect(await rpc(caller, 'leaderboard', { month }));
  assert.deepStrictEqual(
    { ...actual, exercises: sortedExercises(actual.exercises) },
    { ...expected, exercises: sortedExercises(expected.exercises), joined: true, notify, currentMonth, previousMonth, group },
    `standings for ${month}`
  );
}

async function run() {
  const members = [];
  for (const name of ['Alex', 'Bea', 'alex', 'Cara']) {
    members.push(await createUser(name, { name: `  ${name}  ` }));
  }
  const outsider = await createUser('Outside', {});
  const group = await createGroup(members[0], 'Parity fixtures');
  for (const member of members.slice(1)) {
    assert.deepStrictEqual(expect(await rpc(member, 'join_group', { code: `  ${group.code.toLowerCase()}  ` })),
      { joined: true, notify: true, group });
  }
  expectError(await rpc(members[0], 'create_group', { name: 'Duplicate' }), 400, 'P0001', 'already-member');
  expectError(await rpc(outsider, 'join_group', { code: '!invalid' }), 400, 'P0001', 'leaderboard-invite');

  const docs = new Map();
  for (const [i, state] of fixtures().entries()) {
    const member = members[i];
    const result = expect(await rpc(member, 'put_state', { state, base_rev: 0 }));
    assert.equal(result.rev, 1);
    docs.set(member.id, state);
  }
  for (const month of ['all', ...new Set(['2026-10', '2026-11', currentMonth, previousMonth].filter(m => m <= currentMonth))]) {
    await checkBoard(members[0], members, docs, month, group);
    console.log(`Parity passed for ${month}`);
  }
  assert.deepStrictEqual(expect(await rpc(members[0], 'leaderboard')), expect(await rpc(members[0], 'leaderboard', { month: 'all' })));
  for (const month of ['2026-13', '9999-01', null]) {
    expectError(await rpc(members[0], 'leaderboard', { month }), 400, '22023', 'invalid leaderboard month');
  }

  assert.deepStrictEqual(expect(await rpc(outsider, 'leaderboard')), { joined: false });
  assert.deepStrictEqual(expect(await rpc(outsider, 'get_state')), { state: null, rev: 0 });
  assert.deepStrictEqual(expect(await rpc(outsider, 'get_state_rev')), { rev: 0, wid: null });
  assert.deepStrictEqual(expect(await rpc(outsider, 'set_leaderboard_notify', { notify: true })), { joined: false, notify: false });
  assert.deepStrictEqual(expect(await request('/rest/v1/app_state?select=*', { user: outsider })), []);
  expectError(await rpc(undefined, 'leaderboard'), 401, '42501', 'permission denied for function leaderboard');

  for (const state of [null, [], {}, { _rev: 10, _ts: 20 }]) {
    expectError(await rpc(outsider, 'put_state', { state }), 400, '22023', 'state required');
  }
  for (const state of [{ workouts: {} }, { routines: 'bad' }]) {
    expectError(await rpc(outsider, 'put_state', { state }), 400, '22023', 'invalid state');
  }

  const state = { workouts: [null, [], { d: today }, false], routines: [5, { name: 'A' }], active: {}, resetAt: 100, resetIds: { workouts: ['a'] } };
  const competing = await Promise.all([rpc(outsider, 'put_state', { state, base_rev: 0 }), rpc(outsider, 'put_state', { state, base_rev: 0 })]);
  assert.deepStrictEqual(competing.map(res => res.status).sort(), [200, 409]);
  const first = expect(competing.find(res => res.status === 200));
  assert.deepStrictEqual(Object.keys(first).sort(), ['ok', 'rev', 'ts', 'wid']);
  assert.equal(first.ok, true);
  assert.equal(first.rev, 1);
  assert.match(first.wid, /^[a-f0-9]{16}$/);
  assert.ok(Number.isSafeInteger(first.ts) && Math.abs(Date.now() - first.ts) < 60_000);
  const firstDoc = expect(await rpc(outsider, 'get_state'));
  assert.deepStrictEqual(firstDoc, { rev: 1, state: {
    workouts: [{ d: today }], routines: [{ name: 'A' }], resetAt: 100, resetIds: { workouts: ['a'] },
    _rev: 1, _wid: first.wid, _wids: []
  } });
  for (const conflict of [
    competing.find(res => res.status === 409),
    await rpc(outsider, 'put_state', { state, base_rev: 0, base_wid: first.wid }),
    await rpc(outsider, 'put_state', { state, base_rev: 1, base_wid: 'stale' })
  ]) {
    const error = expectError(conflict, 409, 'PT409', 'conflict');
    assert.deepStrictEqual(JSON.parse(error.details), firstDoc);
  }
  const second = expect(await rpc(outsider, 'put_state', { state: { workouts: null, resetAt: '99' }, base_wid: first.wid }));
  assert.equal(second.rev, 2);
  assert.notEqual(second.wid, first.wid);
  assert.deepStrictEqual(expect(await rpc(outsider, 'get_state_rev')), { rev: 2, wid: second.wid });
  assert.deepStrictEqual(expect(await rpc(outsider, 'get_state')), { rev: 2, state: {
    workouts: null, resetAt: 100, resetIds: { workouts: ['a'] }, _rev: 2, _wid: second.wid, _wids: [first.wid]
  } });
  const oversized = await rpc(outsider, 'put_state', { state: { payload: 'a'.repeat(5 * 1024 * 1024) }, base_rev: 2 });
  expectError(oversized, 500, '54000', 'too large');
  assert.deepStrictEqual(expect(await rpc(outsider, 'get_state_rev')), { rev: 2, wid: second.wid });
  console.log('State validation, concurrent writes, revisions, and conflict details passed');

  for (const [table, idKey] of [['app_state', 'user_id'], ['profiles', 'id']]) {
    const rows = expect(await request(`/rest/v1/${table}?select=*`, { user: outsider }));
    assert.deepStrictEqual(rows.map(row => row[idKey]), [outsider.id]);
    if (table === 'profiles') assert.equal(rows[0].name, outsider.name);
    assert.deepStrictEqual(expect(await request(`/rest/v1/${table}?select=*&${idKey}=eq.${members[0].id}`, { user: outsider })), []);
    assert.deepStrictEqual(expect(await request(`/rest/v1/${table}?select=${idKey}`, { user: members[0] })), [{ [idKey]: members[0].id }]);
  }
  for (const table of ['groups', 'memberships']) {
    expectError(await request(`/rest/v1/${table}?select=*`, { user: outsider }), 403, '42501', `permission denied for table ${table}`);
  }
  expectError(await request('/rest/v1/app_state', { method: 'POST', user: outsider, body: { doc: {}, rev: 1, wid: 'forbidden' } }),
    403, '42501', 'permission denied for table app_state');
  expectError(await request(`/rest/v1/app_state?user_id=eq.${outsider.id}`, { method: 'PATCH', user: outsider, body: { doc: {} } }),
    403, '42501', 'permission denied for table app_state');
  const newName = 'New profile';
  expect(await request(`/rest/v1/profiles?id=eq.${outsider.id}`, { method: 'PATCH', user: outsider, body: { name: newName } }), 204);
  expect(await request(`/rest/v1/profiles?id=eq.${outsider.id}`, { method: 'PATCH', user: members[0], body: { name: 'Forbidden' } }), 204);
  assert.deepStrictEqual(expect(await request('/rest/v1/profiles?select=*', { user: outsider })), [{ id: outsider.id, name: newName }]);
  console.log('Owner-only state and profile access passed');

  const moving = members.at(-1);
  const otherGroup = await createGroup(outsider, 'Separate group');
  assert.deepStrictEqual(expect(await rpc(moving, 'set_leaderboard_notify', { notify: false })), { joined: true, notify: false });
  assert.deepStrictEqual(expect(await rpc(moving, 'join_group', { code: group.code })), { joined: true, notify: false, group });
  await checkBoard(moving, members, docs, 'all', group, false);
  assert.deepStrictEqual(expect(await rpc(moving, 'join_group', { code: otherGroup.code })), { joined: true, notify: false, group: otherGroup });
  await checkBoard(members[0], members.slice(0, -1), docs, 'all', group);
  docs.set(outsider.id, { workouts: null });
  await checkBoard(moving, [moving, { ...outsider, name: newName }], docs, 'all', otherGroup, false);
  assert.deepStrictEqual(expect(await rpc(moving, 'join_group', { code: group.code })), { joined: true, notify: false, group });
  assert.deepStrictEqual(expect(await rpc(moving, 'leave_group')), { joined: false, notify: false });
  assert.deepStrictEqual(expect(await rpc(moving, 'leaderboard')), { joined: false });
  await checkBoard(members[0], members.slice(0, -1), docs, 'all', group);
  console.log('Invite validation, group isolation, notifications, and leaving passed');
}

try {
  await run();
} finally {
  const cleanup = await Promise.allSettled([
    ...createdUsers.map(id => request(`/auth/v1/admin/users/${id}`, { method: 'DELETE', admin: true }).then(res => expect(res))),
    ...createdGroups.map(code => request(`/rest/v1/groups?invite_code=eq.${code}`, { method: 'DELETE', admin: true }).then(res => expect(res, 204)))
  ]);
  const failures = cleanup.filter(result => result.status === 'rejected').map(result => result.reason);
  if (failures.length) throw new AggregateError(failures, 'Failed to clean up parity fixtures');
}

console.log('Leaderboard parity and behavior checks passed. Test fixtures cleaned up.');
