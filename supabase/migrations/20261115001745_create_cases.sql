alter table caseflow.cases
  add column case_sequence bigint generated always as identity,
  add column case_number text generated always as
    ('CF-' || lpad(case_sequence::text, greatest(6, length(case_sequence::text)), '0')) stored,
  add column client_name text,
  add column incident_date date,
  add column status text not null default 'intake',
  add column created_by uuid references caseflow.users(id);

update caseflow.cases set
  client_name = case id
    when '10000000-0000-4000-8000-000000000001' then 'Jordan Ellis'
    when '10000000-0000-4000-8000-000000000002' then 'Morgan Reed'
    when '10000000-0000-4000-8000-000000000003' then 'Taylor Brooks'
    else 'Fictional client'
  end,
  incident_date = case id
    when '10000000-0000-4000-8000-000000000001' then date '2026-08-12'
    when '10000000-0000-4000-8000-000000000002' then date '2026-09-03'
    when '10000000-0000-4000-8000-000000000003' then date '2026-10-18'
  end;

alter table caseflow.cases
  alter column client_name set not null,
  alter column case_number set not null,
  alter column summary set default '',
  add constraint cases_number_unique unique (case_number),
  add constraint cases_title_length check (length(btrim(title)) between 1 and 200),
  add constraint cases_client_name_length check (length(btrim(client_name)) between 1 and 100),
  add constraint cases_summary_length check (length(summary) <= 2000),
  add constraint cases_status check (status in ('intake', 'active', 'closed')),
  add constraint cases_incident_date check (incident_date between date '0001-01-01' and date '9999-12-31');

create index cases_newest on caseflow.cases(created_at desc, id desc);
create index cases_status_newest on caseflow.cases(status, created_at desc, id desc);
create index cases_creator on caseflow.cases(created_by);

create function caseflow.create_case(
  p_title text, p_client_name text, p_incident_date date, p_status text, p_summary text
) returns caseflow.cases
language plpgsql security definer set search_path = '' as $$
declare
  actor caseflow.users;
  created caseflow.cases;
begin
  perform pg_advisory_xact_lock(734921, 1);
  actor := caseflow.require_actor();

  if actor.role not in ('admin', 'super_admin') then
    raise exception 'FORBIDDEN';
  end if;

  if p_title is null or length(btrim(p_title)) not between 1 and 200
    or p_client_name is null or length(btrim(p_client_name)) not between 1 and 100
    or p_status is null or p_status not in ('intake', 'active', 'closed')
    or p_summary is null or length(btrim(p_summary)) > 2000
    or (p_incident_date is not null and
        p_incident_date not between date '0001-01-01' and date '9999-12-31') then
    raise exception 'INVALID_INPUT';
  end if;

  insert into caseflow.cases(title, client_name, incident_date, status, summary, created_by)
  values (btrim(p_title), btrim(p_client_name), p_incident_date, p_status, btrim(p_summary), actor.id)
  returning * into created;

  insert into caseflow.audit_events(actor_id, target_id, action, after_value)
  values (actor.id, created.id, 'case.created', jsonb_build_object(
    'caseNumber', created.case_number,
    'title', created.title,
    'clientName', created.client_name,
    'incidentDate', created.incident_date,
    'status', created.status,
    'summary', created.summary
  ));

  return created;
end;
$$;

revoke all on function caseflow.create_case(text, text, date, text, text)
  from public, anon, authenticated, service_role;
grant execute on function caseflow.create_case(text, text, date, text, text) to caseflow_runtime;
