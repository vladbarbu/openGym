alter table public.profiles add column role text not null default 'user'
  check (role in ('owner', 'admin', 'user'));

create table opengym_private.admin_settings (
  singleton boolean primary key default true check (singleton),
  invite_only boolean not null default false
);
insert into opengym_private.admin_settings default values;

create table opengym_private.admin_invites (
  code text primary key default upper(replace(gen_random_uuid()::text, '-', '')),
  note text not null default '',
  created_by uuid not null,
  created_at timestamptz not null default now(),
  used_by uuid,
  used_at timestamptz,
  expires timestamptz
);
-- Keep redeemed codes and audit identities even after an account is deleted.
create index admin_invites_used_by on opengym_private.admin_invites (used_by) where used_by is not null;

create table opengym_private.admin_audit (
  id bigint generated always as identity primary key,
  at timestamptz not null default clock_timestamp(),
  actor uuid,
  event text not null,
  target uuid,
  detail text,
  actor_name text,
  target_name text,
  ok boolean not null default true
);

create function opengym_private.log_admin(
  who uuid, event text, whom uuid default null, detail text default null, ok boolean default true
) returns void
language sql set search_path = ''
as $$
  insert into opengym_private.admin_audit (actor, event, target, detail, actor_name, target_name, ok)
  values (who, event, whom, left(detail, 120),
    (select left(name, 40) from public.profiles where id = who),
    (select left(name, 40) from public.profiles where id = whom), ok);
$$;

-- Lock the singleton to serialize first signup, ownership changes and Auth actions.
create or replace function opengym_private.create_profile()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  required boolean;
  consumed text;
  initial_role text := 'user';
  invite_code text := upper(btrim(new.raw_user_meta_data ->> 'invite'));
begin
  select invite_only into required from opengym_private.admin_settings for update;
  if invite_code <> '' then
    update opengym_private.admin_invites i
    set used_by = new.id, used_at = now()
    where i.code = invite_code and i.used_by is null and (i.expires is null or i.expires > now())
    returning i.code into consumed;
  end if;
  if required and consumed is null then
    raise exception 'a valid invite code is required';
  end if;
  if not coalesce(new.is_anonymous, false) and not exists (select 1 from public.profiles where role = 'owner') then
    initial_role := 'owner';
  end if;
  insert into public.profiles (id, name, role)
  values (new.id, coalesce(nullif(trim(new.raw_user_meta_data ->> 'name'), ''), split_part(new.email, '@', 1)), initial_role);
  if initial_role = 'owner' then
    perform opengym_private.log_admin(new.id, 'admin.first-user');
  end if;
  return new;
end;
$$;

update public.profiles set role = 'owner'
where id = (
  select p.id from public.profiles p join auth.users u on u.id = p.id
  where u.deleted_at is null and not coalesce(u.is_anonymous, false)
  order by u.created_at nulls last, p.id limit 1
) and not exists (select 1 from public.profiles where role = 'owner');
create unique index profiles_one_owner on public.profiles (role) where role = 'owner';

create function public.before_user_created_admin(event jsonb)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select case when (select invite_only from opengym_private.admin_settings)
    and not exists (
      select 1 from opengym_private.admin_invites i
      where i.code = upper(btrim(event #>> '{user,user_metadata,invite}'))
        and i.used_by is null and (i.expires is null or i.expires > now())
    )
    then '{"error":{"http_code":403,"message":"a valid invite code is required"}}'::jsonb
    else '{}'::jsonb end;
$$;

create function public.signup_config()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('invite_only', invite_only) from opengym_private.admin_settings;
$$;

-- Auth mutations run outside Postgres. Keep role changes away from their target until they finish.
create table opengym_private.admin_auth_actions (
  target uuid primary key,
  ticket uuid not null default gen_random_uuid() unique,
  actor uuid not null,
  action text not null,
  target_name text not null,
  until timestamptz not null default (now() + interval '2 minutes')
);

-- An Auth ban and session revocation must apply to JWTs already issued to the browser.
create function public.opengym_session_active()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from auth.sessions s join auth.users u on u.id = s.user_id
    where s.id = (auth.jwt() ->> 'session_id')::uuid and s.user_id = auth.uid()
      and u.deleted_at is null and not coalesce(u.banned_until > now(), false)
      and not exists (
        select 1 from opengym_private.admin_auth_actions a
        where a.target = u.id and a.action = 'delete' and a.until > now()
      )
  );
$$;

create function public.opengym_check_request()
returns void
language plpgsql stable set search_path = ''
as $$
begin
  if current_user = 'authenticated' and not public.opengym_session_active() then
    raise sqlstate 'PT401' using message = 'not signed in';
  end if;
end;
$$;
alter role authenticator set pgrst.db_pre_request = 'public.opengym_check_request';
notify pgrst, 'reload config';

create policy opengym_live_storage_session on storage.objects
  as restrictive for all to authenticated
  using ((select public.opengym_session_active())) with check ((select public.opengym_session_active()));

create function opengym_private.require_admin(owner_only boolean default false)
returns uuid
language plpgsql stable set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  caller_role text;
begin
  if caller is null then raise sqlstate 'PT401' using message = 'not signed in'; end if;
  select p.role into caller_role from public.profiles p join auth.users u on u.id = p.id
  where p.id = caller and u.deleted_at is null and not coalesce(u.banned_until > now(), false);
  if caller_role is null or caller_role = 'user' then
    raise sqlstate 'PT403' using message = 'admin only';
  end if;
  if owner_only and caller_role <> 'owner' then
    raise sqlstate 'PT403' using message = 'owner only';
  end if;
  return caller;
end;
$$;

create view opengym_private.admin_members as
select p.id, p.name, p.role, u.email, u.created_at, u.banned_until > now() as banned,
  exists (select 1 from public.push_subscriptions sub where sub.user_id = p.id) as has_push,
  s.doc, coalesce(floor(extract(epoch from s.updated_at) * 1000)::bigint, 0) as last_sync,
  jsonb_build_object('id', p.id, 'name', p.name, 'created', u.created_at,
    'disabled', coalesce(u.banned_until > now(), false),
    'admin', p.role in ('admin', 'owner'), 'owner', p.role = 'owner', 'email', u.email,
    'password', coalesce(u.encrypted_password <> '', false),
    'invitedBy', (select i.code from opengym_private.admin_invites i where i.used_by = p.id),
    'resetUntil', case when u.recovery_token <> '' and u.recovery_sent_at + interval '1 hour' > now()
      then floor(extract(epoch from u.recovery_sent_at + interval '1 hour') * 1000)::bigint end
  ) as user_info
from public.profiles p join auth.users u on u.id = p.id
left join public.app_state s on s.user_id = p.id
where u.deleted_at is null;

create function public.admin_users()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare caller uuid := opengym_private.require_admin();
begin
  perform opengym_private.log_admin(caller, 'admin.data-view', detail => 'user list');
  return jsonb_build_object(
    'users', coalesce((select jsonb_agg((m.user_info - 'resetUntil') || jsonb_build_object(
      'workouts', w.total, 'lastWorkout', w.last, 'lastSync', nullif(m.last_sync, 0), 'hasPush', m.has_push, 'live', null
    ) order by m.created_at, m.id)
    from opengym_private.admin_members m
    cross join lateral (
      select count(*) as total, (array_agg(row ->> 'd' order by ord desc))[1] as last
      from opengym_private.records(m.doc -> 'workouts') with ordinality as w(row, ord)
    ) w), '[]'::jsonb),
    'invite_only', (select invite_only from opengym_private.admin_settings),
    'data_view', true, 'password_login', true,
    'now', floor(extract(epoch from now()) * 1000)::bigint
  );
end;
$$;

create function public.admin_user_data(uid uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := opengym_private.require_admin();
  m opengym_private.admin_members%rowtype;
  workouts jsonb;
  bodyweight jsonb;
  routines jsonb;
begin
  select * into m from opengym_private.admin_members where id = uid;
  if not found then raise sqlstate 'PT404' using message = 'no such user'; end if;
  select coalesce(jsonb_agg(row - 'media' order by ord desc), '[]'::jsonb)
    into workouts from opengym_private.records(m.doc -> 'workouts') with ordinality as w(row, ord);
  select coalesce(jsonb_agg(row order by ord), '[]'::jsonb)
    into bodyweight from opengym_private.records(m.doc -> 'bodyweight') with ordinality as w(row, ord);
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', row -> 'id', 'name', row -> 'name', 'emoji', row -> 'emoji',
    'count', (select count(*) from opengym_private.records(row -> 'ex'))
  ) order by ord), '[]'::jsonb)
    into routines from opengym_private.records(m.doc -> 'routines') with ordinality as w(row, ord);
  perform opengym_private.log_admin(caller, 'admin.data-view', uid);
  return jsonb_build_object('user', m.user_info || '{"recoveryUntil":null}'::jsonb,
    'unit', coalesce(m.doc ->> 'unit', 'kg'), 'lastSync', nullif(m.last_sync, 0),
    'hasPush', m.has_push, 'bytes', coalesce(octet_length(m.doc::text), 0), 'data_view', true,
    'counts', jsonb_build_object('workouts', jsonb_array_length(workouts), 'bodyweight', jsonb_array_length(bodyweight),
      'measurements', (select count(*) from opengym_private.records(m.doc -> 'measurements')), 'routines', jsonb_array_length(routines)),
    'workouts', workouts, 'bodyweight', bodyweight, 'routines', routines
  );
end;
$$;

create function opengym_private.check_admin_target_idle(uid uuid)
returns void
language plpgsql set search_path = ''
as $$
begin
  if exists (select 1 from opengym_private.admin_auth_actions where target = uid and until > now()) then
    raise sqlstate 'PT409' using message = 'another account change is in progress';
  end if;
end;
$$;

create function public.admin_set_role(uid uuid, role text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid;
  m opengym_private.admin_members%rowtype;
begin
  perform 1 from opengym_private.admin_settings for update;
  caller := opengym_private.require_admin(true);
  select * into m from opengym_private.admin_members where id = uid;
  if not found then raise sqlstate 'PT404' using message = 'no such user'; end if;
  if m.role = 'owner' then raise sqlstate 'PT400' using message = 'the owner stays an admin'; end if;
  if role is null or role not in ('admin', 'user') then
    raise sqlstate 'PT400' using message = 'choose admin or user';
  end if;
  if role = 'admin' and m.banned then raise sqlstate 'PT400' using message = 'enable the account first'; end if;
  perform opengym_private.check_admin_target_idle(uid);
  update public.profiles set role = admin_set_role.role where id = uid;
  perform opengym_private.log_admin(caller, case role when 'admin' then 'admin.role.grant' else 'admin.role.revoke' end, uid);
  return jsonb_build_object('ok', true, 'id', uid, 'admin', role = 'admin');
end;
$$;

create function public.admin_transfer_owner(uid uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid;
  m opengym_private.admin_members%rowtype;
begin
  perform 1 from opengym_private.admin_settings for update;
  caller := opengym_private.require_admin(true);
  select * into m from opengym_private.admin_members where id = uid;
  if not found then raise sqlstate 'PT404' using message = 'no such user'; end if;
  if uid = caller then raise sqlstate 'PT400' using message = 'you already are the owner'; end if;
  if m.role <> 'admin' or m.banned then raise sqlstate 'PT400' using message = 'make them an admin first'; end if;
  perform opengym_private.check_admin_target_idle(uid);
  update public.profiles set role = 'admin' where id = caller;
  update public.profiles set role = 'owner' where id = uid;
  perform opengym_private.log_admin(caller, 'admin.owner.transfer', uid);
  return jsonb_build_object('ok', true, 'id', uid);
end;
$$;

create function opengym_private.invite_info(i opengym_private.admin_invites)
returns jsonb
language sql stable set search_path = ''
as $$
  select jsonb_build_object('code', i.code, 'note', i.note, 'createdBy', i.created_by, 'created', i.created_at,
    'usedBy', i.used_by, 'usedAt', i.used_at, 'expires', i.expires,
    'usedByName', (select name from public.profiles where id = i.used_by));
$$;

create function public.admin_invites()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform opengym_private.require_admin();
  return jsonb_build_object('invite_only', (select invite_only from opengym_private.admin_settings),
    'invites', coalesce((select jsonb_agg(opengym_private.invite_info(i) order by i.created_at, i.code)
      from opengym_private.admin_invites i), '[]'::jsonb));
end;
$$;

create function public.admin_create_invite(note text default '')
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := opengym_private.require_admin();
  invite opengym_private.admin_invites%rowtype;
begin
  insert into opengym_private.admin_invites (note, created_by) values (left(coalesce(note, ''), 60), caller) returning * into invite;
  perform opengym_private.log_admin(caller, 'admin.invite.create');
  return jsonb_build_object('invite', opengym_private.invite_info(invite));
end;
$$;

create function public.admin_delete_invite(code text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := opengym_private.require_admin();
  invite opengym_private.admin_invites%rowtype;
begin
  select * into invite from opengym_private.admin_invites i where i.code = upper(btrim(admin_delete_invite.code)) for update;
  if not found then raise sqlstate 'PT404' using message = 'no such code'; end if;
  if invite.used_by is not null then raise sqlstate 'PT400' using message = 'already used, cannot revoke'; end if;
  delete from opengym_private.admin_invites i where i.code = invite.code;
  perform opengym_private.log_admin(caller, 'admin.invite.revoke');
  return '{"ok":true}'::jsonb;
end;
$$;

create function public.admin_set_invite_only(enabled boolean)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare caller uuid;
begin
  perform 1 from opengym_private.admin_settings for update;
  caller := opengym_private.require_admin(true);
  if enabled is null then raise sqlstate 'PT400' using message = 'invite_only must be true or false'; end if;
  update opengym_private.admin_settings set invite_only = enabled where singleton;
  perform opengym_private.log_admin(caller, 'admin.invite-only', detail => case when enabled then 'enabled' else 'disabled' end);
  return jsonb_build_object('ok', true, 'invite_only', enabled);
end;
$$;

create function public.admin_audit(page_limit int default 100, category text default '', before_id bigint default null)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  size int := greatest(1, least(200, coalesce(page_limit, 100)));
  result jsonb;
begin
  perform opengym_private.require_admin();
  with matching as (
    select * from opengym_private.admin_audit
    where coalesce(category, '') = '' or (category = 'fail' and not ok) or split_part(event, '.', 1) = category
  ), page as (
    select * from matching where before_id is null or id < before_id order by id desc limit size
  )
  select jsonb_build_object(
    'events', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'id', id, 'ts', floor(extract(epoch from at) * 1000)::bigint, 'ev', event, 'ok', ok,
      'uid', actor, 'name', actor_name, 'tgt', target, 'tname', target_name, 'msg', detail
    )) order by id desc) from page), '[]'::jsonb),
    'total', (select count(*) from matching),
    'nextBefore', (select case when count(*) = size then min(id) end from page),
    'enabled', true, 'ip_mode', 'off', 'retention', jsonb_build_object('max', 0, 'days', 0),
    'now', floor(extract(epoch from now()) * 1000)::bigint
  ) into result;
  return result;
end;
$$;

create function public.admin_clear_audit()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare caller uuid := opengym_private.require_admin(true);
begin
  delete from opengym_private.admin_audit where id > 0;
  perform opengym_private.log_admin(caller, 'admin.audit.clear');
  return '{"ok":true}'::jsonb;
end;
$$;

-- Only the Edge Function can pass a verified actor ID to this service-only RPC.
create function public.admin_begin_auth_action(actor_id uuid, uid uuid, action text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  caller_role text;
  m opengym_private.admin_members%rowtype;
  claim uuid;
begin
  perform 1 from opengym_private.admin_settings for update;
  select role into caller_role from opengym_private.admin_members where id = actor_id and banned is not true;
  if caller_role is null or caller_role = 'user' then raise sqlstate 'PT403' using message = 'admin only'; end if;
  select * into m from opengym_private.admin_members where id = uid;
  if not found then raise sqlstate 'PT404' using message = 'no such user'; end if;
  case action
    when 'disable', 'enable' then
      if m.role <> 'user' then raise sqlstate 'PT400' using message = 'cannot disable an admin'; end if;
    when 'delete' then
      if uid = actor_id then raise sqlstate 'PT400' using message = 'you cannot delete your own account'; end if;
      if m.role = 'owner' then raise sqlstate 'PT400' using message = 'hand over ownership before deleting the account'; end if;
      if m.role = 'admin' and caller_role <> 'owner' then
        perform opengym_private.log_admin(actor_id, 'admin.denied', uid, 'delete', false);
        return jsonb_build_object('denied', 'only the owner can delete an admin');
      end if;
    when 'password-reset' then
      if m.role <> 'user' then raise sqlstate 'PT400' using message = 'an admin sets their own password'; end if;
      if m.banned then raise sqlstate 'PT400' using message = 'enable the account first'; end if;
      if coalesce(m.email, '') = '' then raise sqlstate 'PT400' using message = 'this account has no sign-in e-mail'; end if;
    else raise sqlstate 'PT400' using message = 'invalid account change';
  end case;
  perform opengym_private.check_admin_target_idle(uid);
  delete from opengym_private.admin_auth_actions where until <= now();
  insert into opengym_private.admin_auth_actions (target, actor, action, target_name)
  values (uid, actor_id, action, m.name) returning ticket into claim;
  return jsonb_build_object('ticket', claim, 'email', m.email, 'name', m.name,
    'media', case when action = 'delete' then coalesce((
      select jsonb_agg(o.name order by o.name) from storage.objects o
      where o.bucket_id = 'media' and o.name like uid::text || '/%'
    ), '[]'::jsonb) end);
end;
$$;

create function public.admin_finish_auth_action(claim uuid, succeeded boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
declare job opengym_private.admin_auth_actions%rowtype;
begin
  delete from opengym_private.admin_auth_actions where ticket = claim returning * into job;
  if not found then return; end if;
  if succeeded and job.action = 'disable' then
    delete from auth.sessions where user_id = job.target;
  end if;
  insert into opengym_private.admin_audit (actor, event, target, actor_name, target_name, ok)
  values (job.actor,
    case job.action when 'password-reset' then 'admin.password.reset' else 'admin.user.' || job.action end,
    job.target, (select left(name, 40) from public.profiles where id = job.actor), left(job.target_name, 40), succeeded);
end;
$$;

revoke all on opengym_private.admin_settings, opengym_private.admin_invites, opengym_private.admin_audit,
  opengym_private.admin_members, opengym_private.admin_auth_actions from public, anon, authenticated, service_role;
revoke all on function opengym_private.create_profile(), opengym_private.log_admin(uuid, text, uuid, text, boolean),
  opengym_private.require_admin(boolean), opengym_private.check_admin_target_idle(uuid),
  opengym_private.invite_info(opengym_private.admin_invites) from public, anon, authenticated, service_role;

revoke all on function public.admin_users(), public.admin_user_data(uuid), public.admin_set_role(uuid, text),
  public.admin_transfer_owner(uuid), public.admin_invites(), public.admin_create_invite(text), public.admin_delete_invite(text),
  public.admin_set_invite_only(boolean), public.admin_audit(int, text, bigint), public.admin_clear_audit(),
  public.admin_begin_auth_action(uuid, uuid, text), public.admin_finish_auth_action(uuid, boolean),
  public.before_user_created_admin(jsonb), public.signup_config(), public.opengym_session_active(), public.opengym_check_request()
  from public, anon, authenticated, service_role, supabase_auth_admin;

grant execute on function public.admin_users(), public.admin_user_data(uuid), public.admin_set_role(uuid, text),
  public.admin_transfer_owner(uuid), public.admin_invites(), public.admin_create_invite(text), public.admin_delete_invite(text),
  public.admin_set_invite_only(boolean), public.admin_audit(int, text, bigint), public.admin_clear_audit(),
  public.opengym_session_active() to authenticated;
grant execute on function public.signup_config() to anon, authenticated;
grant execute on function public.opengym_check_request() to anon, authenticated, service_role;
grant execute on function public.before_user_created_admin(jsonb) to supabase_auth_admin;
grant execute on function public.admin_begin_auth_action(uuid, uuid, text), public.admin_finish_auth_action(uuid, boolean) to service_role;
