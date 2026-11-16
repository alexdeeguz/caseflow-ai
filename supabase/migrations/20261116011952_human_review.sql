-- Original extraction and citations remain immutable; reviews version the effective values.
create function caseflow.fact_original_values(f caseflow.extracted_facts)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object('category', f.category, 'value', f.value, 'qualifier', f.qualifier,
    'dateValue', f.date_value, 'datePrecision', f.date_precision, 'dateMeaning', f.date_meaning,
    'treatmentStatus', f.treatment_status, 'findingStatus', f.finding_status, 'negated', f.negated);
$$;

create function caseflow.valid_fact_values(v jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare
  category text := v->>'category';
  date_value text := v->>'dateValue';
  precision text := v->>'datePrecision';
  padded text;
  field text;
begin
  if v is null or jsonb_typeof(v) <> 'object'
    or not (v ?& array['category','value','qualifier','dateValue','datePrecision','dateMeaning',
      'treatmentStatus','findingStatus','negated'])
    or (select count(*) from jsonb_object_keys(v)) <> 9
    or category is null or category not in ('date','provider','treatment','finding')
    or jsonb_typeof(v->'negated') <> 'boolean'
    or jsonb_typeof(v->'value') <> 'string'
    or length(v->>'value') = 0 or length(v->>'value') > 1000 then
    return false;
  end if;
  foreach field in array array['qualifier','dateMeaning'] loop
    if v->field <> 'null'::jsonb and (jsonb_typeof(v->field) <> 'string'
      or length(v->>field) = 0
      or length(v->>field) > case when field = 'dateMeaning' then 200 else 1000 end) then
      return false;
    end if;
  end loop;
  if category = 'date' then
    if date_value is null or precision is null or v->>'dateMeaning' is null
      or jsonb_typeof(v->'dateValue') <> 'string'
      or precision not in ('year','month','day')
      or date_value !~ '^[0-9]{4}(-[0-9]{2}(-[0-9]{2})?)?$'
      or length(date_value) <> (case precision when 'year' then 4 when 'month' then 7 else 10 end)
      or left(date_value,4) = '0000' then return false; end if;
    padded := left(date_value || '-01-01',10);
    if to_char(padded::date, 'YYYY-MM-DD') <> padded then return false; end if;
  elsif v->'dateValue' <> 'null'::jsonb or v->'datePrecision' <> 'null'::jsonb
    or v->'dateMeaning' <> 'null'::jsonb then
    return false;
  end if;
  if category = 'treatment' then
    if coalesce(v->>'treatmentStatus','') not in ('recommended','performed','unspecified') then return false; end if;
  elsif v->'treatmentStatus' <> 'null'::jsonb then return false; end if;
  if category = 'finding' then
    if coalesce(v->>'findingStatus','') not in ('suspected','confirmed','unspecified') then return false; end if;
  elsif v->'findingStatus' <> 'null'::jsonb then return false; end if;
  return true;
exception when invalid_datetime_format or datetime_field_overflow then
  return false;
end;
$$;

create table caseflow.fact_reviews (
  fact_id uuid primary key references caseflow.extracted_facts(id),
  version integer not null default 1 check (version > 0),
  status text not null default 'unreviewed' check (status in ('unreviewed','approved','rejected')),
  values jsonb not null check (caseflow.valid_fact_values(values)),
  reviewed_by uuid references caseflow.users(id),
  reviewed_at timestamptz,
  check ((version = 1 and status = 'unreviewed' and reviewed_by is null and reviewed_at is null)
    or (version > 1 and reviewed_by is not null and reviewed_at is not null))
);
create index fact_reviews_status on caseflow.fact_reviews(status, fact_id);
create index fact_reviews_reviewer on caseflow.fact_reviews(reviewed_by);

create table caseflow.fact_review_revisions (
  fact_id uuid not null references caseflow.fact_reviews(fact_id),
  version integer not null check (version > 1),
  action text not null check (action in ('correct','approve','reject','reopen')),
  status text not null check (status in ('unreviewed','approved','rejected')),
  values jsonb not null check (caseflow.valid_fact_values(values)),
  reason text check (length(btrim(reason)) between 1 and 1000),
  actor_id uuid not null references caseflow.users(id),
  created_at timestamptz not null default now(),
  primary key (fact_id, version),
  check ((action = 'approve' and status = 'approved' and reason is null)
    or (action = 'reject' and status = 'rejected' and reason is not null)
    or (action in ('correct','reopen') and status = 'unreviewed' and reason is not null))
);
create index fact_review_revisions_actor on caseflow.fact_review_revisions(actor_id);

insert into caseflow.fact_reviews(fact_id, values)
  select f.id, caseflow.fact_original_values(f) from caseflow.extracted_facts f;

create function caseflow.initialize_fact_review()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into caseflow.fact_reviews(fact_id, values) values (new.id, caseflow.fact_original_values(new));
  return new;
end;
$$;
create trigger initialize_fact_review after insert on caseflow.extracted_facts
for each row execute function caseflow.initialize_fact_review();

alter table caseflow.fact_reviews enable row level security;
alter table caseflow.fact_review_revisions enable row level security;
create policy read_fact_reviews on caseflow.fact_reviews for select to caseflow_runtime
  using (exists(select 1 from caseflow.extracted_facts f where f.id = fact_id));
create policy read_fact_review_revisions on caseflow.fact_review_revisions for select to caseflow_runtime
  using (exists(select 1 from caseflow.extracted_facts f where f.id = fact_id));

-- Future consumers must use the current approved revision under the caller's RLS context.
create view caseflow.approved_facts with (security_invoker = true) as
  select f.id, f.extraction_job_id, r.version, r.values
  from caseflow.extracted_facts f join caseflow.fact_reviews r on r.fact_id = f.id
  where r.status = 'approved';

create function caseflow.review_fact(
  p_case uuid, p_document uuid, p_fact uuid, p_action text, p_expected_version integer,
  p_values jsonb default null, p_reason text default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  actor caseflow.users;
  document caseflow.documents;
  previous caseflow.fact_reviews;
  next_status text;
  next_values jsonb;
  audit_action text;
begin
  perform pg_advisory_xact_lock(734921, 1);
  actor := caseflow.require_actor();
  document := caseflow.require_document(p_case, p_document);
  if document.status <> 'available' then raise exception 'DOCUMENT_UNAVAILABLE'; end if;
  if exists(select 1 from caseflow.cases where id = p_case and archived_at is not null) then
    raise exception 'CASE_ARCHIVED';
  end if;
  if not exists(select 1 from caseflow.extracted_facts f
    join caseflow.fact_extraction_jobs j on j.id = f.extraction_job_id
    where f.id = p_fact and j.document_id = p_document and j.status = 'completed') then
    raise exception 'NOT_FOUND';
  end if;
  if p_action is null or p_action not in ('correct','approve','reject','reopen')
    or p_expected_version is null or p_expected_version < 1 then raise exception 'INVALID_INPUT'; end if;
  if p_action in ('approve','reopen') and actor.role not in ('admin','super_admin') then
    raise exception 'FORBIDDEN';
  end if;
  if (p_action = 'correct' and (
      not caseflow.valid_fact_values(p_values)
      or btrim(p_values->>'value') = ''
      or btrim(p_values->>'qualifier') = ''
      or btrim(p_values->>'dateMeaning') = ''))
    or (p_action <> 'correct' and p_values is not null)
    or (p_action = 'approve' and p_reason is not null)
    or (p_action <> 'approve' and (p_reason is null or length(btrim(p_reason)) not between 1 and 1000)) then
    raise exception 'INVALID_INPUT';
  end if;
  select * into previous from caseflow.fact_reviews where fact_id = p_fact for update;
  if previous.version <> p_expected_version then raise exception 'FACT_REVIEW_CONFLICT'; end if;
  if previous.status = 'approved' and p_action not in ('reopen','approve') then
    raise exception 'FACT_REVIEW_LOCKED';
  end if;
  if p_action = 'approve' and previous.status = 'rejected' then raise exception 'FACT_REVIEW_LOCKED'; end if;
  if p_action = 'reopen' and previous.status = 'rejected' then raise exception 'FACT_REVIEW_LOCKED'; end if;
  next_status := case p_action when 'approve' then 'approved' when 'reject' then 'rejected' else 'unreviewed' end;
  next_values := case when p_action = 'correct' then p_values else previous.values end;
  if next_status = previous.status and next_values = previous.values then return p_fact; end if;

  update caseflow.fact_reviews set status = next_status, values = next_values,
    version = previous.version + 1, reviewed_by = actor.id, reviewed_at = now() where fact_id = p_fact;
  insert into caseflow.fact_review_revisions(fact_id, version, action, status, values, reason, actor_id)
    values(p_fact, previous.version + 1, p_action, next_status, next_values, btrim(p_reason), actor.id);
  audit_action := case p_action when 'correct' then 'fact.corrected' when 'approve' then 'fact.approved'
    when 'reject' then 'fact.rejected' else 'fact.reopened' end;
  insert into caseflow.audit_events(actor_id, target_id, action, before_value, after_value)
    values(actor.id, p_fact, audit_action,
      jsonb_build_object('version', previous.version, 'status', previous.status),
      jsonb_build_object('caseId', p_case, 'documentId', p_document,
        'version', previous.version + 1, 'status', next_status));
  return p_fact;
end;
$$;

revoke all on caseflow.fact_reviews, caseflow.fact_review_revisions, caseflow.approved_facts
  from public, anon, authenticated, service_role, caseflow_runtime,
    caseflow_fact_extractor, caseflow_fact_dispatcher, caseflow_recovery;
grant select on caseflow.fact_reviews, caseflow.fact_review_revisions, caseflow.approved_facts to caseflow_runtime;
revoke all on function caseflow.fact_original_values(caseflow.extracted_facts),
  caseflow.valid_fact_values(jsonb), caseflow.initialize_fact_review(),
  caseflow.review_fact(uuid,uuid,uuid,text,integer,jsonb,text) from public, anon, authenticated, service_role, caseflow_fact_extractor,
    caseflow_fact_dispatcher, caseflow_recovery;
grant execute on function caseflow.fact_original_values(caseflow.extracted_facts),
  caseflow.review_fact(uuid,uuid,uuid,text,integer,jsonb,text) to caseflow_runtime;
