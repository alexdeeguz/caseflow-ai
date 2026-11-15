create table caseflow.documents (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references caseflow.cases(id),
  uploaded_by uuid not null references caseflow.users(id),
  filename text not null,
  content_type text not null,
  size_bytes bigint not null check (size_bytes between 1 and 26214400),
  status text not null default 'pending_upload',
  version integer not null default 1 check (version > 0),
  storage_bucket text not null,
  storage_environment text not null check (storage_environment ~ '^[a-z][a-z0-9-]{0,31}$'),
  object_key text generated always as (
    storage_environment || '/cases/' || case_id::text || '/documents/' || id::text || '/original/' || filename
  ) stored,
  object_version_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  uploaded_at timestamptz,
  removed_at timestamptz,
  removed_by uuid references caseflow.users(id),

  constraint documents_filename check (
    length(filename) between 1 and 255 and filename = btrim(filename)
    and filename !~ '[[:cntrl:]/\\]'
  ),
  constraint documents_file_type check (
    (content_type = 'application/pdf' and filename ~* '\.pdf$') or
    (content_type = 'image/jpeg' and filename ~* '\.jpe?g$') or
    (content_type = 'image/png' and filename ~* '\.png$')
  ),
  constraint documents_bucket check (
    length(storage_bucket) between 3 and 63
    and storage_bucket ~ '^[a-z0-9][a-z0-9.-]*[a-z0-9]$'
    and storage_bucket !~ '\.\.'
    and storage_bucket !~ '^\d+\.\d+\.\d+\.\d+$'
    and storage_bucket !~ '^(xn--|sthree-|amzn-s3-demo-)'
    and storage_bucket !~ '(-s3alias|--ol-s3|\.mrap|--x-s3|--table-s3)$'
  ),
  constraint documents_status check (status in ('pending_upload', 'available', 'removed')),
  constraint documents_object_version check (
    object_version_id is null or (length(object_version_id) between 1 and 1024 and object_version_id <> 'null')
  ),
  constraint documents_upload_metadata check (
    (status = 'pending_upload' and uploaded_at is null and object_version_id is null) or
    (status in ('available', 'removed') and uploaded_at is not null and object_version_id is not null)
  ),
  constraint documents_removal_metadata check (
    (status = 'removed' and removed_at is not null and removed_by is not null) or
    (status <> 'removed' and removed_at is null and removed_by is null)
  ),
  constraint documents_timestamps check (
    updated_at >= created_at and uploaded_at >= created_at and removed_at >= uploaded_at
  ),
  constraint documents_object_unique unique (storage_bucket, object_key)
);

create index documents_case_newest on caseflow.documents(case_id, created_at desc, id desc);
create index documents_case_status_newest on caseflow.documents(case_id, status, created_at desc, id desc);
create index documents_uploader on caseflow.documents(uploaded_by);
create index documents_remover on caseflow.documents(removed_by) where removed_by is not null;

-- A fresh attempt gets a fresh document/key. Re-signing a pending session keeps its original expiry.
create table caseflow.document_upload_sessions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null unique references caseflow.documents(id),
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  finished_at timestamptz,
  failure_code text,

  constraint upload_sessions_status check (status in ('pending', 'completed', 'failed', 'expired', 'cancelled')),
  constraint upload_sessions_expiry check (expires_at > created_at and expires_at <= created_at + interval '5 minutes'),
  constraint upload_sessions_finished check (
    (status = 'pending' and finished_at is null) or
    (status <> 'pending' and finished_at is not null and finished_at >= created_at)
  ),
  constraint upload_sessions_failure check (
    (status = 'failed' and failure_code is not null and failure_code in ('verification_failed', 'storage_unavailable')) or
    (status <> 'failed' and failure_code is null)
  ),
  constraint upload_sessions_expired check (status <> 'expired' or finished_at >= expires_at)
);

create index upload_sessions_pending_expiry on caseflow.document_upload_sessions(expires_at, id)
  where status = 'pending';

alter table caseflow.documents enable row level security;
alter table caseflow.document_upload_sessions enable row level security;

-- The cases subquery uses the existing RLS policy, including assignments and active-account checks.
create policy read_documents on caseflow.documents for select to caseflow_runtime
using (
  exists (select 1 from caseflow.cases c where c.id = documents.case_id)
  and (
    caseflow.is_admin() or status = 'available'
    or (status = 'pending_upload' and uploaded_by = (caseflow.actor()).id)
  )
);

create policy read_upload_sessions on caseflow.document_upload_sessions for select to caseflow_runtime
using (
  exists (
    select 1 from caseflow.documents d where d.id = document_upload_sessions.document_id
      and (caseflow.is_admin() or d.uploaded_by = (caseflow.actor()).id)
  )
);

revoke all on caseflow.documents, caseflow.document_upload_sessions
  from public, anon, authenticated, service_role, caseflow_runtime;
grant select on caseflow.documents, caseflow.document_upload_sessions to caseflow_runtime;
