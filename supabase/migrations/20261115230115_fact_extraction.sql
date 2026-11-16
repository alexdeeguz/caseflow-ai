alter table caseflow.audit_events drop constraint audit_actor;
alter table caseflow.audit_events add constraint audit_actor check (
  ((actor_id is not null or operator_name is not null) and service_name is null)
  or (actor_id is null and operator_name is null
    and service_name is not null and service_name in ('document_processor', 'fact_extractor', 'fact_recovery'))
);

-- All costs use integer nanodollars; one USD is 1,000,000,000 nanodollars.
create table caseflow.fact_model_prices (
  version text primary key,
  model text not null,
  input_nanodollars bigint not null check (input_nanodollars > 0),
  output_nanodollars bigint not null check (output_nanodollars > 0)
);
insert into caseflow.fact_model_prices values
  ('2026-11-15', 'gpt-5.4-mini-2026-03-17', 750, 4500);

create table caseflow.fact_extraction_jobs (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references caseflow.documents(id),
  processing_result_id uuid not null references caseflow.document_processing_results(job_id),
  requested_by uuid not null references caseflow.users(id),
  previous_job_id uuid unique references caseflow.fact_extraction_jobs(id),
  model text not null default 'gpt-5.4-mini-2026-03-17'
    check (model = 'gpt-5.4-mini-2026-03-17'),
  prompt_version text not null default '1' check (prompt_version = '1'),
  schema_version integer not null default 1 check (schema_version = 1),
  pricing_version text not null default '2026-11-15' references caseflow.fact_model_prices(version),
  status text not null default 'queued'
    check (status in ('queued', 'extracting', 'completed', 'failed', 'cancelled')),
  failure_code text check (failure_code in ('source_unavailable', 'limit_exceeded',
    'invalid_evidence', 'provider_refused', 'incomplete_response', 'provider_unavailable',
    'budget_exceeded', 'attempts_exhausted', 'internal_error')),
  chunk_count integer not null default 0 check (chunk_count between 0 and 64),
  completed_chunks integer not null default 0 check (completed_chunks between 0 and chunk_count),
  fact_count integer not null default 0 check (fact_count >= 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  check ((status = 'failed') = (failure_code is not null)),
  check ((status in ('completed', 'failed', 'cancelled')) = (finished_at is not null)),
  check (status <> 'completed' or (chunk_count > 0 and completed_chunks = chunk_count))
);
create unique index fact_one_initial on caseflow.fact_extraction_jobs(document_id)
  where previous_job_id is null;
create unique index fact_one_active on caseflow.fact_extraction_jobs(document_id)
  where status in ('queued', 'extracting');
create index fact_document_latest on caseflow.fact_extraction_jobs(document_id, created_at desc, id desc);
create index fact_processing_result on caseflow.fact_extraction_jobs(processing_result_id);
create index fact_requester on caseflow.fact_extraction_jobs(requested_by);
create index fact_pricing on caseflow.fact_extraction_jobs(pricing_version);

create table caseflow.fact_extraction_tasks (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references caseflow.fact_extraction_jobs(id),
  ordinal integer not null check (ordinal between 0 and 64),
  status text not null default 'queued' check (status in ('queued', 'leased', 'completed', 'cancelled')),
  spans jsonb,
  output jsonb,
  lease_token uuid,
  lease_expires_at timestamptz,
  provider_attempts integer not null default 0 check (provider_attempts between 0 and 3),
  recovery_count integer not null default 0 check (recovery_count between 0 and 3),
  next_check_at timestamptz not null default clock_timestamp() + interval '15 minutes',
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique(job_id, ordinal),
  check ((ordinal = 0) = (spans is null)),
  check ((status = 'leased') = (lease_token is not null and lease_expires_at is not null)),
  check (spans is null or (jsonb_typeof(spans) = 'array' and octet_length(spans::text) <= 200000)),
  check (output is null or (jsonb_typeof(output) = 'array' and octet_length(output::text) <= 2000000))
);
create index fact_tasks_recovery on caseflow.fact_extraction_tasks(next_check_at, id)
  where status in ('queued', 'leased');

create table caseflow.fact_dispatches (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null unique references caseflow.fact_extraction_tasks(id),
  status text not null default 'pending' check (status in ('pending', 'leased', 'sent')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  available_at timestamptz not null default clock_timestamp(),
  lease_token uuid,
  lease_expires_at timestamptz,
  message_id text,
  sent_at timestamptz,
  check ((status = 'leased') = (lease_token is not null and lease_expires_at is not null)),
  check ((status = 'sent') = (sent_at is not null and message_id is not null))
);
create index fact_dispatch_pending on caseflow.fact_dispatches(available_at, id) where status = 'pending';
create index fact_dispatch_leased on caseflow.fact_dispatches(lease_expires_at, id) where status = 'leased';

create table caseflow.fact_daily_usage (
  day date primary key,
  committed_nanodollars bigint not null default 0 check (committed_nanodollars between 0 and 1000000000)
);
create table caseflow.fact_usage_reservations (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references caseflow.fact_extraction_tasks(id),
  attempt integer not null check (attempt between 1 and 3),
  day date not null references caseflow.fact_daily_usage(day),
  pricing_version text not null references caseflow.fact_model_prices(version),
  input_tokens integer not null check (input_tokens between 1 and 12000),
  max_output_tokens integer not null check (max_output_tokens = 8192),
  reserved_nanodollars bigint not null check (reserved_nanodollars > 0),
  actual_nanodollars bigint check (actual_nanodollars between 0 and reserved_nanodollars),
  created_at timestamptz not null default clock_timestamp(),
  settled_at timestamptz,
  unique(task_id, attempt),
  check ((settled_at is null) = (actual_nanodollars is null))
);
create index fact_usage_day on caseflow.fact_usage_reservations(day);
create index fact_usage_pricing on caseflow.fact_usage_reservations(pricing_version);

create table caseflow.extracted_facts (
  id uuid primary key default gen_random_uuid(),
  extraction_job_id uuid not null references caseflow.fact_extraction_jobs(id),
  category text not null check (category in ('date', 'provider', 'treatment', 'finding')),
  value text not null check (length(value) between 1 and 1000),
  qualifier text check (length(qualifier) between 1 and 1000),
  date_value text,
  date_precision text check (date_precision in ('year', 'month', 'day')),
  date_meaning text check (length(date_meaning) between 1 and 200),
  treatment_status text check (treatment_status in ('recommended', 'performed', 'unspecified')),
  finding_status text check (finding_status in ('suspected', 'confirmed', 'unspecified')),
  negated boolean not null,
  review_status text not null default 'unreviewed' check (review_status = 'unreviewed'),
  check ((category = 'date' and date_value is not null and date_precision is not null and date_meaning is not null)
    or (category <> 'date' and date_value is null and date_precision is null and date_meaning is null)),
  check ((category = 'treatment') = (treatment_status is not null)),
  check ((category = 'finding') = (finding_status is not null))
);
create index facts_job_category on caseflow.extracted_facts(extraction_job_id, category, id);
create table caseflow.fact_evidence (
  id uuid primary key default gen_random_uuid(),
  fact_id uuid not null references caseflow.extracted_facts(id),
  document_id uuid not null references caseflow.documents(id),
  processing_result_id uuid not null references caseflow.document_processing_results(job_id),
  page integer not null check (page between 1 and 20),
  quote text not null check (length(quote) between 1 and 4000),
  start_offset integer not null check (start_offset >= 0),
  end_offset integer not null,
  check (end_offset = start_offset + length(quote))
);
create index fact_evidence_fact on caseflow.fact_evidence(fact_id);
create index fact_evidence_document on caseflow.fact_evidence(document_id);
create index fact_evidence_result on caseflow.fact_evidence(processing_result_id);

do $$ begin
  if not exists(select 1 from pg_roles where rolname = 'caseflow_fact_extractor') then
    create role caseflow_fact_extractor nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
  if not exists(select 1 from pg_roles where rolname = 'caseflow_fact_dispatcher') then
    create role caseflow_fact_dispatcher nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
end $$;
grant usage on schema caseflow to caseflow_fact_extractor, caseflow_fact_dispatcher;

alter table caseflow.fact_model_prices enable row level security;
alter table caseflow.fact_extraction_jobs enable row level security;
alter table caseflow.fact_extraction_tasks enable row level security;
alter table caseflow.fact_dispatches enable row level security;
alter table caseflow.fact_daily_usage enable row level security;
alter table caseflow.fact_usage_reservations enable row level security;
alter table caseflow.extracted_facts enable row level security;
alter table caseflow.fact_evidence enable row level security;

create policy read_fact_jobs on caseflow.fact_extraction_jobs for select to caseflow_runtime
using (exists(select 1 from caseflow.documents d where d.id = document_id));
create policy read_facts on caseflow.extracted_facts for select to caseflow_runtime
using (exists(select 1 from caseflow.fact_extraction_jobs j join caseflow.documents d on d.id = j.document_id
  where j.id = extraction_job_id and j.status = 'completed' and d.status = 'available'));
create policy read_fact_evidence on caseflow.fact_evidence for select to caseflow_runtime
using (exists(select 1 from caseflow.extracted_facts f where f.id = fact_id));

revoke all on caseflow.fact_model_prices, caseflow.fact_extraction_jobs, caseflow.fact_extraction_tasks,
  caseflow.fact_dispatches, caseflow.fact_daily_usage, caseflow.fact_usage_reservations,
  caseflow.extracted_facts, caseflow.fact_evidence
  from public, anon, authenticated, service_role, caseflow_runtime, caseflow_fact_extractor,
    caseflow_fact_dispatcher, caseflow_recovery;
grant select(id, document_id, processing_result_id, status, failure_code, chunk_count, completed_chunks,
  fact_count, created_at, updated_at, finished_at) on caseflow.fact_extraction_jobs to caseflow_runtime;
grant select on caseflow.extracted_facts, caseflow.fact_evidence to caseflow_runtime;

create function caseflow.request_fact_extraction(p_case uuid, p_document uuid, p_expected uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  actor caseflow.users;
  document caseflow.documents;
  latest caseflow.fact_extraction_jobs;
  processing_id uuid;
  new_id uuid;
  task uuid;
begin
  perform pg_advisory_xact_lock(734921, 1);
  actor := caseflow.require_actor();
  if actor.role not in ('admin', 'super_admin') then raise exception 'FORBIDDEN'; end if;
  perform caseflow.require_upload_case(p_case);
  document := caseflow.require_document(p_case, p_document);
  if document.status <> 'available' then raise exception 'DOCUMENT_UNAVAILABLE'; end if;
  select * into latest from caseflow.fact_extraction_jobs where document_id = p_document
    order by created_at desc, id desc limit 1 for update;
  if latest.id is not null then
    if latest.previous_job_id is not distinct from p_expected then return latest.id; end if;
    if latest.id is distinct from p_expected or latest.status not in ('failed', 'cancelled') then
      raise exception 'FACT_EXTRACTION_CONFLICT';
    end if;
  elsif p_expected is not null then raise exception 'FACT_EXTRACTION_CONFLICT';
  end if;
  select r.job_id into processing_id from caseflow.document_processing_results r
    join caseflow.document_processing_jobs j on j.id = r.job_id
    where j.document_id = p_document and j.status = 'ready'
    order by j.created_at desc, j.id desc limit 1;
  if processing_id is null then raise exception 'DOCUMENT_UNAVAILABLE'; end if;
  insert into caseflow.fact_extraction_jobs(document_id, processing_result_id, requested_by, previous_job_id)
    values(p_document, processing_id, actor.id, p_expected) returning id into new_id;
  insert into caseflow.fact_extraction_tasks(job_id, ordinal) values(new_id, 0) returning id into task;
  insert into caseflow.fact_dispatches(task_id) values(task);
  insert into caseflow.audit_events(actor_id, target_id, action, after_value)
    values(actor.id, p_document, 'document.facts_queued', jsonb_build_object(
      'caseId', p_case, 'jobId', new_id, 'processingResultId', processing_id));
  return new_id;
end;
$$;

-- Internal lifecycle helper. Callers hold the shared permission lock.
create function caseflow.end_fact_extraction(p_job uuid, p_status text, p_failure text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare job caseflow.fact_extraction_jobs;
begin
  if p_status not in ('failed', 'cancelled') then raise exception 'INVALID_INPUT'; end if;
  update caseflow.fact_extraction_jobs set status = p_status, failure_code = p_failure,
    updated_at = clock_timestamp(), finished_at = clock_timestamp()
    where id = p_job and status in ('queued', 'extracting') returning * into job;
  if not found then return; end if;
  update caseflow.fact_extraction_tasks set status = 'cancelled', lease_token = null,
    lease_expires_at = null, updated_at = clock_timestamp()
    where job_id = p_job and status in ('queued', 'leased');
  insert into caseflow.audit_events(service_name, target_id, action, after_value)
    values('fact_extractor', job.document_id, 'document.facts_' || p_status,
      jsonb_build_object('jobId', p_job, 'failureCode', p_failure));
end;
$$;

create function caseflow.cancel_unavailable_fact_extraction()
returns trigger language plpgsql security definer set search_path = '' as $$
declare job uuid;
begin
  perform pg_advisory_xact_lock(734921, 1);
  for job in select j.id from caseflow.fact_extraction_jobs j
    join caseflow.documents d on d.id = j.document_id
    join caseflow.cases c on c.id = d.case_id
    where j.status in ('queued', 'extracting') and (d.status <> 'available' or c.archived_at is not null)
      and ((tg_table_name = 'documents' and d.id = new.id) or
        (tg_table_name = 'cases' and c.id = new.id))
    order by j.id for update of j
  loop
    perform caseflow.end_fact_extraction(job, 'cancelled');
  end loop;
  return new;
end;
$$;
create trigger cancel_document_fact_jobs after update of status on caseflow.documents
  for each row execute function caseflow.cancel_unavailable_fact_extraction();
create trigger cancel_case_fact_jobs after update of archived_at on caseflow.cases
  for each row execute function caseflow.cancel_unavailable_fact_extraction();

create function caseflow.claim_fact_task(p_task uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  task caseflow.fact_extraction_tasks;
  job caseflow.fact_extraction_jobs;
  document caseflow.documents;
  result caseflow.document_processing_results;
begin
  perform pg_advisory_xact_lock(734921, 1);
  select * into task from caseflow.fact_extraction_tasks where id = p_task for update;
  if task.id is null then raise exception 'NOT_FOUND'; end if;
  select * into job from caseflow.fact_extraction_jobs where id = task.job_id for update;
  select * into document from caseflow.documents where id = job.document_id;
  if job.status not in ('queued', 'extracting') or task.status in ('completed', 'cancelled') then
    return jsonb_build_object('disposition', 'terminal');
  end if;
  if document.status <> 'available' or exists(select 1 from caseflow.cases
    where id = document.case_id and archived_at is not null) then
    perform caseflow.end_fact_extraction(job.id, 'cancelled');
    return jsonb_build_object('disposition', 'terminal');
  end if;
  if task.status = 'leased' and task.lease_expires_at > clock_timestamp() then
    return jsonb_build_object('disposition', 'busy');
  end if;
  if task.provider_attempts >= 3 then
    perform caseflow.end_fact_extraction(job.id, 'failed', 'attempts_exhausted');
    return jsonb_build_object('disposition', 'terminal');
  end if;
  update caseflow.fact_extraction_tasks set status = 'leased', lease_token = gen_random_uuid(),
    lease_expires_at = clock_timestamp() + interval '180 seconds', updated_at = clock_timestamp(),
    next_check_at = clock_timestamp() + interval '15 minutes'
    where id = p_task returning * into task;
  update caseflow.fact_extraction_jobs set status = 'extracting', updated_at = clock_timestamp()
    where id = job.id;
  select * into result from caseflow.document_processing_results where job_id = job.processing_result_id;
  return jsonb_build_object('disposition', 'claimed', 'taskId', task.id, 'jobId', job.id,
    'documentId', document.id, 'processingResultId', result.job_id, 'leaseToken', task.lease_token,
    'ordinal', task.ordinal, 'spans', task.spans, 'model', job.model, 'promptVersion', job.prompt_version,
    'schemaVersion', job.schema_version, 'source', jsonb_build_object('bucket', result.storage_bucket,
      'key', result.artifacts->'text'->>'key', 'versionId', result.artifacts->'text'->>'versionId',
      'checksumSha256', result.artifacts->'text'->>'checksumSha256',
      'sizeBytes', (result.artifacts->'text'->>'sizeBytes')::integer));
end;
$$;

create function caseflow.require_fact_lease(p_task uuid, p_token uuid)
returns caseflow.fact_extraction_tasks language plpgsql security definer set search_path = '' as $$
declare task caseflow.fact_extraction_tasks;
begin
  perform pg_advisory_xact_lock(734921, 1);
  select * into task from caseflow.fact_extraction_tasks where id = p_task for update;
  if task.id is null or task.status <> 'leased' or task.lease_token is distinct from p_token
    or task.lease_expires_at <= clock_timestamp() or not exists(select 1
      from caseflow.fact_extraction_jobs j join caseflow.documents d on d.id = j.document_id
      join caseflow.cases c on c.id = d.case_id where j.id = task.job_id
      and j.status = 'extracting' and d.status = 'available' and c.archived_at is null) then
    raise exception 'FACT_EXTRACTION_CONFLICT';
  end if;
  return task;
end;
$$;

create function caseflow.check_fact_lease(p_task uuid, p_token uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform caseflow.require_fact_lease(p_task, p_token);
  return true;
end;
$$;

create function caseflow.prepare_fact_chunks(p_task uuid, p_token uuid, p_chunks jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare task caseflow.fact_extraction_tasks; chunk jsonb; new_task uuid; ordinal integer := 0;
begin
  task := caseflow.require_fact_lease(p_task, p_token);
  if task.ordinal <> 0 or jsonb_typeof(p_chunks) is distinct from 'array'
    or jsonb_array_length(p_chunks) not between 1 and 64 then raise exception 'INVALID_INPUT'; end if;
  for chunk in select value from jsonb_array_elements(p_chunks) loop
    ordinal := ordinal + 1;
    if jsonb_typeof(chunk) is distinct from 'array' or jsonb_array_length(chunk) < 1 then
      raise exception 'INVALID_INPUT';
    end if;
    insert into caseflow.fact_extraction_tasks(job_id, ordinal, spans)
      values(task.job_id, ordinal, chunk) returning id into new_task;
    insert into caseflow.fact_dispatches(task_id) values(new_task);
  end loop;
  update caseflow.fact_extraction_jobs set chunk_count = ordinal, updated_at = clock_timestamp()
    where id = task.job_id;
  update caseflow.fact_extraction_tasks set status = 'completed', lease_token = null,
    lease_expires_at = null, updated_at = clock_timestamp() where id = p_task;
end;
$$;

create function caseflow.reserve_fact_usage(p_task uuid, p_token uuid, p_input integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  task caseflow.fact_extraction_tasks;
  price caseflow.fact_model_prices;
  today date := (clock_timestamp() at time zone 'UTC')::date;
  amount bigint;
  reservation uuid;
begin
  task := caseflow.require_fact_lease(p_task, p_token);
  if task.ordinal = 0 or p_input is null or p_input not between 1 and 12000 then
    raise exception 'INVALID_INPUT';
  end if;
  if task.provider_attempts >= 3 then
    perform caseflow.end_fact_extraction(task.job_id, 'failed', 'attempts_exhausted');
    return jsonb_build_object('allowed', false);
  end if;
  select p.* into price from caseflow.fact_model_prices p join caseflow.fact_extraction_jobs j
    on j.pricing_version = p.version and j.model = p.model where j.id = task.job_id;
  if price.version is null then raise exception 'SERVICE_UNAVAILABLE'; end if;
  amount := p_input * price.input_nanodollars + 8192 * price.output_nanodollars;
  insert into caseflow.fact_daily_usage(day) values(today) on conflict do nothing;
  update caseflow.fact_daily_usage set committed_nanodollars = committed_nanodollars + amount
    where day = today and committed_nanodollars + amount <= 1000000000;
  if not found then
    perform caseflow.end_fact_extraction(task.job_id, 'failed', 'budget_exceeded');
    return jsonb_build_object('allowed', false);
  end if;
  update caseflow.fact_extraction_tasks set provider_attempts = provider_attempts + 1
    where id = p_task returning * into task;
  insert into caseflow.fact_usage_reservations(task_id, attempt, day, pricing_version,
    input_tokens, max_output_tokens, reserved_nanodollars)
    values(p_task, task.provider_attempts, today, price.version, p_input, 8192, amount)
    returning id into reservation;
  return jsonb_build_object('allowed', true, 'reservationId', reservation, 'attempt', task.provider_attempts);
end;
$$;

-- Settlement remains possible after cancellation; it cannot publish data or renew a lease.
create function caseflow.settle_fact_usage(p_reservation uuid, p_input integer, p_output integer)
returns void language plpgsql security definer set search_path = '' as $$
declare reservation caseflow.fact_usage_reservations; price caseflow.fact_model_prices; actual bigint;
begin
  select * into reservation from caseflow.fact_usage_reservations where id = p_reservation for update;
  if reservation.id is null then raise exception 'NOT_FOUND'; end if;
  if p_input is null or p_output is null or p_input < 0 or p_output < 0 then
    raise exception 'INVALID_INPUT';
  end if;
  select * into price from caseflow.fact_model_prices where version = reservation.pricing_version;
  actual := p_input * price.input_nanodollars + p_output * price.output_nanodollars;
  if actual > reservation.reserved_nanodollars then raise exception 'INVALID_INPUT'; end if;
  if reservation.settled_at is not null then
    if actual <> reservation.actual_nanodollars then raise exception 'INVALID_INPUT'; end if;
    return;
  end if;
  update caseflow.fact_daily_usage set committed_nanodollars = committed_nanodollars -
    reservation.reserved_nanodollars + actual where day = reservation.day;
  update caseflow.fact_usage_reservations set actual_nanodollars = actual, settled_at = clock_timestamp()
    where id = p_reservation;
end;
$$;

create function caseflow.fail_fact_task(p_task uuid, p_token uuid, p_failure text)
returns void language plpgsql security definer set search_path = '' as $$
declare task caseflow.fact_extraction_tasks;
begin
  task := caseflow.require_fact_lease(p_task, p_token);
  perform caseflow.end_fact_extraction(task.job_id, 'failed', p_failure);
end;
$$;

-- Validate citations against checkpointed spans; source identity comes from the processing result.
create function caseflow.complete_fact_chunk(p_task uuid, p_token uuid, p_facts jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  task caseflow.fact_extraction_tasks;
  job caseflow.fact_extraction_jobs;
  fact jsonb;
  evidence jsonb;
  fact_id uuid;
  total integer;
begin
  task := caseflow.require_fact_lease(p_task, p_token);
  if task.ordinal = 0 or jsonb_typeof(p_facts) is distinct from 'array'
    or jsonb_array_length(p_facts) > 200 or octet_length(p_facts::text) > 2000000 then
    raise exception 'INVALID_INPUT';
  end if;
  for fact in select value from jsonb_array_elements(p_facts) loop
    if jsonb_typeof(fact->'evidence') is distinct from 'array'
      or jsonb_array_length(fact->'evidence') not between 1 and 8 then raise exception 'INVALID_INPUT'; end if;
    for evidence in select value from jsonb_array_elements(fact->'evidence') loop
      if not exists(select 1 from jsonb_array_elements(task.spans) s where
        (s->>'page')::integer = (evidence->>'page')::integer
        and (evidence->>'start')::integer >= (s->>'start')::integer
        and (evidence->>'end')::integer <= (s->>'start')::integer + length(s->>'text')
        and (evidence->>'end')::integer = (evidence->>'start')::integer + length(evidence->>'quote')
        and substring(s->>'text' from (evidence->>'start')::integer - (s->>'start')::integer + 1
          for length(evidence->>'quote')) = evidence->>'quote') then raise exception 'INVALID_INPUT'; end if;
    end loop;
  end loop;
  update caseflow.fact_extraction_tasks set output = p_facts, status = 'completed',
    lease_token = null, lease_expires_at = null, updated_at = clock_timestamp() where id = p_task;
  update caseflow.fact_extraction_jobs set completed_chunks = completed_chunks + 1,
    updated_at = clock_timestamp() where id = task.job_id returning * into job;
  if job.completed_chunks <> job.chunk_count then return; end if;

  -- Equal facts with identical source offsets can arise from boundary overlap only.
  for fact in select distinct f.value from caseflow.fact_extraction_tasks t,
    lateral jsonb_array_elements(t.output) f where t.job_id = job.id and t.ordinal > 0
  loop
    insert into caseflow.extracted_facts(extraction_job_id, category, value, qualifier,
      date_value, date_precision, date_meaning, treatment_status, finding_status, negated)
    values(job.id, fact->>'category', fact->>'value', fact->>'qualifier', fact->>'dateValue',
      fact->>'datePrecision', fact->>'dateMeaning', fact->>'treatmentStatus', fact->>'findingStatus',
      (fact->>'negated')::boolean) returning id into fact_id;
    for evidence in select value from jsonb_array_elements(fact->'evidence') loop
      insert into caseflow.fact_evidence(fact_id, document_id, processing_result_id, page, quote,
        start_offset, end_offset)
      values(fact_id, job.document_id, job.processing_result_id, (evidence->>'page')::integer,
        evidence->>'quote', (evidence->>'start')::integer, (evidence->>'end')::integer);
    end loop;
  end loop;
  select count(*) into total from caseflow.extracted_facts where extraction_job_id = job.id;
  update caseflow.fact_extraction_jobs set status = 'completed', fact_count = total,
    updated_at = clock_timestamp(), finished_at = clock_timestamp() where id = job.id;
  insert into caseflow.audit_events(service_name, target_id, action, after_value)
    values('fact_extractor', job.document_id, 'document.facts_completed',
      jsonb_build_object('jobId', job.id, 'factCount', total, 'processingResultId', job.processing_result_id));
end;
$$;

create function caseflow.claim_fact_dispatches(p_limit integer)
returns table(dispatch_id uuid, job_id uuid, lease_token uuid, lease_expires_at timestamptz, attempt_count integer)
language plpgsql security definer set search_path = '' as $$
begin
  if p_limit is null or p_limit not between 1 and 25 then raise exception 'INVALID_INPUT'; end if;
  return query with candidates as (
    select d.id from caseflow.fact_dispatches d join caseflow.fact_extraction_tasks t on t.id = d.task_id
    join caseflow.fact_extraction_jobs j on j.id = t.job_id
    where j.status in ('queued', 'extracting') and t.status = 'queued' and
      ((d.status = 'pending' and d.available_at <= clock_timestamp()) or
       (d.status = 'leased' and d.lease_expires_at <= clock_timestamp()))
    order by d.available_at, d.id limit p_limit for update of d skip locked
  ) update caseflow.fact_dispatches d set status = 'leased', lease_token = gen_random_uuid(),
    lease_expires_at = clock_timestamp() + interval '60 seconds', attempt_count = d.attempt_count + 1
    from candidates c where d.id = c.id
    returning d.id, d.task_id, d.lease_token, d.lease_expires_at, d.attempt_count;
end;
$$;

create function caseflow.finish_fact_dispatch(p_dispatch uuid, p_token uuid, p_message text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_message is null or length(p_message) not between 1 and 128 or p_message ~ '[[:cntrl:]]' then
    raise exception 'INVALID_INPUT';
  end if;
  update caseflow.fact_dispatches set status = 'sent', message_id = p_message, sent_at = clock_timestamp(),
    lease_token = null, lease_expires_at = null where id = p_dispatch and status = 'leased'
    and lease_token = p_token and lease_expires_at > clock_timestamp();
  return found;
end;
$$;
create function caseflow.retry_fact_dispatch(p_dispatch uuid, p_token uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update caseflow.fact_dispatches set status = 'pending', available_at = clock_timestamp() + interval '30 seconds',
    lease_token = null, lease_expires_at = null where id = p_dispatch and status = 'leased'
    and lease_token = p_token and lease_expires_at > clock_timestamp();
  return found;
end;
$$;

create function caseflow.recover_fact_tasks(p_limit integer, p_bucket text, p_environment text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare task caseflow.fact_extraction_tasks; recovered integer := 0; failed integer := 0;
begin
  if p_limit is null or p_limit not between 1 and 25 then raise exception 'INVALID_INPUT'; end if;
  perform pg_advisory_xact_lock(734921, 1);
  for task in select t.* from caseflow.fact_extraction_tasks t
    join caseflow.fact_extraction_jobs j on j.id = t.job_id
    join caseflow.documents d on d.id = j.document_id
    where d.storage_bucket = p_bucket and d.storage_environment = p_environment
      and j.status in ('queued', 'extracting') and t.status in ('queued', 'leased')
      and t.next_check_at <= clock_timestamp()
      and (t.lease_expires_at is null or t.lease_expires_at <= clock_timestamp())
    order by t.next_check_at, t.id limit p_limit for update of t skip locked
  loop
    if not exists(select 1 from caseflow.fact_extraction_jobs j
      join caseflow.documents d on d.id = j.document_id join caseflow.cases c on c.id = d.case_id
      where j.id = task.job_id and d.status = 'available' and c.archived_at is null) then
      perform caseflow.end_fact_extraction(task.job_id, 'cancelled');
    elsif task.recovery_count >= 3 or task.provider_attempts >= 3 then
      perform caseflow.end_fact_extraction(task.job_id, 'failed', 'attempts_exhausted');
      failed := failed + 1;
    else
      update caseflow.fact_extraction_tasks set status = 'queued', lease_token = null,
        lease_expires_at = null, recovery_count = recovery_count + 1,
        next_check_at = clock_timestamp() + interval '15 minutes', updated_at = clock_timestamp()
        where id = task.id;
      update caseflow.fact_dispatches set status = 'pending', available_at = clock_timestamp(),
        lease_token = null, lease_expires_at = null, message_id = null, sent_at = null where task_id = task.id;
      insert into caseflow.audit_events(service_name, target_id, action, after_value)
        select 'fact_recovery', document_id, 'document.facts_recovered',
          jsonb_build_object('jobId', id, 'taskId', task.id, 'recoveryCount', task.recovery_count + 1)
        from caseflow.fact_extraction_jobs where id = task.job_id;
      recovered := recovered + 1;
    end if;
  end loop;
  return jsonb_build_object('recovered', recovered, 'failed', failed);
end;
$$;

revoke all on function caseflow.request_fact_extraction(uuid, uuid, uuid),
  caseflow.end_fact_extraction(uuid, text, text), caseflow.cancel_unavailable_fact_extraction(),
  caseflow.claim_fact_task(uuid), caseflow.require_fact_lease(uuid, uuid),
  caseflow.check_fact_lease(uuid, uuid), caseflow.prepare_fact_chunks(uuid, uuid, jsonb),
  caseflow.reserve_fact_usage(uuid, uuid, integer), caseflow.settle_fact_usage(uuid, integer, integer),
  caseflow.fail_fact_task(uuid, uuid, text), caseflow.complete_fact_chunk(uuid, uuid, jsonb),
  caseflow.claim_fact_dispatches(integer), caseflow.finish_fact_dispatch(uuid, uuid, text),
  caseflow.retry_fact_dispatch(uuid, uuid), caseflow.recover_fact_tasks(integer, text, text)
  from public, anon, authenticated, service_role, caseflow_runtime, caseflow_fact_extractor,
    caseflow_fact_dispatcher, caseflow_recovery;
grant execute on function caseflow.request_fact_extraction(uuid, uuid, uuid) to caseflow_runtime;
grant execute on function caseflow.claim_fact_task(uuid), caseflow.check_fact_lease(uuid, uuid),
  caseflow.prepare_fact_chunks(uuid, uuid, jsonb), caseflow.reserve_fact_usage(uuid, uuid, integer),
  caseflow.settle_fact_usage(uuid, integer, integer), caseflow.fail_fact_task(uuid, uuid, text),
  caseflow.complete_fact_chunk(uuid, uuid, jsonb) to caseflow_fact_extractor;
grant execute on function caseflow.claim_fact_dispatches(integer),
  caseflow.finish_fact_dispatch(uuid, uuid, text), caseflow.retry_fact_dispatch(uuid, uuid)
  to caseflow_fact_dispatcher;
grant execute on function caseflow.recover_fact_tasks(integer, text, text) to caseflow_recovery;

create function caseflow.split_fact_task(p_task uuid, p_token uuid, p_left jsonb, p_right jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare task caseflow.fact_extraction_tasks; job caseflow.fact_extraction_jobs; new_task uuid;
begin
  task := caseflow.require_fact_lease(p_task, p_token);
  select * into job from caseflow.fact_extraction_jobs where id = task.job_id for update;
  if task.ordinal = 0 or task.provider_attempts <> 0 then raise exception 'INVALID_INPUT'; end if;
  if job.chunk_count >= 64 then
    perform caseflow.end_fact_extraction(job.id, 'failed', 'limit_exceeded');
    return;
  end if;
  if jsonb_typeof(p_left) is distinct from 'array' or jsonb_typeof(p_right) is distinct from 'array'
    or jsonb_array_length(p_left) <> 1 or jsonb_array_length(p_right) <> 1 then
    raise exception 'INVALID_INPUT';
  end if;
  update caseflow.fact_extraction_tasks set spans = p_left, status = 'queued', lease_token = null,
    lease_expires_at = null, updated_at = clock_timestamp() where id = p_task;
  insert into caseflow.fact_extraction_tasks(job_id, ordinal, spans)
    values(job.id, job.chunk_count + 1, p_right) returning id into new_task;
  update caseflow.fact_extraction_jobs set chunk_count = chunk_count + 1, updated_at = clock_timestamp()
    where id = job.id;
  update caseflow.fact_dispatches set status = 'pending', message_id = null, sent_at = null,
    lease_token = null, lease_expires_at = null, available_at = clock_timestamp() where task_id = p_task;
  insert into caseflow.fact_dispatches(task_id) values(new_task);
end;
$$;

create function caseflow.retry_fact_task(p_task uuid, p_token uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare task caseflow.fact_extraction_tasks;
begin
  task := caseflow.require_fact_lease(p_task, p_token);
  if task.provider_attempts >= 3 then
    perform caseflow.end_fact_extraction(task.job_id, 'failed', 'attempts_exhausted');
    return;
  end if;
  update caseflow.fact_extraction_tasks set status = 'queued', lease_token = null,
    lease_expires_at = null, updated_at = clock_timestamp(),
    next_check_at = clock_timestamp() + interval '15 minutes' where id = p_task;
  update caseflow.fact_dispatches set status = 'pending', message_id = null, sent_at = null,
    lease_token = null, lease_expires_at = null,
    available_at = clock_timestamp() + make_interval(secs => 15 * power(2, task.provider_attempts)::integer)
    where task_id = p_task;
end;
$$;
revoke all on function caseflow.split_fact_task(uuid, uuid, jsonb, jsonb), caseflow.retry_fact_task(uuid, uuid)
  from public, anon, authenticated, service_role, caseflow_runtime, caseflow_fact_dispatcher;
grant execute on function caseflow.split_fact_task(uuid, uuid, jsonb, jsonb), caseflow.retry_fact_task(uuid, uuid)
  to caseflow_fact_extractor;
