-- Run against the local stack with psql -v ON_ERROR_STOP=1 -f admin.sql.
-- All fixtures and the temporary ownership change are rolled back.
begin;

update opengym_private.admin_settings set invite_only = false where singleton;

insert into auth.users (id, email, raw_user_meta_data)
values
  ('00000000-0000-4000-8000-000000000011', 'admin-owner@example.test', '{"name":"Test owner"}'),
  ('00000000-0000-4000-8000-000000000012', 'admin-staff@example.test', '{"name":"Test admin"}'),
  ('00000000-0000-4000-8000-000000000013', 'admin-member@example.test', '{"name":"Test member"}');

update public.profiles set role = 'admin' where role = 'owner';
update public.profiles set role = 'owner' where id = '00000000-0000-4000-8000-000000000011';
update public.profiles set role = 'admin' where id = '00000000-0000-4000-8000-000000000012';

insert into public.app_state (user_id, doc, rev, wid)
values ('00000000-0000-4000-8000-000000000013',
  '{"workouts":[null,{"id":"workout","d":"2026-11-23","media":["private"],"entries":[]}],"bodyweight":[{"d":"2026-11-23","w":70}],"routines":[{"id":"routine","name":"Test","ex":[{}]}]}',
  1, 'admin-test');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000013', true);
do $$
begin
  begin
    perform public.admin_users();
    raise exception 'a member read the admin list';
  exception when sqlstate 'PT403' then null;
  end;
  begin
    update public.profiles set role = 'admin' where id = auth.uid();
    raise exception 'a member wrote their own role';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.admin_begin_auth_action(auth.uid(), auth.uid(), 'delete');
    raise exception 'a member called the service RPC';
  exception when insufficient_privilege then null;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000012', true);
do $$
declare
  info jsonb;
begin
  begin
    perform public.admin_set_role('00000000-0000-4000-8000-000000000013', 'admin');
    raise exception 'a regular admin promoted a member';
  exception when sqlstate 'PT403' then null;
  end;
  begin
    perform public.admin_clear_audit();
    raise exception 'a regular admin cleared the audit log';
  exception when sqlstate 'PT403' then null;
  end;
  info := public.admin_user_data('00000000-0000-4000-8000-000000000013');
  if info #>> '{counts,workouts}' is distinct from '1'
     or info #>> '{routines,0,count}' is distinct from '1'
     or info #> '{workouts,0,media}' is not null then
    raise exception 'wrong detail or private media returned';
  end if;
  if public.admin_users() #>> '{data_view}' is distinct from 'true' then
    raise exception 'admin user list is missing its data view flag';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000011', true);
do $$
begin
  begin
    perform public.admin_set_role(auth.uid(), 'user');
    raise exception 'the last owner was demoted';
  exception when sqlstate 'PT400' then null;
  end;
end;
$$;
select public.admin_transfer_owner('00000000-0000-4000-8000-000000000012');
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000012', true);
select public.admin_set_role('00000000-0000-4000-8000-000000000013', 'admin');
select public.admin_set_role('00000000-0000-4000-8000-000000000013', 'user');
select set_config('opengym.test.invite', public.admin_create_invite('Test') #>> '{invite,code}', true) is not null;
select public.admin_set_invite_only(true);

reset role;
do $$
declare
  event jsonb := jsonb_build_object('user', jsonb_build_object('user_metadata',
    jsonb_build_object('invite', lower(current_setting('opengym.test.invite')))));
begin
  if not has_function_privilege('supabase_auth_admin', 'public.before_user_created_admin(jsonb)', 'EXECUTE') then
    raise exception 'Auth has no permission to call the signup hook';
  end if;
  if public.before_user_created_admin('{}') #>> '{error,http_code}' is distinct from '403' then
    raise exception 'missing invite was accepted';
  end if;
  if public.before_user_created_admin(event) is distinct from '{}'::jsonb then
    raise exception 'valid invite was rejected';
  end if;
end;
$$;

reset role;
insert into auth.users (id, email, raw_user_meta_data)
values ('00000000-0000-4000-8000-000000000014', 'admin-invite@example.test',
  jsonb_build_object('name', 'Test invite', 'invite', current_setting('opengym.test.invite')));

do $$
declare
  event jsonb := jsonb_build_object('user', jsonb_build_object('user_metadata',
    jsonb_build_object('invite', current_setting('opengym.test.invite'))));
begin
  if public.before_user_created_admin(event) #>> '{error,http_code}' is distinct from '403' then
    raise exception 'used invite was accepted';
  end if;
  begin
    insert into auth.users (id, email, raw_user_meta_data)
    values ('00000000-0000-4000-8000-000000000015', 'admin-reused@example.test', event #> '{user,user_metadata}');
    raise exception 'signup trigger reused the invite';
  exception when raise_exception then
    if sqlerrm <> 'a valid invite code is required' then raise; end if;
  end;
end;
$$;

reset role;
set local role anon;
do $$
begin
  if public.signup_config() #>> '{invite_only}' is distinct from 'true' then
    raise exception 'invite-only is missing from public config';
  end if;
  begin
    perform public.admin_invites();
    raise exception 'an anonymous caller read the invites';
  exception when insufficient_privilege then null;
  end;
end;
$$;

reset role;
set local role service_role;
do $$
declare
  owner_id uuid := '00000000-0000-4000-8000-000000000012';
  member_id uuid := '00000000-0000-4000-8000-000000000013';
  job jsonb;
begin
  begin
    perform public.admin_begin_auth_action(member_id, owner_id, 'disable');
    raise exception 'the service RPC authorized a member';
  exception when sqlstate 'PT403' then null;
  end;
  begin
    perform public.admin_begin_auth_action(owner_id, owner_id, 'delete');
    raise exception 'the service RPC authorized deleting the owner';
  exception when sqlstate 'PT400' then null;
  end;
  job := public.admin_begin_auth_action(owner_id, member_id, 'disable');
  perform public.admin_finish_auth_action((job ->> 'ticket')::uuid, true);
end;
$$;

reset role;
set local role authenticated;
do $$
declare page jsonb := public.admin_audit(200, 'admin');
begin
  if not (page -> 'events' @> '[{"ev":"admin.data-view"},{"ev":"admin.owner.transfer"},
    {"ev":"admin.role.grant"},{"ev":"admin.role.revoke"},{"ev":"admin.invite.create"},{"ev":"admin.user.disable","ok":true}]') then
    raise exception 'admin audit events are missing';
  end if;
  if not (public.admin_invites() -> 'invites' @> '[{"usedBy":"00000000-0000-4000-8000-000000000014"}]') then
    raise exception 'the invite was not consumed';
  end if;
  perform public.admin_clear_audit();
  if public.admin_audit(200, 'admin') #>> '{events,0,ev}' is distinct from 'admin.audit.clear' then
    raise exception 'clearing the audit log was not recorded';
  end if;
end;
$$;

reset role;
update opengym_private.admin_settings set invite_only = false where singleton;
update public.profiles set role = 'admin' where id = '00000000-0000-4000-8000-000000000012';
insert into auth.users (id, email)
values ('00000000-0000-4000-8000-000000000016', 'admin-first@example.test');
do $$
begin
  if (select role from public.profiles where id = '00000000-0000-4000-8000-000000000016') is distinct from 'owner' then
    raise exception 'the first eligible profile was not made owner';
  end if;
end;
$$;

rollback;
