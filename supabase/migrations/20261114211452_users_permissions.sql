-- Private application schema: never add it to Supabase's exposed schemas.
create schema caseflow;
revoke all on schema caseflow from public, anon, authenticated, service_role;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'caseflow_runtime') then
    create role caseflow_runtime login nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
end $$;
grant usage on schema caseflow to caseflow_runtime;
alter default privileges in schema caseflow revoke execute on functions from public;

create table caseflow.users (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  subject text not null check (length(subject) between 1 and 512),
  display_name text not null check (length(btrim(display_name)) between 1 and 100),
  role text not null default 'staff' check (role in ('staff', 'admin', 'super_admin')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, subject)
);
create table caseflow.cases (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  summary text not null,
  created_at timestamptz not null default now()
);
create table caseflow.assignments (
  case_id uuid not null references caseflow.cases(id),
  user_id uuid not null references caseflow.users(id),
  primary key (case_id, user_id)
);
create index assignments_user_case on caseflow.assignments(user_id, case_id);
create table caseflow.audit_events (
  id bigint generated always as identity primary key,
  actor_id uuid references caseflow.users(id),
  operator_name text,
  target_id uuid not null,
  action text not null,
  before_value jsonb,
  after_value jsonb,
  created_at timestamptz not null default clock_timestamp(),
  check (actor_id is not null or operator_name is not null)
);
create index audit_newest on caseflow.audit_events(created_at desc, id desc);

-- These narrowly scoped functions run as the migration owner. This is intentional:
-- the runtime role cannot write tables, change roles, or edit audit history directly.
-- Identity settings are supplied only by the API after Microsoft token verification.
-- Each function has a fixed empty search_path; PUBLIC has no execution privileges.
create function caseflow.actor() returns caseflow.users
language sql stable security definer set search_path = '' as $$
  select u from caseflow.users u
  where u.tenant_id = nullif(current_setting('caseflow.tenant_id', true), '')::uuid
    and u.subject = nullif(current_setting('caseflow.subject', true), '');
$$;
create function caseflow.require_actor() returns caseflow.users
language plpgsql security definer set search_path = '' as $$
declare a caseflow.users;
begin
  a := caseflow.actor();
  if a.id is null then raise exception 'UNAUTHENTICATED'; end if;
  if not a.active then raise exception 'ACCOUNT_DISABLED'; end if;
  return a;
end $$;
create function caseflow.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((caseflow.actor()).active and (caseflow.actor()).role in ('admin','super_admin'), false);
$$;

alter table caseflow.users enable row level security;
alter table caseflow.cases enable row level security;
alter table caseflow.assignments enable row level security;
alter table caseflow.audit_events enable row level security;
create policy read_users on caseflow.users for select to caseflow_runtime
using ((caseflow.actor()).active and (id = (caseflow.actor()).id or caseflow.is_admin()));
create policy read_assignments on caseflow.assignments for select to caseflow_runtime
using ((caseflow.actor()).active and (user_id = (caseflow.actor()).id or caseflow.is_admin()));
create policy read_cases on caseflow.cases for select to caseflow_runtime
using ((caseflow.actor()).active and (caseflow.is_admin() or exists (
  select 1 from caseflow.assignments a where a.case_id = cases.id and a.user_id = (caseflow.actor()).id
)));
create policy read_audit on caseflow.audit_events for select to caseflow_runtime using (caseflow.is_admin());
grant select on all tables in schema caseflow to caseflow_runtime;

create function caseflow.provision(p_name text) returns caseflow.users
language plpgsql security definer set search_path = '' as $$
declare a caseflow.users;
begin
  if nullif(current_setting('caseflow.tenant_id', true), '') is null
    or nullif(current_setting('caseflow.subject', true), '') is null then
    raise exception 'UNAUTHENTICATED';
  end if;
  insert into caseflow.users(tenant_id, subject, display_name)
  values (current_setting('caseflow.tenant_id')::uuid, current_setting('caseflow.subject'),
    coalesce(nullif(left(btrim(p_name),100), ''), 'CaseFlow user'))
  on conflict (tenant_id, subject) do nothing;
  a := caseflow.require_actor();
  return a;
end $$;

-- Permission writes share one transaction lock. This deliberately serializes the
-- small demo's administration workload, including operator commands, so role checks
-- cannot race with a demotion or disable. Reads stay concurrent. Revisit for scale.
create function caseflow.update_profile(p_name text) returns caseflow.users
language plpgsql security definer set search_path = '' as $$
declare a caseflow.users;
begin
  perform pg_advisory_xact_lock(734921, 1);
  a := caseflow.require_actor();
  if length(btrim(p_name)) not between 1 and 100 or p_name is null then raise exception 'INVALID_INPUT'; end if;
  if a.display_name is distinct from btrim(p_name) then
    update caseflow.users set display_name = btrim(p_name) where id = a.id;
    insert into caseflow.audit_events(actor_id,target_id,action,before_value,after_value)
    values (a.id,a.id,'profile.updated',jsonb_build_object('displayName',a.display_name),jsonb_build_object('displayName',btrim(p_name)));
  end if;
  return caseflow.require_actor();
end $$;

create function caseflow.manage_user(p_id uuid, p_role text, p_active boolean) returns caseflow.users
language plpgsql security definer set search_path = '' as $$
declare a caseflow.users; t caseflow.users; updated caseflow.users;
begin
  perform pg_advisory_xact_lock(734921, 1);
  a := caseflow.require_actor();
  if a.role not in ('admin','super_admin') then raise exception 'FORBIDDEN'; end if;
  select * into t from caseflow.users where id = p_id for update;
  if t.id is null then raise exception 'NOT_FOUND'; end if;
  if t.role = 'super_admin' or a.id = t.id then raise exception 'FORBIDDEN'; end if;
  if (p_role is null) = (p_active is null) then raise exception 'INVALID_INPUT'; end if;
  if p_role is not null and (a.role <> 'super_admin' or p_role not in ('staff','admin')) then raise exception 'FORBIDDEN'; end if;
  if p_active is not null and t.role = 'admin' and a.role <> 'super_admin' then raise exception 'FORBIDDEN'; end if;
  update caseflow.users set role = coalesce(p_role,role), active = coalesce(p_active,active)
    where id = p_id returning * into updated;
  if (t.role,t.active) is distinct from (updated.role,updated.active) then
    insert into caseflow.audit_events(actor_id,target_id,action,before_value,after_value)
    values (a.id,t.id,case when p_role is null then 'user.access_changed' else 'user.role_changed' end,
      jsonb_build_object('role',t.role,'active',t.active),jsonb_build_object('role',updated.role,'active',updated.active));
  end if;
  return updated;
end $$;

create function caseflow.set_assignment(p_case uuid,p_user uuid,p_assigned boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare a caseflow.users; t caseflow.users; changed integer;
begin
  perform pg_advisory_xact_lock(734921, 1);
  a := caseflow.require_actor();
  if a.role not in ('admin','super_admin') then raise exception 'FORBIDDEN'; end if;
  select * into t from caseflow.users where id = p_user;
  if t.id is null or not exists(select 1 from caseflow.cases where id = p_case) then raise exception 'NOT_FOUND'; end if;
  if t.role <> 'staff' then raise exception 'FORBIDDEN'; end if;
  if p_assigned is null or (p_assigned and not t.active) then raise exception 'INVALID_INPUT'; end if;
  if p_assigned then
    insert into caseflow.assignments values(p_case,p_user) on conflict do nothing;
  else
    delete from caseflow.assignments where case_id = p_case and user_id = p_user;
  end if;
  get diagnostics changed = row_count;
  if changed > 0 then
    insert into caseflow.audit_events(actor_id,target_id,action,before_value,after_value)
    values (a.id,p_case,'case.assignment_changed',jsonb_build_object('userId',p_user,'assigned',not p_assigned),
      jsonb_build_object('userId',p_user,'assigned',p_assigned));
  end if;
end $$;

-- Operator only; no EXECUTE grant to the web API's runtime database role.
create function caseflow.operator_set_role(p_id uuid,p_role text) returns void
language plpgsql security definer set search_path = '' as $$
declare t caseflow.users;
begin
  perform pg_advisory_xact_lock(734921, 1);
  select * into t from caseflow.users where id=p_id for update;
  if t.id is null then raise exception 'NOT_FOUND'; end if;
  if p_role is null or p_role not in ('staff','admin','super_admin') then raise exception 'INVALID_INPUT'; end if;
  if not t.active then raise exception 'ACCOUNT_DISABLED'; end if;
  if t.role = 'super_admin' and p_role <> 'super_admin' and
    (select count(*) from caseflow.users where active and role='super_admin') <= 1 then
    raise exception 'LAST_SUPER_ADMIN';
  end if;
  if t.role <> p_role then
    update caseflow.users set role=p_role where id=p_id;
    insert into caseflow.audit_events(operator_name,target_id,action,before_value,after_value)
    values (session_user,p_id,'operator.role_changed',jsonb_build_object('role',t.role),jsonb_build_object('role',p_role));
  end if;
end $$;
revoke all on all functions in schema caseflow from public,anon,authenticated,service_role;
grant execute on function caseflow.actor(),caseflow.require_actor(),caseflow.is_admin(),caseflow.provision(text),
  caseflow.update_profile(text),caseflow.manage_user(uuid,text,boolean),caseflow.set_assignment(uuid,uuid,boolean)
  to caseflow_runtime;
