create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
create extension if not exists supabase_vault with schema vault;

create table public.push_subscriptions (
  endpoint text primary key,
  user_id uuid not null references auth.users on delete cascade,
  keys jsonb not null,
  device_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default clock_timestamp()
);
create index push_subscriptions_user_idx on public.push_subscriptions (user_id);

create table public.push_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  kind text not null check (kind in ('rest-timer', 'test', 'reminder', 'nudge', 'checkin', 'recap', 'wrapped')),
  due_at timestamptz not null default now(),
  payload jsonb not null default '{}',
  device_id text,
  period text,
  sent_at timestamptz,
  unique (user_id, kind, period)
);
create index push_jobs_due_idx on public.push_jobs (due_at, id) where sent_at is null;
create index push_jobs_sent_idx on public.push_jobs (sent_at) where sent_at is not null;

alter table public.push_subscriptions enable row level security;
alter table public.push_jobs enable row level security;
revoke all on public.push_subscriptions, public.push_jobs from public, anon, authenticated, service_role;
grant select on public.push_subscriptions to authenticated;
grant select, delete on public.push_subscriptions to service_role;
create policy push_read_own on public.push_subscriptions for select to authenticated
  using (user_id = (select auth.uid()));

create table opengym_private.push_presence (
  user_id uuid primary key references auth.users on delete cascade,
  until_at timestamptz not null
);

-- The account lock keeps the queue and subscription limits intact across concurrent requests.
create function opengym_private.push_user()
returns uuid language plpgsql set search_path = '' as $$
declare caller uuid;
begin
  select id into caller from auth.users
   where id = auth.uid() and (banned_until is null or banned_until <= now()) for no key update;
  if not found then raise sqlstate 'PT401' using message = 'not signed in'; end if;
  return caller;
end;
$$;

create function opengym_private.push_device(value text)
returns text language sql immutable set search_path = '' as $$
  select case when value collate "C" ~ '^[A-Za-z0-9_-]{8,64}$' then value end;
$$;

-- The sender only connects to browser push services plus an exact operator-configured test URL.
create function opengym_private.push_endpoint_allowed(value text)
returns boolean language sql stable set search_path = '' as $$
  select coalesce(length(value) <= 2048 and (
    value collate "C" ~ '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)/[^[:space:][:cntrl:]]+$'
    or value = (select decrypted_secret from vault.decrypted_secrets where name = 'push_test_endpoint')
  ), false);
$$;

create function public.push_subscribe(endpoint text, keys jsonb, device_id text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := opengym_private.push_user();
  clean_keys jsonb;
begin
  if not opengym_private.push_endpoint_allowed(endpoint) then
    raise sqlstate 'PT400' using message = 'invalid push endpoint';
  end if;
  if not coalesce((keys ->> 'p256dh') collate "C" ~ '^B[A-Za-z0-9_+/-]{86}=?$'
      and (keys ->> 'auth') collate "C" ~ '^[A-Za-z0-9_+/-]{22}(==)?$', false) then
    raise sqlstate 'PT400' using message = 'invalid subscription keys';
  end if;
  clean_keys := jsonb_build_object('p256dh', keys ->> 'p256dh', 'auth', keys ->> 'auth');
  insert into public.push_subscriptions as sub (endpoint, user_id, keys, device_id)
    values (endpoint, caller, clean_keys, opengym_private.push_device(device_id))
    on conflict on constraint push_subscriptions_pkey do update
    set user_id = excluded.user_id, keys = excluded.keys,
        device_id = coalesce(excluded.device_id, sub.device_id), updated_at = clock_timestamp()
    where sub.user_id = caller or sub.keys = excluded.keys;
  if not found then
    raise sqlstate 'PT409' using message = 'this subscription belongs to another account';
  end if;
  delete from public.push_subscriptions as sub where sub.endpoint in (
    select s.endpoint from public.push_subscriptions as s where s.user_id = caller
     order by s.updated_at desc, s.endpoint offset 20
  );
  return '{"ok":true}';
end;
$$;

create function public.push_unsubscribe(endpoint text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare caller uuid := opengym_private.push_user();
begin
  delete from public.push_subscriptions as sub where sub.user_id = caller and sub.endpoint = push_unsubscribe.endpoint;
  return '{"ok":true}';
end;
$$;

create function public.push_status(endpoint text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := opengym_private.push_user();
  device text;
begin
  select sub.device_id into device from public.push_subscriptions as sub
    where sub.user_id = caller and sub.endpoint = push_status.endpoint;
  if found then return jsonb_build_object('subscribed', true, 'deviceId', device); end if;
  return '{"subscribed":false}';
end;
$$;

create function public.push_rest_timer(seconds integer, payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := opengym_private.push_user();
  device text := opengym_private.push_device(payload ->> 'deviceId');
begin
  if seconds is null or seconds < 1 then raise sqlstate 'PT400' using message = 'seconds required'; end if;
  if not exists (select 1 from public.push_subscriptions as sub where sub.user_id = caller
    and (device is null or sub.device_id is null or sub.device_id = device)) then
    return '{"ok":true}';
  end if;
  delete from public.push_jobs as job where job.user_id = caller and job.kind = 'rest-timer'
    and job.sent_at is null and job.device_id is not distinct from device;
  delete from public.push_jobs where id in (
    select id from public.push_jobs where user_id = caller and kind = 'rest-timer' and sent_at is null
      order by due_at desc, id offset 4
  );
  insert into public.push_jobs (user_id, kind, due_at, device_id, payload)
    values (caller, 'rest-timer', clock_timestamp() + make_interval(secs => least(3600, seconds)), device,
      jsonb_build_object('next', case when jsonb_typeof(payload -> 'next') = 'string' then left(payload ->> 'next', 512) end));
  return '{"ok":true}';
end;
$$;

create function public.push_rest_timer_cancel(device_id text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := opengym_private.push_user();
  device text := opengym_private.push_device(device_id);
begin
  delete from public.push_jobs as job where job.user_id = caller and job.kind = 'rest-timer'
    and job.sent_at is null and (device is null or job.device_id = device);
  return '{"ok":true}';
end;
$$;

create function public.push_test()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare caller uuid := opengym_private.push_user();
begin
  if (select count(*) from public.push_jobs where user_id = caller and kind = 'test'
      and due_at > now() - interval '10 minutes') >= 10 then
    raise sqlstate 'PT429' using message = 'too many requests, try again later';
  end if;
  if exists (select 1 from public.push_subscriptions where user_id = caller) then
    insert into public.push_jobs (user_id, kind) values (caller, 'test');
  end if;
  return '{"ok":true}';
end;
$$;

create function public.push_activity(active boolean, reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare caller uuid := opengym_private.push_user();
begin
  if active then
    insert into opengym_private.push_presence (user_id, until_at) values (caller, now() + interval '70 seconds')
      on conflict (user_id) do update set until_at = excluded.until_at;
  elsif reason = 'hidden' then
    update opengym_private.push_presence set until_at = least(until_at, now() + interval '45 seconds') where user_id = caller;
  else
    delete from opengym_private.push_presence where user_id = caller;
  end if;
  return '{"ok":true}';
end;
$$;

create function opengym_private.push_local_clock(at_time timestamptz, zone text)
returns timestamp language plpgsql stable set search_path = '' as $$
begin
  return at_time at time zone coalesce(nullif(zone, ''), 'UTC');
exception when invalid_parameter_value then
  return null;
end;
$$;

create function opengym_private.push_minutes(value text)
returns int language sql immutable set search_path = '' as $$
  select case when value collate "C" ~ '^[0-9]{2}:[0-9]{2}$'
    then left(value, 2)::int * 60 + right(value, 2)::int end;
$$;

-- Pass only profiles in an open window to the worker. The Node helpers decide what is owed.
create function public.push_candidates(at_time timestamptz, recap_month text, wrapped_year int, after_id uuid default null)
returns table (user_id uuid, doc jsonb, reminder_day text, nudge_day text, nudge_time text,
  checkin_day text, recap_joined text, wrapped_owed boolean)
language sql stable security definer set search_path = '' as $$
  select u.id, case when r.day is not null or n.day is not null or c.day is not null or w.owed then s.doc end,
    r.day, n.day, to_char(clock.workout, 'HH24:MI'), c.day, m.joined_month, coalesce(w.owed, false)
  from auth.users as u
  left join public.app_state as s on s.user_id = u.id
  left join public.memberships as m on m.user_id = u.id and m.notify and m.joined_month <= recap_month
    and not exists (select 1 from public.push_jobs as j where (j.user_id, j.kind, j.period) = (u.id, 'recap', recap_month))
  cross join lateral (select
    opengym_private.push_local_clock(at_time, s.doc #>> '{reminder,tz}') as workout,
    opengym_private.push_local_clock(at_time, coalesce(nullif(s.doc #>> '{checkinReminder,tz}', ''), s.doc #>> '{reminder,tz}')) as checkin
  ) as clock
  cross join lateral (select to_char(clock.workout, 'YYYY-MM-DD') as workout, to_char(clock.checkin, 'YYYY-MM-DD') as checkin) as dates
  left join lateral (select dates.workout as day where opengym_private.js_truthy(s.doc #> '{reminder,on}')
    and (opengym_private.push_minutes(to_char(clock.workout, 'HH24:MI')) - opengym_private.push_minutes(s.doc #>> '{reminder,time}')) between 0 and 15
    and not exists (select 1 from public.push_jobs as j where (j.user_id, j.kind, j.period) = (u.id, 'reminder', dates.workout))) as r on true
  left join lateral (select dates.workout as day where opengym_private.js_truthy(s.doc #> '{reminder,on}')
    and opengym_private.js_truthy(s.doc #> '{reminder,nudge}') and clock.workout::time >= time '20:00' and clock.workout::time < time '21:31'
    and not exists (select 1 from opengym_private.push_presence as p where p.user_id = u.id and p.until_at > at_time)
    and not exists (select 1 from public.push_jobs as j where (j.user_id, j.kind, j.period) = (u.id, 'nudge', dates.workout))) as n on true
  left join lateral (select dates.checkin as day where s.doc #> '{checkinReminder,on}' = 'true'::jsonb
    and (opengym_private.push_minutes(to_char(clock.checkin, 'HH24:MI')) - opengym_private.push_minutes(case
      when (s.doc #>> '{checkinReminder,time}') collate "C" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then s.doc #>> '{checkinReminder,time}'
      else '07:30' end)) between 0 and 15
    and not exists (select 1 from public.push_jobs as j where (j.user_id, j.kind, j.period) = (u.id, 'checkin', dates.checkin))) as c on true
  left join lateral (select true as owed where wrapped_year is not null and s.user_id is not null
    and not exists (select 1 from public.push_jobs as j where (j.user_id, j.kind, j.period) = (u.id, 'wrapped', wrapped_year::text))) as w on true
  where (after_id is null or u.id > after_id) and (u.banned_until is null or u.banned_until <= at_time)
    and exists (select 1 from public.push_subscriptions as sub where sub.user_id = u.id)
    and (r.day is not null or n.day is not null or c.day is not null or m.joined_month is not null or w.owed)
  order by u.id limit 5;
$$;

create function public.push_enqueue(jobs jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.push_jobs (user_id, kind, period, payload)
    select j.user_id, j.kind, j.period, j.payload
    from jsonb_to_recordset(jobs) as j(user_id uuid, kind text, period text, payload jsonb)
    join auth.users as u on u.id = j.user_id
    on conflict (user_id, kind, period) do nothing;
$$;

create function public.push_claim()
returns table (kind text, payload jsonb, lang text, subscriptions jsonb)
language sql security definer set search_path = '' as $$
  -- Keep monthly deduplication through the full following month.
  delete from public.push_jobs where sent_at < now() - interval '1 day'
    and (period is null or sent_at < now() - interval '62 days');
  with due as (
    select j.id from public.push_jobs as j where j.sent_at is null and j.due_at <= now()
      order by j.due_at, j.id limit 10 for update skip locked
  ), claimed as (
    update public.push_jobs as j set sent_at = now() from due where j.id = due.id returning j.*
  )
  select j.kind, j.payload, s.doc ->> 'lang', (
    select jsonb_agg(to_jsonb(sub)) from public.push_subscriptions as sub where sub.user_id = j.user_id
      and (j.device_id is null or sub.device_id is null or sub.device_id = j.device_id)
      and opengym_private.push_endpoint_allowed(sub.endpoint)
  )
  from claimed as j join auth.users as u on u.id = j.user_id
  left join public.app_state as s on s.user_id = j.user_id
  where u.banned_until is null or u.banned_until <= now();
$$;

revoke all on function public.push_subscribe(text, jsonb, text), public.push_unsubscribe(text), public.push_status(text),
  public.push_rest_timer(integer, jsonb), public.push_rest_timer_cancel(text), public.push_test(), public.push_activity(boolean, text),
  public.push_candidates(timestamptz, text, int, uuid), public.push_enqueue(jsonb), public.push_claim()
  from public, anon, authenticated, service_role;
grant execute on function public.push_subscribe(text, jsonb, text), public.push_unsubscribe(text), public.push_status(text),
  public.push_rest_timer(integer, jsonb), public.push_rest_timer_cancel(text), public.push_test(), public.push_activity(boolean, text)
  to authenticated;
grant execute on function public.push_candidates(timestamptz, text, int, uuid), public.push_enqueue(jsonb), public.push_claim()
  to service_role;

select cron.schedule('opengym-web-push', '10 seconds', $cron$
  select net.http_post(url := url.decrypted_secret,
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Push-Secret', secret.decrypted_secret),
    timeout_milliseconds := 120000)
  from vault.decrypted_secrets as url cross join vault.decrypted_secrets as secret
  where url.name = 'push_function_url' and secret.name = 'push_cron_secret';
$cron$);
