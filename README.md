# CaseFlow AI

TypeScript monorepo with Microsoft Entra sign-in, persistent profiles, role-based permissions, case creation, editing, reversible archiving, Staff assignments, and audit history. Document processing is not implemented.

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
- `audit.ts`: case, permission, and profile audit history.
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
