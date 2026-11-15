-- Serialize permission-sensitive document changes with existing case and user mutations.
create function caseflow.require_document(p_case uuid, p_document uuid)
returns caseflow.documents
language plpgsql security definer set search_path = '' as $$
declare
  actor caseflow.users;
  target_case caseflow.cases;
  document caseflow.documents;
begin
  perform pg_advisory_xact_lock(734921, 1);
  actor := caseflow.require_actor();

  select * into target_case from caseflow.cases where id = p_case for update;
  if target_case.id is null or (actor.role = 'staff' and not exists (
    select 1 from caseflow.assignments where case_id = p_case and user_id = actor.id
  )) then
    raise exception 'NOT_FOUND';
  end if;

  select * into document from caseflow.documents
    where id = p_document and case_id = p_case for update;
  if document.id is null or (actor.role = 'staff' and (
    document.status = 'removed'
    or (document.status = 'pending_upload' and document.uploaded_by <> actor.id)
  )) then
    raise exception 'NOT_FOUND';
  end if;

  return document;
end;
$$;

create function caseflow.authorize_document_download(
  p_case uuid, p_document uuid, p_expected_version integer, p_expires_at timestamptz
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  actor caseflow.users;
  document caseflow.documents;
  authorized_at timestamptz;
begin
  document := caseflow.require_document(p_case, p_document);
  actor := caseflow.require_actor();
  if p_expected_version is null or p_expected_version < 1 or p_expires_at is null then
    raise exception 'INVALID_INPUT';
  end if;
  if document.status <> 'available' then
    raise exception 'DOCUMENT_UNAVAILABLE';
  end if;
  if document.version <> p_expected_version then
    raise exception 'DOCUMENT_CONFLICT';
  end if;

  authorized_at := clock_timestamp();
  if p_expires_at <= authorized_at then
    raise exception 'SERVICE_UNAVAILABLE';
  end if;
  if p_expires_at > authorized_at + interval '60 seconds' then
    raise exception 'INVALID_INPUT';
  end if;

  insert into caseflow.audit_events(actor_id, target_id, action, after_value)
  values (actor.id, document.id, 'document.download_authorized', jsonb_build_object(
    'caseId', document.case_id, 'version', document.version, 'expiresAt', p_expires_at));
end;
$$;

create function caseflow.set_document_removed(
  p_case uuid, p_document uuid, p_expected_version integer, p_removed boolean
) returns caseflow.documents
language plpgsql security definer set search_path = '' as $$
declare
  actor caseflow.users;
  previous caseflow.documents;
  changed caseflow.documents;
  changed_at timestamptz;
begin
  perform pg_advisory_xact_lock(734921, 1);
  actor := caseflow.require_actor();
  if actor.role not in ('admin', 'super_admin') then
    raise exception 'FORBIDDEN';
  end if;
  if p_expected_version is null or p_expected_version < 1 or p_removed is null then
    raise exception 'INVALID_INPUT';
  end if;

  previous := caseflow.require_document(p_case, p_document);
  if exists(select 1 from caseflow.cases where id = p_case and archived_at is not null) then
    raise exception 'CASE_ARCHIVED';
  end if;
  if previous.version <> p_expected_version then
    raise exception 'DOCUMENT_CONFLICT';
  end if;
  if previous.status = 'pending_upload' then
    raise exception 'DOCUMENT_UNAVAILABLE';
  end if;
  if (previous.status = 'removed') = p_removed then
    return previous;
  end if;

  changed_at := clock_timestamp();
  update caseflow.documents set
    status = case when p_removed then 'removed' else 'available' end,
    removed_at = case when p_removed then changed_at else null end,
    removed_by = case when p_removed then actor.id else null end,
    version = previous.version + 1,
    updated_at = changed_at
  where id = previous.id returning * into changed;

  insert into caseflow.audit_events(actor_id, target_id, action, before_value, after_value)
  values (actor.id, changed.id, case when p_removed then 'document.removed' else 'document.restored' end,
    jsonb_build_object('caseId', previous.case_id, 'status', previous.status,
      'removedAt', previous.removed_at, 'removedBy', previous.removed_by, 'version', previous.version),
    jsonb_build_object('caseId', changed.case_id, 'status', changed.status,
      'removedAt', changed.removed_at, 'removedBy', changed.removed_by, 'version', changed.version));

  return changed;
end;
$$;

revoke all on function caseflow.require_document(uuid, uuid),
  caseflow.authorize_document_download(uuid, uuid, integer, timestamptz),
  caseflow.set_document_removed(uuid, uuid, integer, boolean)
  from public, anon, authenticated, service_role, caseflow_runtime;
grant execute on function caseflow.authorize_document_download(uuid, uuid, integer, timestamptz),
  caseflow.set_document_removed(uuid, uuid, integer, boolean)
  to caseflow_runtime;
