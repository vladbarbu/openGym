create schema opengym_private;
revoke all on schema opengym_private from public, anon, authenticated, service_role;

create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  name text not null check (char_length(name) between 1 and 64)
);

create function opengym_private.create_profile()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, name)
  values (new.id, coalesce(trim(new.raw_user_meta_data ->> 'name'), split_part(new.email, '@', 1)));
  return new;
end;
$$;

create trigger create_profile after insert on auth.users
for each row execute function opengym_private.create_profile();

create table public.app_state (
  user_id uuid primary key references auth.users on delete cascade default auth.uid(),
  doc jsonb not null,
  rev int not null,
  wid text not null,
  updated_at timestamptz default now()
);

create table public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 64),
  invite_code text unique not null,
  created_by uuid references auth.users on delete set null,
  created_at timestamptz default now()
);

create table public.memberships (
  user_id uuid primary key references auth.users on delete cascade,
  group_id uuid not null references public.groups on delete cascade,
  joined_month text not null,
  notify boolean not null default true
);

create index groups_created_by_idx on public.groups (created_by);
create index memberships_group_id_idx on public.memberships (group_id);

alter table public.profiles enable row level security;
alter table public.app_state enable row level security;
alter table public.groups enable row level security;
alter table public.memberships enable row level security;

revoke all on public.profiles, public.app_state, public.groups, public.memberships from public, anon, authenticated;
grant select on public.profiles, public.app_state to authenticated;
grant update (name) on public.profiles to authenticated;

create policy read_own_profile on public.profiles for select to authenticated
  using (id = (select auth.uid()));
create policy update_own_profile on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));
create policy read_own_state on public.app_state for select to authenticated
  using (user_id = (select auth.uid()));

create function opengym_private.records(items jsonb)
returns setof jsonb
language sql immutable parallel safe set search_path = ''
as $$
  select item
  from jsonb_array_elements(case when jsonb_typeof(items) = 'array' then items else '[]'::jsonb end) as a(item)
  where jsonb_typeof(item) = 'object';
$$;

-- Return SQL null for JavaScript NaN or a missing property.
create function opengym_private.js_number(value jsonb)
returns double precision
language plpgsql immutable parallel safe set search_path = ''
as $$
declare
  input text;
  radix int;
  digit text;
  result double precision := 0;
begin
  if jsonb_typeof(value) = 'boolean' then
    return case when value = 'true'::jsonb then 1 else 0 end;
  end if;
  -- Number(array) converts the array to a string before parsing it.
  while jsonb_typeof(value) = 'array' loop
    case jsonb_array_length(value)
      when 0 then return 0;
      when 1 then value := value -> 0;
      else return null;
    end case;
  end loop;
  if value = 'null'::jsonb then
    return 0;
  end if;
  if jsonb_typeof(value) not in ('number', 'string') or value is null then
    return null;
  end if;

  input := btrim(value #>> '{}', U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
  if input = '' then
    return 0;
  end if;
  if input in ('Infinity', '+Infinity', '-Infinity')
      or input ~ '^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?$' then
    return input::double precision;
  end if;
  radix := case
    when input ~ '^0[xX][0-9A-Fa-f]+$' then 16
    when input ~ '^0[oO][0-7]+$' then 8
    when input ~ '^0[bB][01]+$' then 2
  end;
  if radix is null then
    return null;
  end if;
  -- Parse as an integer before converting to IEEE-754, as Number() does.
  declare
    integer_value numeric := 0;
  begin
    foreach digit in array string_to_array(lower(substr(input, 3)), null) loop
      integer_value := integer_value * radix + strpos('0123456789abcdef', digit) - 1;
      if integer_value > 1e309 then
        return 'Infinity'::double precision;
      end if;
    end loop;
    result := integer_value::double precision;
  end;
  return result;
exception when numeric_value_out_of_range then
  -- A PostgreSQL float cast raises where Number() underflows to zero or overflows.
  if radix is null and (input ~ '[eE]-[0-9]+$' or input ~ '^[+-]?0*\.') then
    return 0;
  end if;
  return case when left(input, 1) = '-' then '-Infinity'::double precision else 'Infinity'::double precision end;
end;
$$;

create function public.get_state()
returns jsonb
language sql stable security invoker set search_path = ''
as $$
  select coalesce(
    (select jsonb_build_object('state', s.doc, 'rev', s.rev) from public.app_state s where s.user_id = auth.uid()),
    '{"state":null,"rev":0}'::jsonb
  );
$$;

create function public.get_state_rev()
returns jsonb
language sql stable security invoker set search_path = ''
as $$
  select coalesce(
    (select jsonb_build_object('rev', s.rev, 'wid', s.wid) from public.app_state s where s.user_id = auth.uid()),
    '{"rev":0,"wid":null}'::jsonb
  );
$$;

create function public.put_state(state jsonb, base_rev int default null, base_wid text default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  doc jsonb := state;
  current_state public.app_state%rowtype;
  cur_rev int;
  next_rev int;
  next_wid text;
  wid_history jsonb;
  list_key text;
  written_at timestamptz;
begin
  if caller is null then
    raise exception using errcode = '42501', message = 'not signed in';
  end if;
  if jsonb_typeof(doc) is distinct from 'object' or (doc - '_rev' - '_ts') = '{}'::jsonb then
    raise exception using errcode = '22023', message = 'state required';
  end if;
  foreach list_key in array array['workouts', 'routines'] loop
    case jsonb_typeof(doc -> list_key)
      when 'array' then
        doc := jsonb_set(doc, array[list_key], (
          select coalesce(jsonb_agg(item order by position), '[]'::jsonb)
          from opengym_private.records(doc -> list_key) with ordinality as r(item, position)
        ));
      when 'null' then null;
      else
        if doc ? list_key then
          raise exception using errcode = '22023', message = 'invalid state';
        end if;
    end case;
  end loop;

  -- Lock the owner first so compare-and-set also serializes before the first state row exists.
  perform 1 from auth.users where id = caller for no key update;
  select * into current_state from public.app_state where user_id = caller for update;
  cur_rev := coalesce(current_state.rev, 0);
  if (base_rev is not null and base_rev <> cur_rev)
      or (base_wid is not null and base_wid is distinct from current_state.wid) then
    raise sqlstate 'PT409' using message = 'conflict',
      detail = jsonb_build_object('rev', cur_rev, 'state', current_state.doc)::text;
  end if;

  doc := doc - 'active';
  if coalesce(opengym_private.js_number(current_state.doc -> 'resetAt'), 0)
      > coalesce(opengym_private.js_number(doc -> 'resetAt'), 0) then
    doc := jsonb_set(doc, '{resetAt}', current_state.doc -> 'resetAt') - 'resetIds';
    if jsonb_typeof(current_state.doc -> 'resetIds') in ('object', 'array') then
      doc := jsonb_set(doc, '{resetIds}', current_state.doc -> 'resetIds');
    end if;
  end if;
  next_rev := cur_rev + 1;
  next_wid := encode(extensions.gen_random_bytes(8), 'hex');
  wid_history := case when jsonb_typeof(current_state.doc -> '_wids') = 'array'
    then current_state.doc -> '_wids' else '[]'::jsonb end;
  if current_state.wid is not null then
    wid_history := wid_history || jsonb_build_array(current_state.wid);
  end if;
  select coalesce(jsonb_agg(item order by position), '[]'::jsonb) into wid_history
  from (
    select item, position
    from jsonb_array_elements(wid_history) with ordinality as h(item, position)
    where jsonb_typeof(item) = 'string'
    order by position desc limit 50
  ) as recent;
  doc := doc || jsonb_build_object('_rev', next_rev, '_wid', next_wid, '_wids', wid_history);
  if octet_length(doc::text) > 5 * 1024 * 1024 then
    raise exception using errcode = '54000', message = 'too large';
  end if;

  written_at := clock_timestamp();
  insert into public.app_state (user_id, doc, rev, wid, updated_at)
  values (caller, doc, next_rev, next_wid, written_at)
  on conflict (user_id) do update
    set doc = excluded.doc, rev = excluded.rev, wid = excluded.wid, updated_at = excluded.updated_at;
  return jsonb_build_object('ok', true, 'ts', floor(extract(epoch from written_at) * 1000)::bigint, 'rev', next_rev, 'wid', next_wid);
end;
$$;

create function public.create_group(name text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  invite_bits bit(104);
  code text;
  new_group_id uuid;
begin
  if caller is null then
    raise exception using errcode = '42501', message = 'not signed in';
  end if;
  perform 1 from auth.users where id = caller for no key update;
  if exists (select 1 from public.memberships where user_id = caller) then
    raise exception using errcode = 'P0001', message = 'already-member';
  end if;

  invite_bits := ('x' || encode(extensions.gen_random_bytes(13), 'hex'))::bit(104);
  select string_agg(substr('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', substring(invite_bits, i, 5)::int + 1, 1), '' order by i)
    into code from generate_series(1, 96, 5) as s(i);
  insert into public.groups (name, invite_code, created_by)
  values (name, code, caller) returning id into new_group_id;
  insert into public.memberships (user_id, group_id, joined_month)
  values (caller, new_group_id, to_char(now() at time zone 'UTC', 'YYYY-MM'));
  return jsonb_build_object('joined', true, 'notify', true, 'group', jsonb_build_object('name', name, 'code', code));
end;
$$;

create function public.join_group(code text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  target_group public.groups%rowtype;
  preference boolean;
begin
  if caller is null then
    raise exception using errcode = '42501', message = 'not signed in';
  end if;
  perform 1 from auth.users where id = caller for no key update;
  select * into target_group from public.groups where invite_code = upper(trim(code) collate "C");
  if not found then
    raise exception using errcode = 'P0001', message = 'leaderboard-invite';
  end if;
  insert into public.memberships as m (user_id, group_id, joined_month)
  values (caller, target_group.id, to_char(now() at time zone 'UTC', 'YYYY-MM'))
  on conflict (user_id) do update
    set group_id = excluded.group_id, joined_month = excluded.joined_month
    where m.group_id <> excluded.group_id;
  select notify into preference from public.memberships where user_id = caller;
  return jsonb_build_object('joined', true, 'notify', preference,
    'group', jsonb_build_object('name', target_group.name, 'code', target_group.invite_code));
end;
$$;

create function public.set_leaderboard_notify(notify boolean)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := auth.uid();
begin
  if caller is null then
    raise exception using errcode = '42501', message = 'not signed in';
  end if;
  perform 1 from auth.users where id = caller for no key update;
  update public.memberships set notify = set_leaderboard_notify.notify where user_id = caller;
  return jsonb_build_object('joined', found, 'notify', found and notify);
end;
$$;

create function public.leave_group()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := auth.uid();
begin
  if caller is null then
    raise exception using errcode = '42501', message = 'not signed in';
  end if;
  perform 1 from auth.users where id = caller for no key update;
  delete from public.memberships where user_id = caller;
  return '{"joined":false,"notify":false}'::jsonb;
end;
$$;

create function opengym_private.js_truthy(value jsonb)
returns boolean
language sql immutable parallel safe set search_path = ''
as $$
  select coalesce(value not in ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb), false);
$$;

create function opengym_private.training_date(value jsonb)
returns date
language plpgsql immutable parallel safe set search_path = ''
as $$
declare
  iso text := value #>> '{}';
  year_number int;
begin
  if jsonb_typeof(value) is distinct from 'string' or iso !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    return null;
  end if;
  year_number := left(iso, 4)::int;
  -- ISO year 0000 is 1 BC in PostgreSQL.
  return make_date(case when year_number = 0 then -1 else year_number end,
    substr(iso, 6, 2)::int, right(iso, 2)::int);
exception when datetime_field_overflow then
  return null;
end;
$$;

-- PostgreSQL raises on floating-point overflow and underflow, which JavaScript propagates.
create function opengym_private.js_add(a double precision, b double precision)
returns double precision
language plpgsql immutable parallel safe set search_path = ''
as $$
begin
  return a + b;
exception when numeric_value_out_of_range then
  return case when a < 0 then '-Infinity'::double precision else 'Infinity'::double precision end;
end;
$$;

create function opengym_private.js_multiply(a double precision, b double precision)
returns double precision
language plpgsql immutable parallel safe set search_path = ''
as $$
begin
  return a * b;
exception when numeric_value_out_of_range then
  if abs(a) < 1 or abs(b) < 1 then
    return 0;
  end if;
  return case when (a < 0) <> (b < 0) then '-Infinity'::double precision else 'Infinity'::double precision end;
end;
$$;

create aggregate opengym_private.js_sum(double precision) (
  sfunc = opengym_private.js_add,
  stype = double precision,
  initcond = '0'
);

create function opengym_private.js_round(value double precision)
returns double precision
language sql immutable parallel safe set search_path = ''
as $$
  select case when value - floor(value) >= 0.5 and abs(value) < 4503599627370496
    then floor(value) + 1 else floor(value) end;
$$;

create function opengym_private.round_kg(value double precision)
returns double precision
language sql immutable parallel safe set search_path = ''
as $$
  select opengym_private.js_round(opengym_private.js_multiply(value, 1000)) / 1000;
$$;

create function opengym_private.set_rows(logged_set jsonb)
returns setof jsonb
language sql immutable parallel safe set search_path = ''
as $$
  select unnest(case when opengym_private.js_truthy(logged_set -> 'sides')
    then array[logged_set #> '{sides,L}', logged_set #> '{sides,R}']
    else array[logged_set] end);
$$;

create function opengym_private.workout_volume(workout jsonb)
returns double precision
language sql immutable parallel safe set search_path = ''
as $$
  -- Keep the same ordered sums as projections.js: sides, sets, then entries.
  select opengym_private.js_round(opengym_private.js_sum(e.volume order by e.position))
  from (
    select entries.position, (
      select opengym_private.js_sum(
        case when logged_set -> 'phase' = '"warmup"'::jsonb or
            (logged_set ->> 'phase' is null and logged_set -> 'warmup' = 'true'::jsonb)
          then 0
          else (
            select opengym_private.js_sum(case when opengym_private.js_truthy(row -> 'done')
              then opengym_private.js_multiply(
                case when abs(numbers.weight) < 'Infinity'::double precision then numbers.weight else 0 end,
                case when abs(numbers.reps) < 'Infinity'::double precision then numbers.reps else 0 end
              ) else 0 end order by sides.position)
            from opengym_private.set_rows(logged_set) with ordinality as sides(row, position)
            cross join lateral (
              select opengym_private.js_number(row -> 'w') as weight, opengym_private.js_number(row -> 'r') as reps
            ) as numbers
          )
        end order by sets.position
      )
      from opengym_private.records(entry -> 'sets') with ordinality as sets(logged_set, position)
    ) as volume
    from opengym_private.records(workout -> 'entries') with ordinality as entries(entry, position)
  ) as e;
$$;

create function public.leaderboard(month text default 'all')
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  caller_group uuid;
  caller_notify boolean;
  group_details jsonb;
  utc_today date := (now() at time zone 'UTC')::date;
  today_iso text := to_char(utc_today, 'YYYY-MM-DD');
  current_month text := left(today_iso, 7);
  previous_month text := to_char(date_trunc('month', utc_today::timestamp) - interval '1 month', 'YYYY-MM');
  rankings jsonb;
begin
  if caller is null then
    raise exception using errcode = '42501', message = 'not signed in';
  end if;

  select g.id, m.notify, jsonb_build_object('name', g.name, 'code', g.invite_code)
  into caller_group, caller_notify, group_details
  from public.memberships m join public.groups g on g.id = m.group_id
  where m.user_id = caller;
  if not found then
    return '{"joined":false}'::jsonb;
  end if;
  if month is null or (month <> 'all' and
      (month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' or month collate "C" > current_month collate "C")) then
    raise exception using errcode = '22023', message = 'invalid leaderboard month';
  end if;

  -- en-US ICU gives the default Node localeCompare order for ASCII names, including case.
  with group_workouts as (
    select p.id, p.name collate "en-US-x-icu" as name, s.doc -> 'customEx' as custom_ex,
      case when s.doc ->> 'unit' = 'lb' then 0.45359237::double precision else 1::double precision end as factor,
      w.workout, w.position, (w.workout ->> 'd') collate "C" as iso, d.training_day
    from public.memberships m
    join public.profiles p on p.id = m.user_id
    join public.app_state s on s.user_id = m.user_id
    cross join lateral opengym_private.records(s.doc -> 'workouts') with ordinality as w(workout, position)
    cross join lateral (select opengym_private.training_date(w.workout -> 'd') as training_day) d
    where m.group_id = caller_group and d.training_day <= utc_today
      and (month = 'all' or left(w.workout ->> 'd', 7) = month)
  ), workout_volumes as (
    select id, name, iso, training_day, position, factor,
      case when saved.volume >= 0 and saved.volume < 'Infinity'::double precision then saved.volume
        else opengym_private.workout_volume(workout) end as volume
    from group_workouts
    cross join lateral (
      select case when jsonb_typeof(workout -> 'vol') = 'number'
        then opengym_private.js_number(workout -> 'vol') end as volume
    ) as saved
  ), daily as (
    select id, name, iso, training_day, opengym_private.round_kg(
      opengym_private.js_sum(opengym_private.js_multiply(greatest(0, volume), factor) order by position)
    ) as volume
    from workout_volumes
    group by id, name, iso, training_day
  ), heaviest as (
    select distinct on (id) id, name, iso, volume
    from daily
    where volume > 0 and volume <> 'NaN'::double precision
    order by id, volume desc, iso
  ), active_days as (
    select id, name, count(*) as days from daily group by id, name
  ), qualified_weeks as (
    select id, training_day - (extract(isodow from training_day)::int - 1) as monday
    from daily
    group by id, monday
    having count(*) >= 3
  ), week_runs as (
    select id, count(*) as weeks
    from (
      -- Consecutive Mondays share their offset from the ordered row number.
      select id, (monday - date '2000-01-03') - 7 * row_number() over (partition by id order by monday) as run
      from qualified_weeks
    ) as week_offsets
    group by id, run
  ), streaks as (
    select id, max(weeks) as weeks from week_runs group by id
  ), lifts as (
    select w.id, w.name, w.iso, (entry ->> 'id') collate "C" as exercise,
      (case when entry #>> '{target,dbLoad}' in ('each', 'total')
        then entry #>> '{target,dbLoad}' else 'logged' end) collate "C" as basis,
      score.weight, score.reps
    from group_workouts w
    cross join lateral opengym_private.records(w.workout -> 'entries') as e(entry)
    cross join lateral opengym_private.records(entry -> 'sets') as s(logged_set)
    cross join lateral opengym_private.set_rows(logged_set) as r(row)
    cross join lateral (
      select opengym_private.round_kg(opengym_private.js_multiply(opengym_private.js_number(row -> 'w'), w.factor)) as weight,
        opengym_private.js_number(row -> 'r') as reps
    ) as score
    where jsonb_typeof(entry -> 'id') = 'string' and (entry ->> 'id') collate "C" ~ '^[a-zA-Z0-9_-]{1,128}$'
      and not coalesce(w.custom_ex @> jsonb_build_array(jsonb_build_object('id', entry -> 'id')), false)
      and logged_set -> 'phase' is distinct from '"warmup"'::jsonb
      and (opengym_private.js_truthy(logged_set -> 'phase') or not opengym_private.js_truthy(logged_set -> 'warmup'))
      and coalesce(nullif(logged_set -> 'mode', 'null'::jsonb),
        nullif(entry #> '{target,mode}', 'null'::jsonb), '"reps"'::jsonb) in ('"reps"'::jsonb, '"amrap"'::jsonb)
      and opengym_private.js_truthy(row -> 'done')
      and score.weight > 0 and score.weight < 'Infinity'::double precision
      and score.reps > 0 and score.reps < 'Infinity'::double precision and score.reps = trunc(score.reps)
  ), best_lifts as (
    select distinct on (exercise, basis, id) exercise, basis, id, name, iso, weight, reps
    from lifts
    order by exercise, basis, id, weight desc, reps desc, iso
  ), boards as (
    select exercise, basis, jsonb_agg(
      jsonb_build_object('id', id, 'name', name, 'weight', weight, 'reps', reps, 'date', iso)
      order by weight desc, reps desc, name, id
    ) as rows
    from best_lifts
    group by exercise, basis
  )
  select jsonb_build_object(
    'exercises', coalesce((select jsonb_agg(to_jsonb(b) order by exercise, basis) from boards b), '[]'::jsonb),
    'heaviest', coalesce((select jsonb_agg(jsonb_build_object(
      'id', id, 'name', name, 'volume', nullif(volume, 'Infinity'::double precision), 'date', iso
    ) order by volume desc, name, id) from heaviest), '[]'::jsonb),
    'consistency', coalesce((select jsonb_agg(jsonb_build_object(
      'id', d.id, 'name', d.name, 'weeks', coalesce(s.weeks, 0), 'days', d.days
    ) order by coalesce(s.weeks, 0) desc, name, d.id)
      from active_days d left join streaks s on s.id = d.id), '[]'::jsonb)
  ) into rankings;

  return rankings || jsonb_build_object('joined', true, 'notify', caller_notify, 'currentMonth', current_month,
    'previousMonth', previous_month, 'group', group_details, 'month', month);
end;
$$;

revoke all on all functions in schema opengym_private from public, anon, authenticated, service_role;

revoke all on function public.get_state(), public.get_state_rev(), public.put_state(jsonb, int, text),
  public.create_group(text), public.join_group(text), public.set_leaderboard_notify(boolean),
  public.leave_group(), public.leaderboard(text) from public, anon, authenticated, service_role;

grant execute on function public.get_state(), public.get_state_rev(), public.put_state(jsonb, int, text),
  public.create_group(text), public.join_group(text), public.set_leaderboard_notify(boolean),
  public.leave_group(), public.leaderboard(text) to authenticated;
