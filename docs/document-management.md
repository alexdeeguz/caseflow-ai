# Document management

[Back to README](../README.md)

Storage configuration, the upload protocol, library behavior, and document lifecycle rules.

- [Configuration](#configuration)
- [Upload protocol](#upload-protocol)
- [Library interface](#document-library-interface)
- [Listing and downloads](#document-listing-and-downloads)
- [Removal and restoration](#document-removal-and-restoration)
- [Verification and consistency](#verification-and-consistency)

The API supports upload authorization, verified completion, paginated document listing,
short-lived downloads, and administrative removal/restoration. The case document UI
supports these workflows. File previews and background processing remain later work.

Storage configuration and S3 adapters live in `apps/api/src/storage`. Upload and download
orchestration live in `src/documents`, HTTP definitions in
`src/routes/documents.ts`, and database queries in `src/database/documents.ts`.
Shared contracts and limits live in `packages/schemas`. Install dependencies with
`npm install` and apply additive migrations with `npm run db:migrate`.

## Configuration

Configure these values only in the ignored `apps/api/.env`:

```dotenv
S3_BUCKET=your-private-document-bucket
AWS_REGION=us-east-2
S3_ENVIRONMENT=dev
AWS_PROFILE=caseflow-api-dev
```

`AWS_PROFILE` selects a restricted local assume-role profile outside the repository.
It takes precedence over ambient access keys. Refresh its source login with
`aws login --profile <source-profile>`. For deployment, omit `AWS_PROFILE` and
configure temporary workload credentials supported by the SDK's default chain.
Keep credentials and storage configuration out of frontend environment variables.

When both S3-specific settings are absent, storage is disabled; existing features
remain available, including document listing and removal/restoration. Upload endpoints
return 503 after checking case access; download authorization returns 503 after checking
document access and availability.
Partial settings fail startup. Restart the API after changing its environment.
The shared client uses bounded retries, timeouts, and sockets and closes with Fastify.

The bucket must remain private, enforce HTTPS, disable ACLs, use encryption, and
have versioning enabled. The runtime role needs `s3:PutObject`, `s3:GetObject`, and
`s3:GetObjectVersion` on the environment's original-document prefix. It does not
need bucket administration, listing, or deletion. Missing objects can therefore
return S3 403; completion treats unavailable objects as retryable rather than
claiming a file failed validation.

Browser CORS must allow the intended frontend origin, `PUT`, and the request headers
`Content-Type`, `If-None-Match`, and `x-amz-checksum-sha256`. A matching wildcard
header rule also works. Completion obtains the S3 version server-side, so the
browser does not need to read or submit S3 version headers.

## Upload protocol

1. Compute the raw file's SHA-256 digest, encode it as canonical base64, and generate
   a UUID request ID. Reuse that ID and metadata for retries of the same attempt.
2. Call `POST /cases/:caseId/document-uploads` with a Microsoft bearer token and JSON:

   ```json
   {
     "requestId": "10000000-0000-4000-8000-000000000001",
     "filename": "fictional-record.pdf",
     "contentType": "application/pdf",
     "sizeBytes": 1234,
     "checksumSha256": "<base64 SHA-256 of the exact file bytes>"
   }
   ```

   The 201 response contains `document`, `session`, and `upload` (method, URL,
   required headers, expiry). The API generates storage identifiers. Repeating an
   identical request returns the same session without extending its five-minute
   lifetime or duplicating its audit event. Changed metadata with the same request
   ID returns `UPLOAD_CONFLICT`. An already completed request returns `upload: null`.

3. Send the raw File/Blob to `upload.url` using `PUT` and exactly `upload.headers`.
   Do not use FormData or send the Microsoft bearer token to S3. The browser supplies
   Content-Length from the body; scripts cannot set that header themselves. The
   signature binds the exact size, type, checksum, key, and `If-None-Match: *`.
   A successful first upload cannot be overwritten with the same authorization.
   If a PUT response is lost or a retry returns 412, call completion to verify the
   existing object before deciding whether to start another attempt.
4. Call `POST /cases/:caseId/document-uploads/:sessionId/complete` with the bearer
   token and `{}`. A 200 response contains the available document and completed
   session. Retries return the current saved metadata without another S3 read or audit.
   If subsequently removed, the document is hidden from Staff retries; administrators
   can still read its removed metadata. Retrying completion never restores a document.

Staff may upload to assigned, current cases. Admin/Super Admin may upload to all
current cases and complete uploads for those cases. Staff may only complete their
own sessions. Disabled/unprovisioned users and inaccessible case/session IDs are
rejected. Archived cases reject uploads and completion.

## Document library interface

Open a case and select **Documents** to browse its verified files. The library has a
desktop table, responsive cards, expandable file metadata, and paginated results.
Admin/Super Admin users can switch between Current, Removed, and All. Staff see only
current documents on assigned cases. Archived cases retain library access.

The case section, document filter, and document page are stored in `section`,
`documentFilter`, and `documentPage` URL parameters independently of case-list filters
and pagination. Bookmarks, refresh, and Back/Forward preserve the selected view.
Protected resources are revalidated on navigation; rejected access clears the case
view. An empty library contains no verified files for that view; failed or pending
upload attempts do not appear in the library.

Select **Upload files** to choose or drop PDF, JPEG, and PNG files. Review the selection
before uploading. Validation rejects empty files, unsupported types/extensions, unsafe
names, and files over 25 MiB. A selection supports up to ten files; the workspace queue
also retains at most ten unfinished files. Two full upload pipelines run concurrently,
including checksum preparation, authorization, transfer, and server verification.
Progress reports transferred bytes; **Verifying** is a separate stage before availability.

The in-memory queue continues across tabs and cases within the current workspace.
Each entry retains its original case. Files, session state, and signed URLs are never
persisted in browser storage or URLs. Refresh/closing warns while work remains, but
uploads cannot resume across a reload. Sign-out, user/role changes, and rejected access
abort and clear the affected queue. Completed entries release their File references.

**Stop upload** stops local preparation or transfer; it is unavailable once server
verification begins. It does not delete received bytes, cancel the server session, or
reclaim reserved storage. **Retry** reuses the request/session identity and reconciles
ambiguous transfer/completion responses before resending bytes. Terminal or expired
attempts offer an explicit **New attempt**. Their original reservations remain retained.

**Download** requests a fresh authorization for the saved object version, then hands the
attachment to the browser. The notification confirms the request, not a completed
download. Admin/Super Admin users can remove a current document through a filename-specific
confirmation modal, or restore it from Removed/All. These actions use the displayed
version; conflicts refresh the library and require review before another action.
Archived cases keep download access but hide upload/remove/restore controls.

Success feedback uses workspace toasts; per-file failures remain in the queue.
Document changes invalidate the affected library and audit queries. Storage-related API
requests have a bounded 60-second timeout; ordinary API requests retain their 10-second
timeout. Frontend document components and state/transport helpers live in
`apps/web/components/workspace/documents` and `apps/web/lib/documents`.
The browser uses no AWS credentials. File previews remain outside this implementation.

## Document listing and downloads

| Endpoint                                             | Input                                         | Response                            |
| ---------------------------------------------------- | --------------------------------------------- | ----------------------------------- |
| `GET /cases/:caseId/documents`                       | `page`, `pageSize`, `filter` query parameters | `{ items, total, page, pageSize }`  |
| `POST /cases/:caseId/documents/:documentId/download` | `{}`                                          | `{ method: "GET", url, expiresAt }` |
| `POST /cases/:caseId/documents/:documentId/remove`   | `{ expectedVersion }`                         | Updated document                    |
| `POST /cases/:caseId/documents/:documentId/restore`  | `{ expectedVersion }`                         | Updated document                    |

All four endpoints return 200 on success and require a Microsoft bearer token.
Unknown fields, client-selected storage locations, and malformed identifiers are rejected.
Metadata responses omit bucket, key, checksum, and S3 version identifiers. A signed
URL necessarily contains its storage destination and must be treated as a credential.

Listing defaults to page 1, 25 items (maximum 100), and `filter=current`.
Current includes verified available files; `removed` includes removed files; `all`
combines them. Pending, failed, expired, and cancelled upload attempts are excluded.
Staff only see available documents on assigned cases; removed rows and counts remain
hidden even with `all`, and their `removed` results are empty. Administrators see all
permitted lifecycle states. Ordering is creation time descending, then document ID
descending. Visibility, counts, and page rows share one database snapshot. Inaccessible
cases return 404 rather than an empty page. Archived-case reads remain available.

Downloads require an available document. The API checks the saved S3 object version,
signs that exact version for at most 60 seconds, then rechecks current access, status,
and document version under the permission lock before returning the URL. Storage work
runs outside database transactions. Files download as attachments with encoded original
filenames, validated content types, and `Cache-Control: private, no-store`.
Use the returned GET URL directly without a Microsoft bearer token. There is no fallback
to a newer S3 object version. Storage/signing failures return safe 503 responses.

A successful authorization commits `document.download_authorized` with the actor,
document, case, document version, and expiry. It records permission to download, not
proof of a completed transfer. Signed URLs and credentials are never included in audit
records. Removed files require restoration before a new link can be issued. Invisible
or mismatched IDs return 404; visible unavailable documents return `409 DOCUMENT_UNAVAILABLE`.

Removal, disablement, or assignment revocation blocks new authorizations. Previously
issued links may remain usable until their short expiry, and a transfer started before
expiry may finish afterward. Downloaded files cannot be recalled. Neither S3 tag-based
revocation nor API file streaming is implemented.

## Document removal and restoration

Only active Admin/Super Admin users can remove or restore documents on current cases.
Restore an archived case first. Removal changes available documents to removed and stores
the actor/time; restoration clears the current removal fields and makes the same saved
version available again. Files, upload sessions, original metadata, assignments, and
history are preserved. Neither action copies or deletes S3 objects or releases quota.

Both actions require the current positive integer `expectedVersion`. They lock the case
and document, recheck administrative access, and atomically commit the state change with
`document.removed` or `document.restored` audit history. Changed records increment version
and update time. Stale requests return `409 DOCUMENT_CONFLICT`, even if the requested
state already matches. A matching-version no-op leaves timestamps, version, and audit
history unchanged. Pending documents return `409 DOCUMENT_UNAVAILABLE`; archived cases
return `409 CASE_ARCHIVED`.

Apply the additive migration with `npm run db:migrate` before running the updated API.
It adds private permission-checked functions and preserves existing data, indexes, and
RLS policies. It does not reset the database, seed documents, or grant direct runtime writes.

## Verification and consistency

Before availability, the server reads S3 metadata, requires a non-null object
version, and streams that exact version. It validates the complete byte count and
SHA-256 checksum and checks the binary signature against PDF/JPEG/PNG. Streams
have a 30-second deadline, four concurrent verifications per API process, and a
bounded signature buffer. Bodies are consumed or destroyed on every path. Binary
signature detection does not establish that a document is safe or fully parseable;
malware scanning and document parsing are separate processing concerns.

No S3 call runs inside a database transaction. Narrow private functions acquire the
existing permission lock and recheck active status, current assignments/role,
archive state, and session expiry before writes. Document/session changes and
upload-started/completed audit events commit atomically. The runtime database role
retains no direct table-write privileges; application tables remain outside the
Supabase Data API with RLS-controlled reads.

- Allowed files: PDF/JPEG/PNG, 1 byte through 25 MiB. Unknown fields, unsafe filenames,
  mismatched extensions/types, and client-supplied storage fields are rejected.
- The shared workspace reserves up to 1 GiB under the transaction lock. Pending,
  completed, removed, failed, and expired records all count until verified object
  cleanup is implemented. Expiry alone does not prove an issued upload failed to
  reach S3, so reservations are deliberately retained. This is an application quota,
  not an AWS billing limit.
- Expired sessions are marked when accessed. Invalid bytes produce a terminal
  `UPLOAD_VERIFICATION_FAILED` (422); start a fresh attempt with a new request ID.
  Expired/conflicting sessions and quota exhaustion return distinct 409 codes.
  Temporary storage/signing errors return safe 503 messages and remain retryable.
- Access is rechecked after signing and before finalization. An already-issued S3
  URL remains valid until its short expiry; it cannot grant application visibility
  after access is revoked. Signed URLs must be treated as temporary credentials.
- Original keys follow
  `{environment}/cases/{case-id}/documents/{document-id}/original/{filename}`.
  Availability pins a version; removal/restoration preserve that version. Processed
  outputs remain later work.
- The UI enforces ten files per selection, ten unfinished queue entries, and two
  concurrent upload pipelines. Local transfer stopping is supported; server-side
  cancellation, scheduled expiry, orphan cleanup, and quota reclamation remain
  later work. Do not release reservations by deleting metadata manually.

Unit tests exercise upload signing restrictions, byte verification, safe failures,
and client shutdown. PostgreSQL integration tests use disposable databases for
permissions, idempotency, quota races, role/assignment/archive races, atomic audit
rollback, restricted runtime access, and migration preservation. They do not reset
the working database or require live S3 credentials.

## Related guides

- [Users and cases](users-and-cases.md)
- [API reference](api.md)
- [Document processing](document-processing.md)
