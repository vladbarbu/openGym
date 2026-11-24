import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leaderboard, monthToNotify, leaderboardMonth, leaderboardRecap } from '../leaderboard.js';

const set = (w, r, extra = {}) => ({ w, r, done: true, ...extra });
const training = (d, sets, other = {}) => ({ d, entries: [{ id: 'bench', sets }], ...other });

test('ranks completed working sets and total daily volume in a common unit', () => {
  const users = [
    { id: 'a', name: 'Alex', leaderboardJoined: '2026-09' },
    { id: 'b', name: 'Bea', leaderboardJoined: '2026-09' },
    { id: 'private', name: 'Private' },
    { id: 'disabled', name: 'Disabled', leaderboardJoined: '2026-09', disabled: true }
  ];
  const state = {
    a: { workouts: [
      training('2026-11-02', [set(100, 2), set(300, 3, { phase: 'warmup' }), set(400, 3, { done: false })], { note: 'private' }),
      training('2026-11-02', [set(85, 10)]),
      training('2026-10-28', [set(110, 1)]),
      training('2026-11-30', [set(500, 1)])
    ] },
    b: { unit: 'lb', workouts: [training('2026-11-03', [set(225, 3)])] }
  };
  const result = leaderboard(users, id => {
    assert.ok(id in state, 'only members’ workout files are read');
    return state[id];
  }, '2026-11', '2026-11-24');
  assert.deepEqual(result.exercises[0].rows, [
    { id: 'b', name: 'Bea', weight: 102.058, reps: 3, date: '2026-11-03' },
    { id: 'a', name: 'Alex', weight: 100, reps: 2, date: '2026-11-02' }
  ]);
  assert.deepEqual(result.heaviest[0], { id: 'a', name: 'Alex', volume: 1050, date: '2026-11-02' });
  assert.ok(!JSON.stringify(result).includes('private'));
});

test('counts only distinct training dates toward consecutive Monday-based weeks', () => {
  const days = ['02', '03', '04', '09', '09', '09', '10', '16', '17', '18', '23', '24', '25'];
  const result = leaderboard([{ id: 'a', name: 'Alex', leaderboardJoined: '2026-10' }],
    () => ({ workouts: days.map(day => training('2026-11-' + day, [set(0, 10)])) }), '2026-11', '2026-11-30');
  assert.deepEqual(result.consistency, [{ id: 'a', name: 'Alex', weeks: 2, days: 11 }]);
});

test('validates selected periods and schedules one recap for the previous UTC month', () => {
  const now = new Date('2027-01-01T09:00:00Z');
  assert.equal(leaderboardMonth('2026-12', now), '2026-12');
  assert.equal(leaderboardMonth('2026-13', now), null);
  assert.equal(leaderboardMonth('2027-02', now), null);
  assert.equal(leaderboardMonth('all', now), 'all');
  assert.equal(monthToNotify(new Date('2027-01-01T08:59:59Z')), null);
  assert.equal(monthToNotify(now), '2026-12');
  assert.equal(monthToNotify(new Date('2027-01-06T03:00:00Z')), '2026-12');
  const member = { leaderboardJoined: '2026-12' };
  assert.equal(leaderboardRecap(member, '2026-12').leaderboardMonth, '2026-12');
  assert.equal(leaderboardRecap({ ...member, leaderboardRecap: '2026-12' }, '2026-12'), null);
  assert.equal(leaderboardRecap({ ...member, leaderboardNotify: false }, '2026-12'), null);
  assert.equal(leaderboardRecap({ leaderboardJoined: '2027-01' }, '2026-12'), null);
  assert.equal(leaderboardRecap({}, '2026-12'), null);
});
