alter table caseflow.cases
  add column version integer not null default 1 check (version > 0),
  add column updated_at timestamptz,
  add column archived_at timestamptz,
  add column archived_by uuid references caseflow.users(id),
  add constraint cases_archive_metadata check ((archived_at is null) = (archived_by is null));

update caseflow.cases set updated_at = created_at;
alter table caseflow.cases alter column updated_at set not null,
  alter column updated_at set default now();

create index cases_current_newest on caseflow.cases(created_at desc, id desc)
  where archived_at is null;
create index cases_archived_newest on caseflow.cases(created_at desc, id desc)
  where archived_at is not null;
create index cases_archived_by on caseflow.cases(archived_by) where archived_by is not null;

create function caseflow.update_case(p_id uuid, p_expected_version integer, p_patch jsonb)
returns caseflow.cases
language plpgsql security definer set search_path = '' as $$
declare
  actor caseflow.users;
  previous caseflow.cases;
  changed caseflow.cases;
  field text;
  before_data jsonb;
  after_data jsonb;
begin
  perform pg_advisory_xact_lock(734921, 1);
  actor := caseflow.require_actor();
  if actor.role not in ('admin', 'super_admin') then
    raise exception 'FORBIDDEN';
  end if;

  if p_expected_version is null or p_expected_version < 1 or p_patch is null
    or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'INVALID_INPUT';
  end if;

  select * into previous from caseflow.cases where id = p_id for update;
  if not found then
    raise exception 'NOT_FOUND';
  end if;
  if previous.version <> p_expected_version then
    raise exception 'CASE_CONFLICT';
  end if;
  if previous.archived_at is not null then
    raise exception 'CASE_ARCHIVED';
  end if;

  for field in select jsonb_object_keys(p_patch) loop
    if field not in ('title', 'clientName', 'incidentDate', 'status', 'summary') then
      raise exception 'INVALID_INPUT';
    end if;
    if jsonb_typeof(p_patch -> field) <> 'string'
      and not (field = 'incidentDate' and p_patch -> field = 'null'::jsonb) then
      raise exception 'INVALID_INPUT';
    end if;
  end loop;

  changed := previous;
  if p_patch ? 'title' then changed.title := btrim(p_patch ->> 'title'); end if;
  if p_patch ? 'clientName' then changed.client_name := btrim(p_patch ->> 'clientName'); end if;
  if p_patch ? 'status' then changed.status := p_patch ->> 'status'; end if;
  if p_patch ? 'summary' then changed.summary := btrim(p_patch ->> 'summary'); end if;
  if p_patch ? 'incidentDate' then
    if p_patch ->> 'incidentDate' is not null
      and (p_patch ->> 'incidentDate') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      raise exception 'INVALID_INPUT';
    end if;
    begin
      changed.incident_date := (p_patch ->> 'incidentDate')::date;
    exception when invalid_datetime_format or datetime_field_overflow then
      raise exception 'INVALID_INPUT';
    end;
  end if;

  if length(changed.title) not between 1 and 200
    or length(changed.client_name) not between 1 and 100
    or changed.status not in ('intake', 'active', 'closed')
    or length(changed.summary) > 2000
    or (changed.incident_date is not null and
      changed.incident_date not between date '0001-01-01' and date '9999-12-31') then
    raise exception 'INVALID_INPUT';
  end if;

  before_data := jsonb_build_object('title', previous.title, 'clientName', previous.client_name,
    'incidentDate', previous.incident_date, 'status', previous.status, 'summary', previous.summary);
  after_data := jsonb_build_object('title', changed.title, 'clientName', changed.client_name,
    'incidentDate', changed.incident_date, 'status', changed.status, 'summary', changed.summary);
  if before_data = after_data then
    return previous;
  end if;

  update caseflow.cases set title = changed.title, client_name = changed.client_name,
    incident_date = changed.incident_date, status = changed.status, summary = changed.summary,
    version = previous.version + 1, updated_at = clock_timestamp()
    where id = p_id returning * into changed;
  insert into caseflow.audit_events(actor_id, target_id, action, before_value, after_value)
    values (actor.id, p_id, 'case.updated',
      before_data || jsonb_build_object('version', previous.version),
      after_data || jsonb_build_object('version', changed.version));
  return changed;
end;
$$;

create function caseflow.set_case_archived(p_id uuid, p_expected_version integer, p_archived boolean)
returns caseflow.cases
language plpgsql security definer set search_path = '' as $$
declare
  actor caseflow.users;
  previous caseflow.cases;
  changed caseflow.cases;
begin
  perform pg_advisory_xact_lock(734921, 1);
  actor := caseflow.require_actor();
  if actor.role not in ('admin', 'super_admin') then
    raise exception 'FORBIDDEN';
  end if;
  if p_expected_version is null or p_expected_version < 1 or p_archived is null then
    raise exception 'INVALID_INPUT';
  end if;

  select * into previous from caseflow.cases where id = p_id for update;
  if not found then
    raise exception 'NOT_FOUND';
  end if;
  if previous.version <> p_expected_version then
    raise exception 'CASE_CONFLICT';
  end if;
  if (previous.archived_at is not null) = p_archived then
    return previous;
  end if;

  update caseflow.cases set
    archived_at = case when p_archived then clock_timestamp() else null end,
    archived_by = case when p_archived then actor.id else null end,
    version = previous.version + 1, updated_at = clock_timestamp()
    where id = p_id returning * into changed;
  insert into caseflow.audit_events(actor_id, target_id, action, before_value, after_value)
    values (actor.id, p_id, case when p_archived then 'case.archived' else 'case.restored' end,
      jsonb_build_object('archivedAt', previous.archived_at, 'archivedBy', previous.archived_by,
        'version', previous.version),
      jsonb_build_object('archivedAt', changed.archived_at, 'archivedBy', changed.archived_by,
        'version', changed.version));
  return changed;
end;
$$;

revoke all on function caseflow.update_case(uuid, integer, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function caseflow.set_case_archived(uuid, integer, boolean)
  from public, anon, authenticated, service_role;
grant execute on function caseflow.update_case(uuid, integer, jsonb) to caseflow_runtime;
grant execute on function caseflow.set_case_archived(uuid, integer, boolean) to caseflow_runtime;
