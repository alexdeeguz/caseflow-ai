# Human review

[Back to README](../README.md)

Human review adds versioned corrections and approval to completed extracted facts. Original AI
values and source evidence remain immutable. No model call, document preview, manual fact creation,
or bulk approval is part of this feature. Approved facts feed the separate
[case timeline and reviewed summary](case-history.md).

## Permissions and states

| Action                                              | Assigned Staff | Admin / Super Admin |
| --------------------------------------------------- | -------------- | ------------------- |
| Read facts and review history                       | Assigned cases | All cases           |
| Correct or reject an Unreviewed fact                | Yes            | Yes                 |
| Correct a Rejected fact and return it to Unreviewed | Yes            | Yes                 |
| Approve an Unreviewed fact                          | No             | Yes                 |
| Reopen an Approved fact                             | No             | Yes                 |

Mutations require an active user, an available document, and a current case. Archived cases remain
readable. Removed-document facts and review history are hidden from every role until restoration.
Case assignments are checked on the server; hiding a button is not an authorization boundary.
Approval is role-based and does not require a different person from the person who corrected it.

The review states are **Unreviewed**, **Approved**, and **Rejected**. **Corrected** is a separate
indicator: it means the current structured values differ from the original extraction. Approved
facts are locked until an administrator explicitly reopens them. Reopening returns the fact to
Unreviewed and removes its current approval eligibility while preserving prior review history.

## Immutable evidence and revisions

Corrections may change category, value, qualifier, date meaning and precision, treatment/finding
status, and explicit negation. They cannot change the fact ID, extraction run, document, processing
result, page, quotation, or text offsets. Invalid or missing evidence should be rejected; replacing
citations is outside this phase. Conflicting source statements remain separate facts.

Every changed review creates a revision with the full effective values, status, action, reviewer
ID, timestamp, and reason. Correction, rejection, and reopening require a nonblank reason of at
most 1,000 characters. Approval applies to the exact current revision. The original extraction is
revision 1; it does not generate a synthetic review event.

All mutation bodies require `expectedVersion`. Stale requests return `409 FACT_REVIEW_CONFLICT`,
including a retry using the old version after a successful write. A matching-version request that
already has the requested values and status succeeds without incrementing the version or adding
history/audit records. A rejected fact must be corrected before approval. An approved fact must
be reopened before correction or rejection; invalid transitions return `409 FACT_REVIEW_LOCKED`.

## API

All paths below start with `/cases/:caseId/documents/:documentId/facts`. Responses are strict,
bearer-authenticated, and uncached. Successful reads and mutations return HTTP 200.

| Method and suffix       | Input                                                            | Response                                    |
| ----------------------- | ---------------------------------------------------------------- | ------------------------------------------- |
| `GET /`                 | `page`, `pageSize`, optional `category`, optional `reviewStatus` | Reviewed fact page and counts               |
| `GET /:factId`          | No query fields                                                  | Current fact, original values, and evidence |
| `PATCH /:factId`        | `{ expectedVersion, values, reason }`                            | Updated fact                                |
| `POST /:factId/approve` | `{ expectedVersion }`                                            | Updated fact                                |
| `POST /:factId/reject`  | `{ expectedVersion, reason }`                                    | Updated fact                                |
| `POST /:factId/reopen`  | `{ expectedVersion, reason }`                                    | Updated fact                                |
| `GET /:factId/history`  | `page`, `pageSize`                                               | Newest-first revisions                      |

The collection endpoint is the base path without a trailing slash. Pagination defaults to page 1,
25 items, with a maximum page size of 100. Category filtering uses the effective corrected category.
The list is ordered by category and fact ID. Counts apply case/document visibility and the selected
category, but include all review states so changing the status filter does not hide the other counts.
Results, totals, and counts use one database snapshot. History is ordered by revision descending.

Unknown fields and forged provenance are rejected. Inaccessible or mismatched resources return 404. Disabled users receive `403 ACCOUNT_DISABLED`. A removed document's library can remain visible
to administrators, but its fact collection returns `409 DOCUMENT_UNAVAILABLE`; individual facts
and their history return 404. Archived writes return `409 CASE_ARCHIVED`.

The document-library response includes `unreviewedFactCount` for each document, independent of
its total extracted fact count. This count follows current review states and excludes removed
document content; it does not grant review or approval permissions.

## Database and organization

The review schema is additive. It preserves extracted facts, evidence,
profiles, assignments, documents, jobs, dispatches, and audit history.

- `caseflow.fact_reviews` stores the current full values, status, and optimistic version.
- `caseflow.fact_review_revisions` stores immutable review changes keyed by fact and version.
- Existing facts are initialized as Unreviewed revision 1. An insert trigger initializes reviews
  for future fact publication in the same transaction.
- RLS follows the existing extracted-fact visibility rules. Runtime credentials receive SELECT
  and explicit function execution, with no direct writes. Worker roles do not receive review access.
- `caseflow.review_fact` takes the existing permission lock, reloads the active actor and case/document
  permissions, locks the review row, compares the version, and atomically changes review, revision,
  and audit records. Privileged functions have fixed empty search paths and explicit grants.
- Generic audit events contain IDs, versions, and statuses only. Reasons, corrected text, and
  quotations remain in protected fact/history endpoints so removal cannot leak them through audit.
- `caseflow.approved_facts` is a security-invoker view over current approved revisions. Future
  consumers must use it under the caller's authorization context and recheck access at use time.
  It excludes Unreviewed, Rejected, removed, and inaccessible facts. Case timeline and reviewed
  summary queries use this view for current approved information.

Contracts and constants live in `packages/schemas`; routes and queries are in separate
`apps/api/src/routes/fact-review.ts` and `apps/api/src/database/fact-review.ts` modules. Shared
fact-value validation preserves the original extraction contract. Frontend presentation is under
`apps/web/components/workspace/fact-review`, with draft/resource helpers in `apps/web/lib/fact-review`.

## Interaction behavior

The document's fact panel includes category/status filters, counts, original-versus-current values,
immutable quotations, source page references, and the existing authorized document download.
Corrections use inline validation and a focusable error summary. Decisions use the shared modal;
successful actions use toasts. Repeated submissions are disabled while a request is active.

Drafts stay in memory within the current user/role workspace across navigation and filters. They
are never put in URLs or browser storage. Background refresh cannot replace a draft. A conflict
retains it and offers an explicit, confirmed reload of the latest saved revision. Dirty drafts
require confirmation before discard and trigger a native browser warning on refresh/close.
Saving, discarding, sign-out, role/workspace disposal, or access rejection clears affected drafts.

Transient read failures retain verified content with a stale notice and disable review actions.
Authorization rejection clears protected content. Review mutations invalidate only affected fact
lists, detail/history resources, case timeline/summary resources, and audit queries. The workspace shell and existing navigation
context remain mounted; polling does not move keyboard focus.

## Verification

Tests use signed test tokens and disposable local PostgreSQL databases. Coverage includes the role
matrix, cross-case IDs, strict input validation, immutable evidence, concurrent edit/approval,
optimistic conflicts, no-ops, assignment/role/disable/remove/archive races, audit rollback, approved
view eligibility, restricted direct database calls, migration preservation, and repeatable seeding.
Draft retention, access-loss cleanup, and cache invalidation have frontend unit coverage.

Desktop browser verification uses real components with isolated fictional request fixtures; it
covers save, approval, reopening, rejection, reasons, history, draft retention, explicit conflict
reload, keyboard modal containment, Staff controls, archived cases, and service failures. It is not
a hosted end-to-end extraction-to-review check. Automated coverage does not establish
mobile visual quality.

The migration is additive: extraction tables stay immutable, and review tables and history are
never dropped. The fact response includes review metadata, so the API and frontend change together.
See [local development](development.md#verification) for the standard repository checks.
