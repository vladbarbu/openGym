-- Mirrors GET /api/nudge-check, api/nudge.js and api/queue.js. Keep the reply small:
-- native reminder checks only need the day, whether it is done or due, and the revision.
create function public.nudge_check(date text)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  today date;
  doc jsonb := '{}';
  revision int := 0;
  plan jsonb;
  queue jsonb;
  since double precision;
  starts_on text;
  strict_pass boolean;
  done_today boolean;
  nudge_today boolean;
begin
  if caller is null then
    raise sqlstate 'PT401' using message = 'not signed in';
  end if;
  if $1 is null or $1 !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or right($1, 2) not between '01' and '31' then
    raise sqlstate 'PT400' using message = 'date must be YYYY-MM-DD', detail = 'date-invalid';
  end if;
  begin
    -- Like Date.parse, a day through 31 can roll into the next month.
    today := make_date(case when left($1, 4) = '0000' then -1 else left($1, 4)::int end,
      substr($1, 6, 2)::int, 1) + (right($1, 2)::int - 1);
  exception when datetime_field_overflow then
    raise sqlstate 'PT400' using message = 'date must be YYYY-MM-DD', detail = 'date-invalid';
  end;

  select s.doc, s.rev into doc, revision from public.app_state s where s.user_id = caller;
  plan := case when jsonb_typeof(doc->'dayPlan') = 'object' then doc->'dayPlan' else '{}'::jsonb end;
  queue := doc->'queue';
  since := opengym_private.js_number(queue->'since');
  strict_pass := coalesce(queue->'strict' = 'true'::jsonb, false);

  if jsonb_typeof(queue->'ids') = 'array' and (not strict_pass or since > 0) then
    if jsonb_typeof(queue->'startsOn') = 'string' then
      starts_on := queue->>'startsOn';
    elsif since > 0 then
      begin
        starts_on := to_char(to_timestamp(since / 1000) at time zone coalesce(nullif(doc->'reminder'->>'tz', ''), 'UTC'), 'YYYY-MM-DD');
      exception when invalid_parameter_value then
        starts_on := to_char(to_timestamp(since / 1000) at time zone 'UTC', 'YYYY-MM-DD');
      end;
    end if;
  end if;

  with workouts as materialized (
    select w, w->>'d' as day, coalesce(w->>'name', '') as name
    from opengym_private.records(doc->'workouts') w
  ),
  routines as materialized (
    -- A duplicate id uses the first routine's name, as in stateQueue.
    select distinct on (r->'id') r->'id' as id, r->>'name' as name
    from opengym_private.records(doc->'routines') with ordinality as entries(r, ord)
    where opengym_private.js_truthy(r->'id')
    order by r->'id', ord
  ),
  queue_ids as materialized (
    select distinct r.id, r.name
    from jsonb_array_elements(case when nullif(starts_on, '') is not null
      then queue->'ids' else '[]'::jsonb end) q(id)
    join routines r using (id)
  ),
  queue_workouts as (
    select ids.id,
      (since > 0 and coalesce(opengym_private.js_number(w->'start'), 0) >= since) as by_clock,
      workouts.day,
      workouts.day >= starts_on and not strict_pass and nullif(q.name, '') is not null
        and strpos(' + ' || workouts.name || ' + ', ' + ' || q.name || ' + ') > 0 as by_name
    from workouts
    cross join lateral jsonb_array_elements(case
      when jsonb_typeof(w->'routineIds') = 'array' then w->'routineIds'
      else jsonb_build_array(w->'routineId') end) ids(id)
    join queue_ids q on q.id = ids.id
  ),
  queue_done as materialized (
    select id, bool_or(by_clock) as by_clock, min(day collate "C") filter (where by_name) as by_name
    from queue_workouts
    group by id
  ),
  logged as materialized (
    select distinct day from workouts where jsonb_typeof(w->'d') = 'string'
  ),
  dates as (
    select i, today - i as calendar_day,
      case when i = 0 then $1 else to_char(today - i, 'YYYY-MM-DD') end as iso
    from generate_series(0, 14) i
  ),
  days as (
    select i, iso, calendar_day, iso in (select day from logged) or coalesce(
      jsonb_typeof(note) = 'object' and (
        note->>'tag' in ('sick', 'travel', 'rest', 'injured')
        or (jsonb_typeof(note->'text') = 'string' and note->>'text' ~ '[^[:space:] ﻿]')
      ), false) as done
    from dates
    cross join lateral (select doc->'dayNotes'->iso as note) notes
  ),
  planned as (
    select days.*,
      case
        when override = '"rest"'::jsonb then false
        when override in (select id from routines)
          and (open_override or override not in (select id from queue_ids)) then true
        when live and can_float then true
        else exists (
          select 1 from jsonb_array_elements(case
            when jsonb_typeof(week_entry) = 'array' then week_entry
            else jsonb_build_array(week_entry) end) w(id)
          join routines r on r.id = w.id
          where not live or r.id not in (select id from queue_ids)
        )
      end as due,
      live
    from days
    cross join lateral (
      select plan->iso as override,
        case when jsonb_typeof(doc->'week') = 'array' then doc->'week'->(extract(dow from calendar_day)::int)
          else doc->'week'->(extract(dow from calendar_day)::int::text) end as week_entry
    ) choices
    cross join lateral (
      with remaining as materialized (
        select q.id from queue_ids q left join queue_done d using (id)
        where not coalesce(d.by_clock or d.by_name collate "C" <= days.iso, false)
      )
      select
        coalesce(days.iso collate "C" >= starts_on and exists (select 1 from remaining), false) as live,
        override in (select id from remaining) as open_override,
        exists (
          select 1 from remaining r
          where not exists (
            select 1 from jsonb_each(plan) p where p.key collate "C" > days.iso and p.value = r.id
          )
        ) as can_float
    ) queue_day
  ),
  missed as (
    select *, not done and due and
      not (live and to_char(calendar_day - 1, 'YYYY-MM-DD') in (select day from logged)) as miss
    from planned
  )
  select done, miss and (
    select count(*) from missed prior
    where prior.i > 0 and prior.miss
      and prior.iso collate "C" > coalesce((select max(day collate "C") from logged where day collate "C" < $1), '')
  ) < 3
  into done_today, nudge_today
  from missed
  where i = 0;

  return jsonb_build_object('date', $1, 'done', done_today, 'nudge', nudge_today, 'rev', coalesce(revision, 0));
end;
$$;

revoke all on function public.nudge_check(text) from public, anon, authenticated, service_role;
grant execute on function public.nudge_check(text) to authenticated;
