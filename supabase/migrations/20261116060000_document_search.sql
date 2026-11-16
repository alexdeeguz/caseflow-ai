-- Document search: per-page text chunks with full-text vectors and pgvector embeddings.
-- Chunks are written by the search indexer through security-definer functions; the API reads them
-- through row-level security, so search results follow the same case access as documents.
create schema if not exists extensions;
create extension if not exists vector with schema extensions;
grant usage on schema extensions to caseflow_runtime;

-- Costs use integer nanodollars and share the fact extraction daily allowance.
create table caseflow.search_model_prices (
  version text primary key,
  model text not null,
  input_nanodollars bigint not null check (input_nanodollars > 0)
);
insert into caseflow.search_model_prices values ('2026-11-16', 'text-embedding-3-small', 20);

create table caseflow.search_index_jobs (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references caseflow.documents(id),
  processing_result_id uuid not null references caseflow.document_processing_results(job_id),
  requested_by uuid references caseflow.users(id),
  previous_job_id uuid unique references caseflow.search_index_jobs(id),
  model text not null default 'text-embedding-3-small' check (model = 'text-embedding-3-small'),
  pricing_version text not null default '2026-11-16' references caseflow.search_model_prices(version),
  -- partial: text is keyword-searchable but embeddings could not be completed.
  status text not null default 'queued'
    check (status in ('queued', 'indexing', 'ready', 'partial', 'failed', 'cancelled')),
  failure_code text check (failure_code in ('source_unavailable', 'limit_exceeded',
    'provider_unavailable', 'budget_exceeded', 'attempts_exhausted', 'internal_error')),
  chunk_count integer not null default 0 check (chunk_count between 0 and 500),
  embedded_count integer not null default 0 check (embedded_count between 0 and chunk_count),
  chunks_saved boolean not null default false,
  attempt_count integer not null default 0 check (attempt_count between 0 and 5),
  recovery_count integer not null default 0 check (recovery_count between 0 and 3),
  lease_token uuid,
  lease_expires_at timestamptz,
  next_check_at timestamptz not null default clock_timestamp() + interval '15 minutes',
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  check ((status in ('failed', 'partial')) = (failure_code is not null)),
  check ((status in ('ready', 'partial', 'failed', 'cancelled')) = (finished_at is not null)),
  check ((lease_token is null) = (lease_expires_at is null)),
  check (status <> 'ready' or (chunks_saved and embedded_count = chunk_count)),
  check (status <> 'partial' or chunks_saved)
);
create unique index search_one_active on caseflow.search_index_jobs(document_id)
  where status in ('queued', 'indexing');
create index search_document_latest on caseflow.search_index_jobs(document_id, created_at desc, id desc);
create index search_processing_result on caseflow.search_index_jobs(processing_result_id);
create index search_requester on caseflow.search_index_jobs(requested_by);
create index search_pricing on caseflow.search_index_jobs(pricing_version);
create index search_recovery on caseflow.search_index_jobs(next_check_at, id)
  where status in ('queued', 'indexing');

create table caseflow.search_dispatches (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null unique references caseflow.search_index_jobs(id),
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
create index search_dispatch_pending on caseflow.search_dispatches(available_at, id) where status = 'pending';
create index search_dispatch_leased on caseflow.search_dispatches(lease_expires_at, id) where status = 'leased';

create table caseflow.search_usage_reservations (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references caseflow.search_index_jobs(id),
  day date not null references caseflow.fact_daily_usage(day),
  pricing_version text not null references caseflow.search_model_prices(version),
  input_tokens integer not null check (input_tokens between 1 and 200000),
  reserved_nanodollars bigint not null check (reserved_nanodollars > 0),
  actual_nanodollars bigint check (actual_nanodollars between 0 and reserved_nanodollars),
  created_at timestamptz not null default clock_timestamp(),
  settled_at timestamptz,
  check ((settled_at is null) = (actual_nanodollars is null))
);
create index search_usage_job on caseflow.search_usage_reservations(job_id);
create index search_usage_day on caseflow.search_usage_reservations(day);
create index search_usage_pricing on caseflow.search_usage_reservations(pricing_version);

-- One chunk set per document; a newer indexing run replaces it atomically.
create table caseflow.document_text_chunks (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references caseflow.search_index_jobs(id),
  document_id uuid not null references caseflow.documents(id),
  case_id uuid not null references caseflow.cases(id),
  processing_result_id uuid not null references caseflow.document_processing_results(job_id),
  chunk_index integer not null check (chunk_index between 0 and 499),
  page integer not null check (page between 1 and 20),
  start_offset integer not null check (start_offset >= 0),
  end_offset integer not null,
  content text not null check (length(content) between 1 and 2000),
  search_vector tsvector generated always as (to_tsvector('english', content)) stored,
  embedding extensions.vector(1536),
  unique(job_id, chunk_index),
  check (end_offset = start_offset + length(content))
);
create index document_chunks_search on caseflow.document_text_chunks using gin(search_vector);
create index document_chunks_embedding on caseflow.document_text_chunks
  using hnsw (embedding extensions.vector_cosine_ops);
create index document_chunks_case on caseflow.document_text_chunks(case_id);
create index document_chunks_document on caseflow.document_text_chunks(document_id);
create index document_chunks_result on caseflow.document_text_chunks(processing_result_id);

do $$ begin
  if not exists(select 1 from pg_roles where rolname = 'caseflow_search_indexer') then
    create role caseflow_search_indexer nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
  if not exists(select 1 from pg_roles where rolname = 'caseflow_search_dispatcher') then
    create role caseflow_search_dispatcher nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
end $$;
grant usage on schema caseflow to caseflow_search_indexer, caseflow_search_dispatcher;

alter table caseflow.search_model_prices enable row level security;
alter table caseflow.search_index_jobs enable row level security;
alter table caseflow.search_dispatches enable row level security;
alter table caseflow.search_usage_reservations enable row level security;
alter table caseflow.document_text_chunks enable row level security;

-- Visibility chains through documents (and therefore cases): Staff see only assigned cases.
create policy read_search_jobs on caseflow.search_index_jobs for select to caseflow_runtime
using (exists(select 1 from caseflow.documents d where d.id = document_id));
create policy read_document_chunks on caseflow.document_text_chunks for select to caseflow_runtime
using (exists(select 1 from caseflow.documents d where d.id = document_id and d.status = 'available'));

revoke all on caseflow.search_model_prices, caseflow.search_index_jobs, caseflow.search_dispatches,
  caseflow.search_usage_reservations, caseflow.document_text_chunks
  from public, anon, authenticated, service_role, caseflow_runtime, caseflow_search_indexer,
    caseflow_search_dispatcher, caseflow_recovery;
grant select(id, document_id, status, failure_code, chunk_count, embedded_count, created_at,
  updated_at, finished_at) on caseflow.search_index_jobs to caseflow_runtime;
grant select(id, document_id, case_id, page, start_offset, end_offset, content, search_vector, embedding)
  on caseflow.document_text_chunks to caseflow_runtime;

-- Internal helper; callers hold the shared permission lock and authorize the source.
create function caseflow.enqueue_search_index(
  p_document uuid, p_processing_result uuid, p_requester uuid, p_previous uuid
) returns uuid language plpgsql security definer set search_path = '' as $$
declare new_id uuid;
begin
  if not exists(select 1 from caseflow.document_processing_jobs j
      join caseflow.document_processing_results r on r.job_id = j.id
      where j.id = p_processing_result and j.document_id = p_document and j.status = 'ready') then
    raise exception 'INVALID_INPUT';
  end if;
  insert into caseflow.search_index_jobs(document_id, processing_result_id, requested_by, previous_job_id)
    values(p_document, p_processing_result, p_requester, p_previous) returning id into new_id;
  insert into caseflow.search_dispatches(job_id) values(new_id);
  return new_id;
end;
$$;

-- Internal lifecycle helper. Callers hold the shared permission lock.
create function caseflow.end_search_index(p_job uuid, p_status text, p_failure text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare job caseflow.search_index_jobs; final_status text := p_status;
begin
  if p_status not in ('failed', 'cancelled') then raise exception 'INVALID_INPUT'; end if;
  select * into job from caseflow.search_index_jobs where id = p_job for update;
  if job.id is null or job.status not in ('queued', 'indexing') then return; end if;
  -- Saved chunks stay keyword-searchable when embeddings cannot finish.
  if p_status = 'failed' and job.chunks_saved then final_status := 'partial'; end if;
  update caseflow.search_index_jobs set status = final_status,
    failure_code = case when final_status = 'cancelled' then null else p_failure end,
    lease_token = null, lease_expires_at = null, updated_at = clock_timestamp(),
    finished_at = clock_timestamp() where id = p_job;
end;
$$;

create function caseflow.queue_search_after_processing()
returns trigger language plpgsql security definer set search_path = '' as $$
declare active uuid;
begin
  perform pg_advisory_xact_lock(734921, 1);
  if not exists(select 1 from caseflow.documents d where d.id = new.document_id and d.status = 'available') then
    return new;
  end if;
  -- A newer processing result supersedes indexing of an older one.
  select id into active from caseflow.search_index_jobs
    where document_id = new.document_id and status in ('queued', 'indexing') for update;
  if active is not null then perform caseflow.end_search_index(active, 'cancelled'); end if;
  perform caseflow.enqueue_search_index(new.document_id, new.id, null, null);
  return new;
end;
$$;
create trigger queue_search_after_processing
  after update of status on caseflow.document_processing_jobs
  for each row when (new.status = 'ready' and old.status is distinct from new.status)
  execute function caseflow.queue_search_after_processing();

create function caseflow.cancel_removed_search_index()
returns trigger language plpgsql security definer set search_path = '' as $$
declare job uuid;
begin
  perform pg_advisory_xact_lock(734921, 1);
  for job in select id from caseflow.search_index_jobs
    where document_id = new.id and status in ('queued', 'indexing') order by id for update
  loop
    perform caseflow.end_search_index(job, 'cancelled');
  end loop;
  return new;
end;
$$;
create trigger cancel_removed_search_index after update of status on caseflow.documents
  for each row when (new.status <> 'available') execute function caseflow.cancel_removed_search_index();

-- Administrators can re-index a document whose latest indexing did not fully complete.
create function caseflow.request_search_index(p_case uuid, p_document uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  actor caseflow.users;
  document caseflow.documents;
  latest caseflow.search_index_jobs;
  processing_id uuid;
  new_id uuid;
begin
  perform pg_advisory_xact_lock(734921, 1);
  actor := caseflow.require_actor();
  if actor.role not in ('admin', 'super_admin') then raise exception 'FORBIDDEN'; end if;
  document := caseflow.require_document(p_case, p_document);
  if document.status <> 'available' then raise exception 'DOCUMENT_UNAVAILABLE'; end if;
  select * into latest from caseflow.search_index_jobs where document_id = p_document
    order by created_at desc, id desc limit 1 for update;
  if latest.status in ('queued', 'indexing', 'ready') then return latest.id; end if;
  select r.job_id into processing_id from caseflow.document_processing_results r
    join caseflow.document_processing_jobs j on j.id = r.job_id
    where j.document_id = p_document and j.status = 'ready'
    order by j.created_at desc, j.id desc limit 1;
  if processing_id is null then raise exception 'DOCUMENT_UNAVAILABLE'; end if;
  new_id := caseflow.enqueue_search_index(p_document, processing_id, actor.id, latest.id);
  insert into caseflow.audit_events(actor_id, target_id, action, after_value)
    values(actor.id, p_document, 'document.search_index_queued', jsonb_build_object(
      'caseId', p_case, 'jobId', new_id, 'processingResultId', processing_id));
  return new_id;
end;
$$;

-- Operator-only: queue indexing for documents processed before search existed.
create function caseflow.enqueue_search_backfill(p_limit integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare item record; queued integer := 0;
begin
  if p_limit is null or p_limit not between 1 and 1000 then raise exception 'INVALID_INPUT'; end if;
  perform pg_advisory_xact_lock(734921, 1);
  for item in select distinct on (j.document_id) j.document_id, j.id as result_id
    from caseflow.document_processing_jobs j
    join caseflow.document_processing_results r on r.job_id = j.id
    join caseflow.documents d on d.id = j.document_id
    where j.status = 'ready' and d.status = 'available'
      and not exists(select 1 from caseflow.search_index_jobs s where s.document_id = j.document_id)
    order by j.document_id, j.created_at desc, j.id desc limit p_limit
  loop
    perform caseflow.enqueue_search_index(item.document_id, item.result_id, null, null);
    queued := queued + 1;
  end loop;
  return queued;
end;
$$;

create function caseflow.claim_search_job(p_job uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  job caseflow.search_index_jobs;
  document caseflow.documents;
  result caseflow.document_processing_results;
begin
  perform pg_advisory_xact_lock(734921, 1);
  select * into job from caseflow.search_index_jobs where id = p_job for update;
  if job.id is null then raise exception 'NOT_FOUND'; end if;
  if job.status not in ('queued', 'indexing') then
    return jsonb_build_object('disposition', 'terminal');
  end if;
  select * into document from caseflow.documents where id = job.document_id;
  if document.status <> 'available' then
    perform caseflow.end_search_index(job.id, 'cancelled');
    return jsonb_build_object('disposition', 'terminal');
  end if;
  if job.lease_expires_at > clock_timestamp() then
    return jsonb_build_object('disposition', 'busy');
  end if;
  if job.attempt_count >= 5 then
    perform caseflow.end_search_index(job.id, 'failed', 'attempts_exhausted');
    return jsonb_build_object('disposition', 'terminal');
  end if;
  update caseflow.search_index_jobs set status = 'indexing', lease_token = gen_random_uuid(),
    lease_expires_at = clock_timestamp() + interval '180 seconds', attempt_count = attempt_count + 1,
    next_check_at = clock_timestamp() + interval '15 minutes', updated_at = clock_timestamp()
    where id = p_job returning * into job;
  select * into result from caseflow.document_processing_results where job_id = job.processing_result_id;
  return jsonb_build_object('disposition', 'claimed', 'jobId', job.id, 'documentId', document.id,
    'caseId', document.case_id, 'processingResultId', result.job_id, 'leaseToken', job.lease_token,
    'model', job.model, 'chunksSaved', job.chunks_saved,
    'source', jsonb_build_object('bucket', result.storage_bucket,
      'key', result.artifacts->'text'->>'key', 'versionId', result.artifacts->'text'->>'versionId',
      'checksumSha256', result.artifacts->'text'->>'checksumSha256',
      'sizeBytes', (result.artifacts->'text'->>'sizeBytes')::integer));
end;
$$;

create function caseflow.require_search_lease(p_job uuid, p_token uuid)
returns caseflow.search_index_jobs language plpgsql security definer set search_path = '' as $$
declare job caseflow.search_index_jobs;
begin
  perform pg_advisory_xact_lock(734921, 1);
  select * into job from caseflow.search_index_jobs where id = p_job for update;
  if job.id is null or job.status <> 'indexing' or job.lease_token is distinct from p_token
    or job.lease_expires_at <= clock_timestamp() or not exists(select 1 from caseflow.documents d
      where d.id = job.document_id and d.status = 'available') then
    raise exception 'SEARCH_INDEX_CONFLICT';
  end if;
  return job;
end;
$$;

create function caseflow.check_search_lease(p_job uuid, p_token uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform caseflow.require_search_lease(p_job, p_token);
  return true;
end;
$$;

-- Replaces the document's chunk set. An empty document is indexed with no chunks.
create function caseflow.save_search_chunks(p_job uuid, p_token uuid, p_chunks jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  job caseflow.search_index_jobs;
  document caseflow.documents;
  chunk jsonb;
  saved integer := 0;
begin
  job := caseflow.require_search_lease(p_job, p_token);
  if jsonb_typeof(p_chunks) is distinct from 'array' or jsonb_array_length(p_chunks) > 500
    or octet_length(p_chunks::text) > 4000000 then raise exception 'INVALID_INPUT'; end if;
  select * into document from caseflow.documents where id = job.document_id;
  delete from caseflow.document_text_chunks where document_id = job.document_id;
  for chunk in select value from jsonb_array_elements(p_chunks) loop
    if jsonb_typeof(chunk->'page') is distinct from 'number'
      or jsonb_typeof(chunk->'start') is distinct from 'number'
      or jsonb_typeof(chunk->'text') is distinct from 'string' then raise exception 'INVALID_INPUT'; end if;
    insert into caseflow.document_text_chunks(job_id, document_id, case_id, processing_result_id,
      chunk_index, page, start_offset, end_offset, content)
    values(job.id, job.document_id, document.case_id, job.processing_result_id, saved,
      (chunk->>'page')::integer, (chunk->>'start')::integer,
      (chunk->>'start')::integer + length(chunk->>'text'), chunk->>'text');
    saved := saved + 1;
  end loop;
  update caseflow.search_index_jobs set chunk_count = saved, embedded_count = 0, chunks_saved = true,
    updated_at = clock_timestamp() where id = p_job returning * into job;
  if saved = 0 then
    update caseflow.search_index_jobs set status = 'ready', lease_token = null, lease_expires_at = null,
      finished_at = clock_timestamp(), updated_at = clock_timestamp() where id = p_job;
  end if;
end;
$$;

create function caseflow.pending_search_chunks(p_job uuid, p_token uuid, p_limit integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare job caseflow.search_index_jobs;
begin
  job := caseflow.require_search_lease(p_job, p_token);
  if p_limit is null or p_limit not between 1 and 100 then raise exception 'INVALID_INPUT'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'text', c.content) order by c.chunk_index)
    from (select id, content, chunk_index from caseflow.document_text_chunks
      where job_id = job.id and embedding is null order by chunk_index limit p_limit) c), '[]'::jsonb);
end;
$$;

create function caseflow.reserve_search_usage(p_job uuid, p_token uuid, p_input integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  job caseflow.search_index_jobs;
  price caseflow.search_model_prices;
  today date := (clock_timestamp() at time zone 'UTC')::date;
  amount bigint;
  reservation uuid;
begin
  job := caseflow.require_search_lease(p_job, p_token);
  if p_input is null or p_input not between 1 and 200000 then raise exception 'INVALID_INPUT'; end if;
  select * into price from caseflow.search_model_prices
    where version = job.pricing_version and model = job.model;
  if price.version is null then raise exception 'SERVICE_UNAVAILABLE'; end if;
  amount := p_input * price.input_nanodollars;
  insert into caseflow.fact_daily_usage(day) values(today) on conflict do nothing;
  update caseflow.fact_daily_usage set committed_nanodollars = committed_nanodollars + amount
    where day = today and committed_nanodollars + amount <= 1000000000;
  if not found then
    perform caseflow.end_search_index(job.id, 'failed', 'budget_exceeded');
    return jsonb_build_object('allowed', false);
  end if;
  insert into caseflow.search_usage_reservations(job_id, day, pricing_version, input_tokens,
    reserved_nanodollars) values(job.id, today, price.version, p_input, amount) returning id into reservation;
  return jsonb_build_object('allowed', true, 'reservationId', reservation);
end;
$$;

-- Settlement remains possible after cancellation; it cannot publish data or renew a lease.
create function caseflow.settle_search_usage(p_reservation uuid, p_input integer)
returns void language plpgsql security definer set search_path = '' as $$
declare reservation caseflow.search_usage_reservations; price caseflow.search_model_prices; actual bigint;
begin
  select * into reservation from caseflow.search_usage_reservations where id = p_reservation for update;
  if reservation.id is null then raise exception 'NOT_FOUND'; end if;
  if p_input is null or p_input < 0 then raise exception 'INVALID_INPUT'; end if;
  select * into price from caseflow.search_model_prices where version = reservation.pricing_version;
  actual := p_input * price.input_nanodollars;
  if actual > reservation.reserved_nanodollars then raise exception 'INVALID_INPUT'; end if;
  if reservation.settled_at is not null then
    if actual <> reservation.actual_nanodollars then raise exception 'INVALID_INPUT'; end if;
    return;
  end if;
  update caseflow.fact_daily_usage set committed_nanodollars = committed_nanodollars -
    reservation.reserved_nanodollars + actual where day = reservation.day;
  update caseflow.search_usage_reservations set actual_nanodollars = actual, settled_at = clock_timestamp()
    where id = p_reservation;
end;
$$;

create function caseflow.save_search_embeddings(p_job uuid, p_token uuid, p_embeddings jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare job caseflow.search_index_jobs; item jsonb; total integer;
begin
  job := caseflow.require_search_lease(p_job, p_token);
  if jsonb_typeof(p_embeddings) is distinct from 'array'
    or jsonb_array_length(p_embeddings) not between 1 and 100 then raise exception 'INVALID_INPUT'; end if;
  for item in select value from jsonb_array_elements(p_embeddings) loop
    if jsonb_typeof(item->'embedding') is distinct from 'array'
      or jsonb_array_length(item->'embedding') <> 1536 then raise exception 'INVALID_INPUT'; end if;
    update caseflow.document_text_chunks set embedding = (item->'embedding')::text::extensions.vector
      where id = (item->>'id')::uuid and job_id = job.id and embedding is null;
    if not found then raise exception 'INVALID_INPUT'; end if;
  end loop;
  select count(*) into total from caseflow.document_text_chunks where job_id = job.id and embedding is not null;
  if total = job.chunk_count then
    update caseflow.search_index_jobs set embedded_count = total, status = 'ready', lease_token = null,
      lease_expires_at = null, updated_at = clock_timestamp(), finished_at = clock_timestamp()
      where id = job.id;
    return jsonb_build_object('complete', true);
  end if;
  update caseflow.search_index_jobs set embedded_count = total, updated_at = clock_timestamp(),
    lease_expires_at = clock_timestamp() + interval '180 seconds' where id = job.id;
  return jsonb_build_object('complete', false);
end;
$$;

create function caseflow.retry_search_job(p_job uuid, p_token uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare job caseflow.search_index_jobs;
begin
  job := caseflow.require_search_lease(p_job, p_token);
  if job.attempt_count >= 5 then
    perform caseflow.end_search_index(job.id, 'failed', 'attempts_exhausted');
    return;
  end if;
  update caseflow.search_index_jobs set lease_token = null, lease_expires_at = null,
    updated_at = clock_timestamp(), next_check_at = clock_timestamp() + interval '15 minutes'
    where id = p_job;
  update caseflow.search_dispatches set status = 'pending', message_id = null, sent_at = null,
    lease_token = null, lease_expires_at = null,
    available_at = clock_timestamp() + make_interval(secs => 15 * power(2, job.attempt_count)::integer)
    where job_id = p_job;
end;
$$;

create function caseflow.fail_search_job(p_job uuid, p_token uuid, p_failure text)
returns void language plpgsql security definer set search_path = '' as $$
declare job caseflow.search_index_jobs;
begin
  job := caseflow.require_search_lease(p_job, p_token);
  perform caseflow.end_search_index(job.id, 'failed', p_failure);
end;
$$;

create function caseflow.claim_search_dispatches(p_limit integer)
returns table(dispatch_id uuid, job_id uuid, lease_token uuid, lease_expires_at timestamptz, attempt_count integer)
language plpgsql security definer set search_path = '' as $$
begin
  if p_limit is null or p_limit not between 1 and 25 then raise exception 'INVALID_INPUT'; end if;
  return query with candidates as (
    select d.id from caseflow.search_dispatches d join caseflow.search_index_jobs j on j.id = d.job_id
    where j.status in ('queued', 'indexing')
      and (j.lease_expires_at is null or j.lease_expires_at <= clock_timestamp()) and
      ((d.status = 'pending' and d.available_at <= clock_timestamp()) or
       (d.status = 'leased' and d.lease_expires_at <= clock_timestamp()))
    order by d.available_at, d.id limit p_limit for update of d skip locked
  ) update caseflow.search_dispatches d set status = 'leased', lease_token = gen_random_uuid(),
    lease_expires_at = clock_timestamp() + interval '60 seconds', attempt_count = d.attempt_count + 1
    from candidates c where d.id = c.id
    returning d.id, d.job_id, d.lease_token, d.lease_expires_at, d.attempt_count;
end;
$$;

create function caseflow.finish_search_dispatch(p_dispatch uuid, p_token uuid, p_message text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_message is null or length(p_message) not between 1 and 128 or p_message ~ '[[:cntrl:]]' then
    raise exception 'INVALID_INPUT';
  end if;
  update caseflow.search_dispatches set status = 'sent', message_id = p_message, sent_at = clock_timestamp(),
    lease_token = null, lease_expires_at = null where id = p_dispatch and status = 'leased'
    and lease_token = p_token and lease_expires_at > clock_timestamp();
  return found;
end;
$$;

create function caseflow.retry_search_dispatch(p_dispatch uuid, p_token uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update caseflow.search_dispatches set status = 'pending', available_at = clock_timestamp() + interval '30 seconds',
    lease_token = null, lease_expires_at = null where id = p_dispatch and status = 'leased'
    and lease_token = p_token and lease_expires_at > clock_timestamp();
  return found;
end;
$$;

create function caseflow.recover_search_jobs(p_limit integer, p_bucket text, p_environment text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare job caseflow.search_index_jobs; recovered integer := 0; failed integer := 0;
begin
  if p_limit is null or p_limit not between 1 and 25 then raise exception 'INVALID_INPUT'; end if;
  perform pg_advisory_xact_lock(734921, 1);
  for job in select s.* from caseflow.search_index_jobs s
    join caseflow.documents d on d.id = s.document_id
    where d.storage_bucket = p_bucket and d.storage_environment = p_environment
      and s.status in ('queued', 'indexing') and s.next_check_at <= clock_timestamp()
      and (s.lease_expires_at is null or s.lease_expires_at <= clock_timestamp())
    order by s.next_check_at, s.id limit p_limit for update of s skip locked
  loop
    if not exists(select 1 from caseflow.documents d where d.id = job.document_id and d.status = 'available') then
      perform caseflow.end_search_index(job.id, 'cancelled');
    elsif job.recovery_count >= 3 or job.attempt_count >= 5 then
      perform caseflow.end_search_index(job.id, 'failed', 'attempts_exhausted');
      failed := failed + 1;
    else
      update caseflow.search_index_jobs set lease_token = null, lease_expires_at = null,
        recovery_count = recovery_count + 1, next_check_at = clock_timestamp() + interval '15 minutes',
        updated_at = clock_timestamp() where id = job.id;
      update caseflow.search_dispatches set status = 'pending', available_at = clock_timestamp(),
        lease_token = null, lease_expires_at = null, message_id = null, sent_at = null where job_id = job.id;
      recovered := recovered + 1;
    end if;
  end loop;
  return jsonb_build_object('recovered', recovered, 'failed', failed);
end;
$$;

revoke all on function caseflow.enqueue_search_index(uuid, uuid, uuid, uuid),
  caseflow.end_search_index(uuid, text, text), caseflow.queue_search_after_processing(),
  caseflow.cancel_removed_search_index(), caseflow.request_search_index(uuid, uuid),
  caseflow.enqueue_search_backfill(integer), caseflow.claim_search_job(uuid),
  caseflow.require_search_lease(uuid, uuid), caseflow.check_search_lease(uuid, uuid),
  caseflow.save_search_chunks(uuid, uuid, jsonb), caseflow.pending_search_chunks(uuid, uuid, integer),
  caseflow.reserve_search_usage(uuid, uuid, integer), caseflow.settle_search_usage(uuid, integer),
  caseflow.save_search_embeddings(uuid, uuid, jsonb), caseflow.retry_search_job(uuid, uuid),
  caseflow.fail_search_job(uuid, uuid, text), caseflow.claim_search_dispatches(integer),
  caseflow.finish_search_dispatch(uuid, uuid, text), caseflow.retry_search_dispatch(uuid, uuid),
  caseflow.recover_search_jobs(integer, text, text)
  from public, anon, authenticated, service_role, caseflow_runtime, caseflow_processor, caseflow_dispatcher,
    caseflow_fact_extractor, caseflow_fact_dispatcher, caseflow_search_indexer, caseflow_search_dispatcher,
    caseflow_recovery;
grant execute on function caseflow.request_search_index(uuid, uuid) to caseflow_runtime;
grant execute on function caseflow.claim_search_job(uuid), caseflow.check_search_lease(uuid, uuid),
  caseflow.save_search_chunks(uuid, uuid, jsonb), caseflow.pending_search_chunks(uuid, uuid, integer),
  caseflow.reserve_search_usage(uuid, uuid, integer), caseflow.settle_search_usage(uuid, integer),
  caseflow.save_search_embeddings(uuid, uuid, jsonb), caseflow.retry_search_job(uuid, uuid),
  caseflow.fail_search_job(uuid, uuid, text) to caseflow_search_indexer;
grant execute on function caseflow.claim_search_dispatches(integer),
  caseflow.finish_search_dispatch(uuid, uuid, text), caseflow.retry_search_dispatch(uuid, uuid)
  to caseflow_search_dispatcher;
grant execute on function caseflow.recover_search_jobs(integer, text, text) to caseflow_recovery;
