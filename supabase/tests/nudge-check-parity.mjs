import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { excusedOn, nudgeFor } from '../../api/nudge.js';

const sqlValue = v => '$parity$' + JSON.stringify(v) + '$parity$';
const uid = randomUUID();
const other = randomUUID();
const date = '2026-11-26';
const empty = { routines: [{ id: 'a', name: 'Push' }, { id: 'b', name: 'Pull' }], workouts: [], week: { 4: ['a'] } };
const queue = { ids: ['a', 'b'], startsOn: '2026-11-25', since: Date.parse('2026-11-25T09:00:00Z') };
const cases = [
  ['empty account', null],
  ['calendar day', empty],
  ['logged today', { ...empty, workouts: [{ d: date }] }],
  ['excused by tag', { ...empty, dayNotes: { [date]: { tag: 'travel' } } }],
  ['excused by text', { ...empty, dayNotes: { [date]: { text: ' away ' } } }],
  ['whitespace note', { ...empty, dayNotes: { [date]: { text: ' \n\t' } } }],
  ['rest override', { ...empty, dayPlan: { [date]: 'rest' } }],
  ['backoff after 3 missed dates', { ...empty, week: { 1: 'a', 2: 'a', 3: 'a', 4: 'a' } }],
  ['live queue', { ...empty, week: {}, queue }],
  ['queue pinned elsewhere', { ...empty, queue, dayPlan: { '2026-11-27': 'a', '2026-11-28': 'b' } }],
  ['queue pinned today', { ...empty, queue, dayPlan: { [date]: 'b', '2026-11-28': 'a' } }],
  ['queue day after a workout', { ...empty, queue, workouts: [{ d: '2026-11-25', routineId: 'a', start: queue.since }] }],
  ['queue completed by workouts started since apply', { ...empty, week: {}, queue, workouts: [{ d: '2026-11-24', name: 'Push + Pull', routineIds: ['a', 'b'], start: queue.since }] }],
  ['queue completed by a dated log', { ...empty, week: {}, queue: { ...queue, startsOn: '2026-11-24' }, workouts: [{ d: '2026-11-24', name: 'Push + Pull', routineIds: ['a', 'b'] }] }],
  ['strict pass ignores dated names', { ...empty, week: {}, queue: { ...queue, startsOn: '2026-11-24', strict: true }, workouts: [{ d: '2026-11-24', name: 'Push + Pull', routineIds: ['a', 'b'] }] }],
  ['fallback to queue apply date', { ...empty, queue: { ...queue, startsOn: undefined }, reminder: { tz: 'not/a/timezone' } }],
];
const statements = cases.map(([name, state], i) => {
  const doc = state || {};
  // Match the Node route, with the Supabase row's revision in place of doc._rev.
  const done = !!doc.workouts?.some(w => w?.d === date) || excusedOn(doc, date);
  const expected = { date, done, nudge: !done && !!nudgeFor(doc, date), rev: state ? i + 1 : 0 };
  return `
    reset role;
    ${state ? `insert into public.app_state (user_id, doc, rev, wid) values ('${uid}', ${sqlValue(state)}::jsonb, ${i + 1}, 'parity')
      on conflict (user_id) do update set doc = excluded.doc, rev = excluded.rev;` : ''}
    set local role authenticated;
    set local request.jwt.claim.sub = '${uid}';
    do \$sql\$ declare actual jsonb := public.nudge_check('${date}'); begin
      if actual is distinct from ${sqlValue(expected)}::jsonb then
        raise exception '%: expected %, got %', '${name}', ${sqlValue(expected)}, actual;
      end if;
    end; \$sql\$;`;
});
// The fixtures are rolled back even if a comparison raises an error.
const sql = `begin;
insert into auth.users (id,email) values ('${uid}','nudge-parity-${uid}@example.test'),('${other}','nudge-parity-${other}@example.test');
${statements.join('\n')}
set local request.jwt.claim.sub = '${other}';
do \$sql\$ begin
  if (public.nudge_check('${date}')->>'rev')::int <> 0 then raise exception 'cross-account access'; end if;
  if has_function_privilege('anon', 'public.nudge_check(text)', 'execute')
    or has_function_privilege('service_role', 'public.nudge_check(text)', 'execute') then raise exception 'unexpected grant'; end if;
  begin
    perform public.nudge_check('bad-date');
    raise exception 'invalid date was accepted';
  exception when sqlstate 'PT400' then null;
  end;
end; \$sql\$;
rollback;
select '${cases.length} Node/SQL cases, account isolation, grants and date validation passed';`;
try {
  execFileSync('docker', [
    'exec', 'supabase_db_opengym', 'psql', '-U', 'postgres', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', sql
  ], { stdio: ['ignore', 'inherit', 'inherit'], timeout: 60000 });
} catch (e) {
  console.error('Local nudge check failed:', e.code || e.status);
  process.exitCode = 1;
}
