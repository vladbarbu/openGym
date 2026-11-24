import { workoutVolume } from './trainers/projections.js';

const DAY = 86400000;
const KG_PER_LB = 0.45359237;
const WEEKLY_GOAL = 3;
const records = value => Array.isArray(value) ? value.filter(row => row && typeof row === 'object') : [];
const monthOf = date => date.toISOString().slice(0, 7);
const roundKg = weight => Math.round(weight * 1000) / 1000;

export function leaderboardMonth(request, now) {
  const current = monthOf(now);
  if (request === null) return current;
  if (request === 'all') return 'all';
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(request) && request <= current ? request : null;
}

export const previousLeaderboardMonth = now => monthOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)));

export function monthToNotify(now) {
  if (now.getUTCDate() === 1 && now.getUTCHours() < 9) return null;
  return previousLeaderboardMonth(now);
}

export const leaderboardMember = user => !!user.leaderboardJoined && !user.disabled;

export function leaderboardRecap(user, month) {
  if (!month || !leaderboardMember(user) || user.leaderboardNotify === false
      || user.leaderboardJoined > month || user.leaderboardRecap === month) return null;
  return {
    title: 'Leaderboard',
    body: 'Last month’s standings are ready.',
    tag: 'leaderboard-recap',
    leaderboardMonth: month
  };
}

function trainingDate(workout) {
  const date = workout.d;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const stamp = Date.parse(date);
  return Number.isFinite(stamp) && new Date(stamp).toISOString().startsWith(date) ? date : null;
}

function longestStreak(dates) {
  const weeks = new Map();
  for (const date of dates) {
    const stamp = Date.parse(date);
    const weekday = new Date(stamp).getUTCDay();
    const monday = stamp - ((weekday + 6) % 7) * DAY;
    weeks.set(monday, (weeks.get(monday) || 0) + 1);
  }

  let best = 0;
  let run = 0;
  let last = null;
  for (const [week, days] of [...weeks].sort(([a], [b]) => a - b)) {
    if (days < WEEKLY_GOAL) continue;
    run = last !== null && week - last === 7 * DAY ? run + 1 : 1;
    best = Math.max(best, run);
    last = week;
  }
  return best;
}

const byName = (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
const byLift = (a, b) => b.weight - a.weight || b.reps - a.reps;
const repMode = mode => mode == null || mode === 'reps' || mode === 'amrap';

export function leaderboard(users, stateFor, month, today) {
  const exercises = new Map();
  const heaviest = [];
  const consistency = [];

  for (const user of users.filter(leaderboardMember)) {
    const state = stateFor(user.id);
    const profile = { id: user.id, name: user.name };
    const factor = state?.unit === 'lb' ? KG_PER_LB : 1;
    const customIds = new Set(records(state?.customEx).map(ex => ex.id));
    const volumeByDay = new Map();
    const bestLifts = new Map();

    for (const workout of records(state?.workouts)) {
      const date = trainingDate(workout);
      if (!date || date > today || (month !== 'all' && !date.startsWith(month))) continue;

      // The saved volume uses working sets and already counts drops and dumbbells as logged.
      const volume = Number.isFinite(workout.vol) && workout.vol >= 0 ? workout.vol : workoutVolume(workout);
      volumeByDay.set(date, (volumeByDay.get(date) || 0) + Math.max(0, volume) * factor);

      for (const entry of records(workout.entries)) {
        const exercise = entry.id;
        if (typeof exercise !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(exercise) || customIds.has(exercise)) continue;
        // A per-dumbbell result and a combined load are different record categories.
        const basis = ['each', 'total'].includes(entry.target?.dbLoad) ? entry.target.dbLoad : 'logged';
        const key = JSON.stringify([exercise, basis]);
        for (const set of records(entry.sets)) {
          if (set.phase === 'warmup' || (!set.phase && set.warmup) || !repMode(set.mode ?? entry.target?.mode)) continue;
          const rows = set.sides ? [set.sides.L, set.sides.R] : [set];
          for (const row of rows) {
            const weight = roundKg(Number(row?.w) * factor);
            const reps = Number(row?.r);
            if (!row?.done || !Number.isFinite(weight) || weight <= 0 || !Number.isInteger(reps) || reps <= 0) continue;
            const score = { ...profile, weight, reps, date };
            const best = bestLifts.get(key)?.score;
            if (!best || byLift(score, best) < 0 || (byLift(score, best) === 0 && date < best.date)) {
              bestLifts.set(key, { exercise, basis, score });
            }
          }
        }
      }
    }

    const dates = [...volumeByDay.keys()];
    if (dates.length) {
      const days = dates.map(date => ({ ...profile, date, volume: roundKg(volumeByDay.get(date)) }));
      days.sort((a, b) => b.volume - a.volume || a.date.localeCompare(b.date));
      if (days[0].volume > 0) heaviest.push(days[0]);
      consistency.push({ ...profile, weeks: longestStreak(dates), days: dates.length });
    }

    for (const [key, { exercise, basis, score }] of bestLifts) {
      if (!exercises.has(key)) exercises.set(key, { exercise, basis, rows: [] });
      exercises.get(key).rows.push(score);
    }
  }

  for (const board of exercises.values()) board.rows.sort((a, b) => byLift(a, b) || byName(a, b));
  heaviest.sort((a, b) => b.volume - a.volume || byName(a, b));
  consistency.sort((a, b) => b.weeks - a.weeks || byName(a, b));
  return { month, exercises: [...exercises.values()], heaviest, consistency };
}
