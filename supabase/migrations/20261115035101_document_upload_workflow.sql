alter table caseflow.documents
  add column upload_request_id uuid,
  add column checksum_sha256 text,
  add constraint documents_upload_request_unique unique (uploaded_by, upload_request_id),
  add constraint documents_checksum check (
    (upload_request_id is null and checksum_sha256 is null) or
    (upload_request_id is not null and checksum_sha256 is not null
      and checksum_sha256 ~ '^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$')
  );

-- Reuse the permission lock so assignment, role, archive and quota writes serialize.
-- No network calls run while this transaction is open.
create function caseflow.require_upload_case(p_case uuid) returns caseflow.users
language plpgsql security definer set search_path = '' as $$
declare
  actor caseflow.users;
  target caseflow.cases;
begin
  perform pg_advisory_xact_lock(734921, 1);
  actor := caseflow.require_actor();
  select * into target from caseflow.cases where id = p_case for update;
  if target.id is null or (actor.role = 'staff' and not exists (
    select 1 from caseflow.assignments where case_id = p_case and user_id = actor.id
  )) then
    raise exception 'NOT_FOUND';
  end if;
  if target.archived_at is not null then raise exception 'CASE_ARCHIVED'; end if;
  return actor;
end;
$$;

create function caseflow.check_document_upload(p_case uuid, p_session uuid)
returns caseflow.document_upload_sessions
language plpgsql security definer set search_path = '' as $$
declare
  actor caseflow.users;
  document caseflow.documents;
  session caseflow.document_upload_sessions;
begin
  actor := caseflow.require_upload_case(p_case);
  select * into session from caseflow.document_upload_sessions where id = p_session for update;
  select * into document from caseflow.documents where id = session.document_id for update;
  if document.id is null or document.case_id <> p_case
    or (actor.role = 'staff' and document.uploaded_by <> actor.id) then
    raise exception 'NOT_FOUND';
  end if;
  if document.checksum_sha256 is null then raise exception 'UPLOAD_CONFLICT'; end if;

  if session.status = 'pending' and session.expires_at <= clock_timestamp() then
    update caseflow.document_upload_sessions set status = 'expired', finished_at = clock_timestamp()
      where id = session.id returning * into session;
  end if;
  return session;
end;
$$;

create function caseflow.start_document_upload(
  p_case uuid, p_request uuid, p_filename text, p_type text, p_size bigint,
  p_checksum text, p_bucket text, p_environment text
) returns caseflow.document_upload_sessions
language plpgsql security definer set search_path = '' as $$
declare
  actor caseflow.users;
  document caseflow.documents;
  session caseflow.document_upload_sessions;
  reserved bigint;
  started timestamptz;
begin
  actor := caseflow.require_upload_case(p_case);
  if p_request is null or p_checksum is null
    or p_checksum !~ '^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$'
    or p_size is null or p_size not between 1 and 26214400
    or p_filename is null or p_type is null or p_bucket is null or p_environment is null then
    raise exception 'INVALID_INPUT';
  end if;

  select * into document from caseflow.documents
    where uploaded_by = actor.id and upload_request_id = p_request;
  if found then
    if (document.case_id, document.filename, document.content_type, document.size_bytes,
        document.checksum_sha256, document.storage_bucket, document.storage_environment)
      is distinct from (p_case, p_filename, p_type, p_size, p_checksum, p_bucket, p_environment) then
      raise exception 'UPLOAD_CONFLICT';
    end if;
    select * into session from caseflow.document_upload_sessions where document_id = document.id;
    return caseflow.check_document_upload(p_case, session.id);
  end if;

  -- Retain reservations for failed/expired uploads until verified object cleanup.
  -- A still-valid signed request can finish after a session becomes terminal.
  select coalesce(sum(size_bytes), 0) into reserved from caseflow.documents;
  if reserved + p_size > 1073741824 then raise exception 'STORAGE_QUOTA_EXCEEDED'; end if;

  started := clock_timestamp();
  insert into caseflow.documents(case_id, uploaded_by, filename, content_type, size_bytes,
    storage_bucket, storage_environment, upload_request_id, checksum_sha256, created_at, updated_at)
  values (p_case, actor.id, p_filename, p_type, p_size, p_bucket, p_environment, p_request,
    p_checksum, started, started) returning * into document;
  insert into caseflow.document_upload_sessions(document_id, created_at, expires_at)
  values (document.id, started, started + interval '5 minutes') returning * into session;
  insert into caseflow.audit_events(actor_id, target_id, action, after_value)
  values (actor.id, document.id, 'document.upload_started', jsonb_build_object(
    'caseId', p_case, 'sessionId', session.id, 'filename', document.filename,
    'contentType', document.content_type, 'sizeBytes', document.size_bytes, 'status', document.status));
  return session;
end;
$$;

create function caseflow.complete_document_upload(p_case uuid, p_session uuid, p_object_version text)
returns caseflow.document_upload_sessions
language plpgsql security definer set search_path = '' as $$
declare
  actor caseflow.users;
  session caseflow.document_upload_sessions;
  document caseflow.documents;
  finished timestamptz;
begin
  session := caseflow.check_document_upload(p_case, p_session);
  if session.status <> 'pending' then return session; end if;
  actor := caseflow.require_actor();
  if p_object_version is null or length(p_object_version) not between 1 and 1024
    or p_object_version = 'null' then raise exception 'INVALID_INPUT'; end if;

  finished := clock_timestamp();
  update caseflow.documents set status = 'available', object_version_id = p_object_version,
    uploaded_at = finished, updated_at = finished, version = version + 1
    where id = session.document_id and status = 'pending_upload' returning * into document;
  if not found then raise exception 'UPLOAD_CONFLICT'; end if;
  update caseflow.document_upload_sessions set status = 'completed', finished_at = finished
    where id = session.id returning * into session;
  insert into caseflow.audit_events(actor_id, target_id, action, before_value, after_value)
  values (actor.id, document.id, 'document.uploaded', jsonb_build_object('status', 'pending_upload'),
    jsonb_build_object('caseId', p_case, 'sessionId', session.id, 'status', document.status,
      'filename', document.filename, 'contentType', document.content_type,
      'sizeBytes', document.size_bytes, 'version', document.version));
  return session;
end;
$$;

create function caseflow.fail_document_upload(p_case uuid, p_session uuid)
returns caseflow.document_upload_sessions
language plpgsql security definer set search_path = '' as $$
declare session caseflow.document_upload_sessions;
begin
  session := caseflow.check_document_upload(p_case, p_session);
  if session.status = 'pending' then
    update caseflow.document_upload_sessions set status = 'failed',
      finished_at = clock_timestamp(), failure_code = 'verification_failed'
      where id = session.id returning * into session;
  end if;
  return session;
end;
$$;

revoke all on function caseflow.require_upload_case(uuid),
  caseflow.check_document_upload(uuid, uuid),
  caseflow.start_document_upload(uuid, uuid, text, text, bigint, text, text, text),
  caseflow.complete_document_upload(uuid, uuid, text), caseflow.fail_document_upload(uuid, uuid)
  from public, anon, authenticated, service_role, caseflow_runtime;
grant execute on function caseflow.check_document_upload(uuid, uuid),
  caseflow.start_document_upload(uuid, uuid, text, text, bigint, text, text, text),
  caseflow.complete_document_upload(uuid, uuid, text), caseflow.fail_document_upload(uuid, uuid)
  to caseflow_runtime;
