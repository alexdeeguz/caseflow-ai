# API reference

[Back to README](../README.md)

The Fastify API is served at `http://127.0.0.1:4000` during local development. Its root path returns 404; application routes are authenticated.

Route definitions are grouped by feature under `apps/api/src/routes`:

- `profile.ts`: current-user profile retrieval and updates.
- `users.ts`: administrative user listing, role changes, and account access.
- `case-history.ts`: approved case timeline and categorized reviewed summary.
- `cases.ts`: case creation, editing, archive/restore, searchable listing, details, and Staff assignments.
- `audit.ts`: case, permission, profile, and document audit history.
- `documents.ts`: upload sessions, document listing, download authorization, removal, and restoration.
- `processing.ts`: processing status and administrator start/retry actions.
- `fact-extraction.ts`: extraction status, retries, and source-linked facts.
- `fact-review.ts`: corrections, review decisions, and revision history.
- `search.ts`: authorized document search and indexing requests.
- `protected-route.ts`: shared bearer-token verification and request/response validation.

`app.ts` configures Fastify, CORS, error handling, and registers the feature routes.
Database authorization and queries remain in `src/database`.

All endpoints require a Microsoft bearer access token. Shared contracts live in
`packages/schemas` and are validated at the HTTP boundary. Development commands
are documented in [local development](development.md#running-individual-apps).

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
| `GET /search`                                        | Search document text in accessible cases                          |

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

## Fact extraction

The processing-ready document routes support latest extraction status, administrative start/retry,
and paginated category-filtered facts with evidence. See [fact extraction](fact-extraction.md#api-and-ui)
for request semantics, permissions, public fields, and error behavior.

## Human review

Fact lists now return effective values, immutable originals/evidence, review metadata, and counts.
The feature adds single-fact reads, versioned corrections, approval/rejection/reopening, and
paginated history under `/cases/:caseId/documents/:documentId/facts/:factId`.
See [human review](human-review.md#api) for exact routes, bodies, permissions, and conflict behavior.

## Case timeline and reviewed summary

`GET /cases/:caseId/timeline` returns approved date facts, oldest first.
`GET /cases/:caseId/reviewed-summary` returns a category page plus case-wide approved category and
source-document counts. Both accept standard pagination; the summary also accepts `category`,
defaulting to `date`. Only current approved values from available documents are included.

See [case history](case-history.md#api) for response metadata, ordering, permissions, and freshness.
