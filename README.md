# CaseFlow AI

TypeScript monorepo with Microsoft Entra sign-in, persistent profiles, role-based permissions, case creation, editing, reversible archiving, Staff assignments, and audit history. Direct S3 upload authorization and server-verified completion are implemented. Document browsing, download/removal workflows, upload UI, and processing remain pending.

## Structure

- `apps/web`: Next.js, React, and Tailwind frontend with Microsoft sign-in.
- `apps/api`: Fastify API with database-enforced user and case permissions.
- `packages/schemas`: shared strict Zod request/response contracts and TypeScript types.

Shared domain values live in `packages/schemas/src/constants` (roles, case statuses, archive filters and limits, error codes,
and audit actions). Request/response schemas and inferred types live in
`packages/schemas/src/contracts`, grouped by feature. Import both through
`@caseflow/schemas`; the package entry point only re-exports its public API.

API database code lives in `apps/api/src/database`: connection/transaction lifecycle
in `index.ts`, operation identifiers and access requirements in `operations.ts`,
operation dispatch and shared queries in `queries.ts`, case queries in `cases.ts`, connection URL validation in
`connection-config.ts`, and safe database-error translation in `errors.ts`. Application errors are defined separately in `apps/api/src/errors.ts`.

Frontend workspace components live in `apps/web/components/workspace`; case list,
shared create/edit form, versioned drafts, status badge, detail, and assignment-picker components are grouped under `cases/`. Reusable
controls, accessible confirmation dialogs, toast notifications, and loading/pagination components live in `components/ui`. In-memory edit drafts are owned by the current workspace through `lib/case-drafts.ts`. Constants used
by one component stay with that component. Shared workspace navigation constants live in
`lib/constants/navigation.ts`; URL parsing/serialization lives in `lib/workspace-location.ts`.

## Setup

Use Node.js 24.22.3 and npm 11.x (expected npm version: 11.12.1).

```sh
cd caseflow-ai
npm install
cp apps/web/.env.example apps/web/.env.local
cp apps/api/.env.example apps/api/.env
# Complete the local database setup below before starting the app.
npm run dev
```

If using nvm, run `nvm install` and `nvm use` first.

The web starter runs at http://localhost:3000. The API binds to http://127.0.0.1:4000; `GET /me` requires a valid CaseFlow access token. The root path returns 404. Stop development with Ctrl+C.

## Commands

```sh
npm run dev:web
npm run dev:api
npm run build
npm run lint
npm run typecheck
npm run format:check
npm test
```

## Local database

Install and start Docker Desktop, then run from the repository root:

```sh
npm run db:start
npm run db:status
```

The pinned Supabase CLI manages the local Docker containers. The first start
downloads the required images. Open Studio at http://127.0.0.1:54323 to inspect
the database; PostgreSQL listens on port 54322 and the local Supabase API on
port 54321. `npm run db:status` displays connection details and local development
keys. Keep privileged keys out of frontend code.

Run `npm run db:stop` when finished. This preserves local data for the next start.
Do not use `--no-backup` unless you intend to delete local database volumes.
Stopping the app with Ctrl+C does not stop these containers.

Configuration lives in `supabase/config.toml`. Microsoft Entra remains the sign-in provider.
Local data is separate from any hosted Supabase project and does not sync automatically.

### First-time database setup

After copying the app environment examples, create the ignored
`apps/api/.env.operator` with this **local-only** operator connection:

```dotenv
OPERATOR_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
```

Then run from the repository root:

```sh
npm run db:start
npm run db:migrate
npm run db:configure
npm run db:seed
npm run dev
```

`db:configure` generates a random runtime password and writes `DATABASE_URL` to
`apps/api/.env`. Running it again rotates that local password; restart the API.
The API requires `caseflow_runtime`, never the operator role. Hosted database
connections require TLS verification (`sslmode=verify-full`). Connection URLs accept
TLS options and `application_name`; credentials and host belong in the URL itself,
not query-string overrides. Operator credentials
belong only in operator tooling, never in the web app or deployed API environment.

Migrations create a private `caseflow` schema with RLS and a restricted login.
Do not add this schema to Supabase's exposed schemas or grant access to `anon`,
`authenticated`, or `service_role`. Runtime writes use narrowly scoped private
functions with fixed search paths and explicit execution grants. The runtime
cannot update tables, modify audit history, or call operator functions directly.
Identity context comes exclusively from verified Microsoft claims and lasts only
for the request transaction. It is not a defense against a compromised API process.

The seed command adds three fictional cases idempotently. It does not reset users
or assignments. Migration and seed commands never reset the existing database.

### Roles and administration

| Capability                              | Staff                 | Admin                 | Super Admin           |
| --------------------------------------- | --------------------- | --------------------- | --------------------- |
| Edit own display name                   | Yes                   | Yes                   | Yes                   |
| View cases                              | Assigned only         | All                   | All                   |
| Create cases                            | No                    | Yes                   | Yes                   |
| Edit details/status or archive/restore  | No                    | Yes                   | Yes                   |
| View archived cases                     | Assigned only         | All                   | All                   |
| Assign/remove Staff                     | No                    | Yes                   | Yes                   |
| Enable/disable Staff                    | No                    | Yes                   | Yes                   |
| Promote/demote or enable/disable Admins | No                    | No                    | Yes                   |
| View audit history                      | No                    | Yes                   | Yes                   |
| Grant/remove Super Admin                | Operator command only | Operator command only | Operator command only |

New users start as active Staff with no assignments. After first sign-in, copy the
application user ID from **Profile** and run:

```sh
npm run operator:role -- USER_UUID super_admin
```

The same operator command accepts `staff` or `admin` for controlled role recovery.
It rejects disabled targets and removal of the last active Super Admin, and records
changes with the database operator's name. It never matches accounts by email or
display name. The web app cannot change a Super Admin's role/access status; they
can still edit their own display name.

Admins manage Staff access; Super Admins also manage Admin access. Demotion retains
explicit assignments. Disabling blocks protected endpoints while retaining those
assignments. New assignments require active Staff. Existing assignments to promoted
Admins are retained and can be managed again after demotion.

Permission mutations use a transaction-scoped advisory lock shared with operator
commands, then reload authorization and commit the mutation and audit together.
This serializes the demo's small administration workload; ordinary reads remain
concurrent. New authorization checks observe committed permission changes. Data
already delivered to a browser cannot be recalled.

### Creating and viewing cases

Admin and Super Admin users can choose **Create case** in the Cases workspace.
The form requires a case title (up to 200 characters) and fictional client name
(up to 100). Incident date and summary (up to 2,000 characters) are optional.
Status defaults to Intake; Active and Closed are also available at creation.
Admin and Super Admin users can edit all five fields and move freely between the three statuses.

The server generates the UUID, case number, creation time, and creator identity.
Case numbers use a database sequence, such as `CF-000001`; gaps are expected after
rollbacks or repeated seed runs. New cases have no Staff assignments. After saving,
the case details screen provides the existing assignment controls.

The case list supports case-insensitive literal substring search across case number,
title, and client name, plus status and Current / Archived / All filters (Current by default). Results and totals obey case permissions
and are ordered newest first, with UUID as a stable tie-breaker. Incident dates are
calendar dates, so they do not shift with the viewer's time zone.

Case-list filters apply immediately; search updates after a 300 ms typing pause.
Changing filters resets pagination, and automatic updates replace the current URL entry.

Workspace URLs retain the selected tab, case, search, status, archive filter, and page, allowing
bookmarks, refresh, and browser Back/Forward. Add `mode=edit` to a case URL to open its edit form. Form drafts are not stored in URLs.
The desktop list uses a table; narrow screens use case cards.

For an existing local installation, run `npm run db:migrate` before starting the
updated API. The additive migration preserves existing profiles, case IDs, assignments,
and audit events, and fills the seeded cases with fictional client metadata.
Legacy cases have no recorded creator; newly created cases always do. No reset or
credential rotation is required.

### Editing, archiving, and restoring cases

Choose **Edit case** on current case details. IDs, case numbers, creators, and creation
times are immutable. Unsaved edits remain in memory while navigating within the same
user/role workspace. Background refreshes retain dirty fields. Saving or explicitly
discarding clears the draft; sign-out or loss of access also clears protected drafts.
Refreshing or closing a page with unsaved edits triggers the browser's leave-page warning;
drafts do not survive a reload and are never written to browser storage.

Concurrent mutations use an `expectedVersion` check after locking the case row and
rechecking the actor under the permission lock. A conflict retains the edit draft and
requires an explicit, confirmed reload of the latest saved case. It never merges or
retries an outdated edit automatically. No-op requests leave the version, timestamp,
and audit history unchanged.

**Archive case** opens an in-app confirmation modal naming the case. Archiving preserves
its Intake/Active/Closed status, data, assignments, and history. Archived case details
are read-only until **Restore case** is used. Assigned Staff can still read archived
cases, and administrators can manage assignments while archived. Saved detail links
continue to work regardless of the list filter. There is no permanent deletion.

Successful case, profile, role, access, and assignment changes use shared toast
notifications. Toasts dismiss automatically, pause while hovered or focused, and have
a keyboard-accessible dismiss button. Errors remain beside the relevant controls.
Confirmation dialogs contain keyboard focus, support Escape, and return focus to the
trigger when closed. Existing installations only need `npm run db:migrate`: new case
metadata starts at version 1 with `updatedAt` equal to the original creation time.

### API contracts and verification

Route definitions are grouped by feature under `apps/api/src/routes`:

- `profile.ts`: current-user profile retrieval and updates.
- `users.ts`: administrative user listing, role changes, and account access.
- `cases.ts`: case creation, editing, archive/restore, searchable listing, details, and Staff assignments.
- `audit.ts`: case, permission, profile, and document audit history.
- `documents.ts`: upload sessions, document listing, download authorization, removal, and restoration.
- `protected-route.ts`: shared bearer-token verification and request/response validation.

`app.ts` configures Fastify, CORS, error handling, and registers the feature routes.
Database authorization and queries remain in `src/database`.

All endpoints require a Microsoft bearer access token. Shared contracts live in
`packages/schemas`; root scripts build that package before consumers, and root
`npm run dev` watches it. If running an app individually, build schemas first.

| Endpoint                                             | Purpose                                                           |
| ---------------------------------------------------- | ----------------------------------------------------------------- |
| `GET /me`                                            | Provision once and return the current profile                     |
| `PATCH /me`                                          | Change own display name only                                      |
| `POST /cases`                                        | Admin/Super Admin creates a case; returns 201                     |
| `GET /cases`, `GET /cases/:id`                       | Search accessible cases and read details                          |
| `PATCH /cases/:id`                                   | Edit case fields with required `expectedVersion`; returns 200     |
| `POST /cases/:id/archive`, `POST /cases/:id/restore` | Change archive state with required `expectedVersion`; returns 200 |
| `GET /admin/users`                                   | Search/paginate users; optional role filter                       |
| `PATCH /admin/users/:id/role`                        | Super Admin changes Staff/Admin role                              |
| `PATCH /admin/users/:id/access`                      | Enable/disable permitted target                                   |
| `PUT`, `DELETE /admin/cases/:id/assignments/:userId` | Assign/remove Staff                                               |
| `GET /admin/audit`                                   | Paginated audit history                                           |

Lists accept `page` (default 1) and `pageSize` (default 25, maximum 100).
`GET /cases` also accepts `search` (up to 200 characters) and optional `status`
(`intake`, `active`, or `closed`), plus `archive=current|archived|all`. `POST /cases` accepts only `title`, `clientName`,
`incidentDate` (`YYYY-MM-DD` or null), `status`, and `summary`; the last three are
optional. Creation commits with a `case.created` audit event and rechecks current
admin authorization inside the permission transaction lock.
`PATCH /cases/:id` accepts the same editable fields without creation defaults, plus
required positive integer `expectedVersion`. Omitted fields stay unchanged; null clears
`incidentDate`, and an empty string clears `summary`. Unknown and server-controlled
fields are rejected. Archive/restore bodies accept only `expectedVersion`. Case responses
include `version`, `updatedAt`, `archivedAt`, and `archivedBy`; archive metadata is null
for current cases. Changed writes atomically record `case.updated`, `case.archived`,
or `case.restored` with the actor and before/after values. Stale requests return
`409 CASE_CONFLICT`; edits against an archived case at its current version return
`409 CASE_ARCHIVED`.

Errors contain stable `code` and safe `error` text. Disabled accounts return
`403 ACCOUNT_DISABLED`; ordinary permission denials return `403 FORBIDDEN`;
inaccessible cases return 404; database outages fail closed with 503.

```sh
npm test
npm run test:integration
npm run lint
npm run typecheck
npm run format:check
npm run build
```

Integration tests require Docker plus the local operator/runtime environment files.
They create and drop a uniquely named disposable database, apply migrations and
seeds there, and exercise real restricted-login permissions. They never reset the
working database and do not silently skip when the database is unavailable. Coverage includes partial edits, archive access/filtering, retained assignments, concurrent writes, demotion/disable races, audit rollback, migration preservation, and direct runtime-role restrictions.

## Document storage and uploads

The API supports upload authorization, verified completion, paginated document listing,
short-lived downloads, and administrative removal/restoration. The document UI and
background processing are not yet implemented.

Storage configuration and S3 adapters live in `apps/api/src/storage`. Upload and download
orchestration live in `src/documents`, HTTP definitions in
`src/routes/documents.ts`, and database queries in `src/database/documents.ts`.
Shared contracts and limits live in `packages/schemas`. Install dependencies with
`npm install` and apply additive migrations with `npm run db:migrate`.

### Configuration

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

### Upload protocol

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

### Document listing and downloads

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

### Document removal and restoration

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

### Verification and consistency

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
- Ten files per selection and two simultaneous browser uploads are reserved UI
  limits. Cancellation, scheduled expiry, orphan cleanup, and quota reclamation
  remain later work. Do not release reservations by deleting metadata manually.

Unit tests exercise upload signing restrictions, byte verification, safe failures,
and client shutdown. PostgreSQL integration tests use disposable databases for
permissions, idempotency, quota races, role/assignment/archive races, atomic audit
rollback, restricted runtime access, and migration preservation. They do not reset
the working database or require live S3 credentials.

## Authentication

Both Entra registrations support organizational and personal Microsoft accounts.
Configure `CaseFlow Web - Local` with the SPA redirect URI
`http://localhost:3000/auth/callback`. MSAL 5 uses this dedicated redirect bridge;
the page is outside authentication initialization and is served with `no-store`.
Do not configure Cross-Origin-Opener-Policy on the callback page.

The API registration exposes `access_as_user` (Admins and users may consent),
uses v2 access tokens, and the Web registration requests this delegated permission.
Some organizations require their administrator to approve third-party applications.
No client secret or Microsoft Graph permission is needed.

Copy each app's `.env.example` as shown above only on first setup; preserve existing
local settings. The supplied IDs and scope are public registration identifiers.
Next.js reads `.env.local`; the API loads `.env` through Node's environment-file
support. Production should supply environment variables through its host. The
frontend's `NEXT_PUBLIC_*` settings are public and fixed at build time. Rebuild
when changing them. Use HTTPS origins and register the deployment's callback URI
before deploying; allow only that frontend origin in API CORS settings.

`GET /me` returns `{ id, displayName, role, active }` from PostgreSQL. Provisioning
uses the verified Entra tenant ID and subject as immutable identity, never an email
or editable name. Later sign-ins do not overwrite roles, disabled status, or names.

The API checks RS256 signatures, tenant/issuer consistency, signing-key issuer,
audience, expiry/not-before, v2 format, allowed client and delegated scope before
accessing application data. Every request reloads current application authorization.

The frontend waits for session restoration before choosing the sign-in or workspace
screen. Workspace queries use an in-memory React Query client scoped to the current
user and role. Navigation revalidates the destination before switching sections;
mutations invalidate cached resources. Request failures hide cached results, and
leaving the workspace clears its cache and cancels pending requests.

Tokens are managed by MSAL in session storage, sent only to the configured API,
and never displayed or deliberately logged. Sign-out clears the local MSAL session
and redirects to Microsoft; it does not revoke already-issued bearer tokens.

`npm test` runs signed-token API tests using ephemeral local keys, including
consumer/organizational identity, invalid signatures/claims, missing permission,
provider failure and CORS. Frontend tests cover configuration validation, network
errors, timeouts and response validation. API requests refuse HTTP redirects to
keep bearer tokens scoped to the configured endpoint. These tests do not establish that your live Entra
registration is configured correctly. To verify live: run `npm run dev`, open
`http://localhost:3000`, sign in, confirm the workspace opens, then sign out.
Repeat with a personal and a work/school account when available. Never paste tokens
or session cookies into issue reports.

## Frontend organization

- `app/globals.css`: brand palette and semantic theme tokens.
- `components/ui`: shared buttons and accessible status messages.
- `components/auth`: responsive page shell, panels and sign-in presentation.
- `hooks/use-authentication.ts`: Microsoft sign-in/session actions, separate from styling.
- `lib/config.ts`, `lib/auth.ts`, `lib/api.ts`: configuration validation, MSAL initialization and API access.

Inter is self-hosted from the pinned font package. Reuse theme tokens and shared
components for new screens instead of copying colors or authentication logic.

## Dependency maintenance

The root `package.json` temporarily overrides `minimatch` to `11.0.1` only beneath
`@typescript-eslint/typescript-estree@8.72.2`. That lint dependency otherwise selects
an affected `10.x` release. This addresses
[GHSA-g3hv-75wg-m249](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249).
When upgrading TypeScript ESLint, revisit this override and remove it once the
upstream dependency resolves a patched version. Regenerate the lockfile and rerun
`npm audit`, `npm run lint`, `npm run typecheck`, and `npm run build` after changes.
