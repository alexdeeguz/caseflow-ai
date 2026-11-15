# API reference

[Back to README](../README.md)

The Fastify API is served at `http://127.0.0.1:4000` during local development. Its root path returns 404; application routes are authenticated.

Route definitions are grouped by feature under `apps/api/src/routes`:

- `profile.ts`: current-user profile retrieval and updates.
- `users.ts`: administrative user listing, role changes, and account access.
- `cases.ts`: case creation, editing, archive/restore, searchable listing, details, and Staff assignments.
- `audit.ts`: case, permission, profile, and document audit history.
- `documents.ts`: upload sessions, document listing, download authorization, removal, and restoration.
- `processing.ts`: processing status and administrator start/retry actions.
- `protected-route.ts`: shared bearer-token verification and request/response validation.

`app.ts` configures Fastify, CORS, error handling, and registers the feature routes.
Database authorization and queries remain in `src/database`.

All endpoints require a Microsoft bearer access token. Shared contracts live in
`packages/schemas`; root scripts build that package before consumers, and root
`npm run dev` watches it. If running an app individually, build schemas first.

## Profile, administration, and case endpoints

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

## Document endpoints

See the [upload protocol](document-management.md#upload-protocol) for upload-session creation and completion, and [document listing and downloads](document-management.md#document-listing-and-downloads) for library, download, removal, and restoration endpoints. Those sections include request bodies, response shapes, permissions, and failure behavior.

## Processing endpoints

`GET /cases/:caseId/documents/:documentId/processing` reads the latest public processing
summary. `POST` at the same URL starts or retries with the required `expectedJobId`
(null for an initial request). Both return HTTP 200. Document list items include the
same summary as `processing`, using one database query for the page.

See [processing API behavior](document-processing.md#processing-api) for response fields,
permissions, retry/idempotency semantics, conflict codes, and migration prerequisites.
The API processing routes are separate from the background SQS dispatcher.

## Related guides

- [Authentication](authentication.md)
- [Users and cases](users-and-cases.md)
- [Verification](development.md#verification)
