-- Optional demo sign-in: creates the shared Demo Admin profile the first time it is used.
-- The API sets this fixed identity only for its own signed demo sessions; the all-zero tenant never
-- appears in a verified Microsoft token. An existing profile is left unchanged, so a Super Admin can
-- disable Demo Admin to turn demo access off. No rows are added by this migration.
create function caseflow.ensure_demo_admin() returns caseflow.users
language plpgsql security definer set search_path = '' as $$
declare created caseflow.users;
begin
  if current_setting('caseflow.tenant_id', true) is distinct from '00000000-0000-0000-0000-000000000000'
    or current_setting('caseflow.subject', true) is distinct from 'caseflow-demo-admin' then
    raise exception 'FORBIDDEN';
  end if;
  -- Serialize with other permission writes (see users_permissions.sql).
  perform pg_advisory_xact_lock(734921, 1);
  insert into caseflow.users (tenant_id, subject, display_name, role)
  values ('00000000-0000-0000-0000-000000000000', 'caseflow-demo-admin', 'Demo Admin', 'admin')
  on conflict (tenant_id, subject) do nothing
  returning * into created;
  if created.id is not null then
    insert into caseflow.audit_events (operator_name, target_id, action, before_value, after_value)
    values ('Demo setup', created.id, 'user.role_changed',
      jsonb_build_object('role', 'staff', 'active', true),
      jsonb_build_object('role', 'admin', 'active', true));
  end if;
  return caseflow.require_actor();
end $$;
revoke all on function caseflow.ensure_demo_admin() from public;
grant execute on function caseflow.ensure_demo_admin() to caseflow_runtime;
