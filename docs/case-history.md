# Case timeline and reviewed summary

Case details provide **Overview**, **Documents**, **Timeline**, and **Reviewed summary** sections.
The last two are read-only projections of current approved facts. They use ordinary API queries;
there are no AI calls, queues, saved summaries, or additional background jobs. The manually entered
case summary and incident date remain unchanged in Overview.

## Eligibility and permissions

Assigned Staff can read their cases; Admin and Super Admin can read all cases. Archived cases
remain readable. Only current Approved revisions from available documents contribute entries,
category counts, or source-document counts. Unreviewed, rejected, removed, and inaccessible facts
are excluded. Reopening removes a fact from subsequent reads. Restoring a document makes its
still-approved facts eligible again.

Queries read `caseflow.approved_facts` under the caller's transaction identity and existing RLS.
They expose the effective corrected values, review version, fact ID, document ID/name, and original
processing-result/page/quotation/offset evidence. Review reasons, storage locations, provider data,
and credentials are excluded. There are no additional database tables or grants.

## API

| Endpoint                              | Query                          | Response                                                                            |
| ------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------- |
| `GET /cases/:caseId/timeline`         | `page`, `pageSize`             | Approved date facts and matching total                                              |
| `GET /cases/:caseId/reviewed-summary` | `page`, `pageSize`, `category` | Selected-category facts, matching total, all category counts, source-document count |

Both return HTTP 200, require a bearer token, validate strict shared contracts, and send
`Cache-Control: no-store`. Unknown query fields are rejected. Pagination defaults to page 1 with
25 items, maximum 100. Summary categories are `date`, `provider`, `treatment`, and `finding`;
`date` is the default. Counts cover all eligible facts in the case, independent of selected
category and page. The document count includes only documents contributing approved facts.

Case visibility, counts, and page contents are evaluated in one SQL statement/snapshot per
endpoint. Inaccessible cases return 404 even when empty; disabled accounts retain the existing
403 behavior. Queries are parameterized and set-based, with evidence projected only for the
selected page. Existing authorization and evidence indexes are reused.

Contracts live in `packages/schemas/src/contracts/case-history.ts`. Routes and queries are split
between `apps/api/src/routes/case-history.ts` and `apps/api/src/database/case-history.ts`.
`fact-projections.ts` shares evidence serialization with the document fact-review endpoints.

## Ordering and interpretation

Timeline entries come only from approved date facts. Dates sort by their stored string ascending,
then fact ID, so a year-only date appears before more specific dates in that year. Partial dates
are explicit: **2026 — month and day unspecified** or **November 2026 — day unspecified**.
Full dates use timezone-independent calendar formatting. No date is inferred for a treatment or
finding, and the manually entered incident date is not inserted into this timeline.

Summary Dates use the same ordering. Other categories sort case-insensitively by effective value,
then fact ID. Structured entries preserve date meaning, qualifiers, recommended/performed treatment,
suspected/confirmed findings, and explicit negation. Conflicting or repeated source statements stay
separate; approval does not establish that a negated event occurred. Empty states describe an
absence of approved information, not an absence of events.

## Navigation, sources, and freshness

The URL retains `section`, `timelinePage`, `summaryCategory`, and `summaryPage`, together with
existing case-list and document-list context. Bookmarks, refresh, and Back/Forward use the same
navigation/preloading helpers as the workspace. The sidebar remains mounted. Mobile case navigation
uses two columns; summary category controls and cards adapt to narrow screens.

Each entry shows its document name and page references. Quotations expand without leaving the
case. Source downloads reuse the document library's authenticated authorization and browser handoff;
no preview or persistent signed URL is added. Review/correction actions remain in Documents.

Review corrections, approval, rejection/reopening, and document removal/restoration invalidate the
affected case's timeline and summary queries. Existing case/permission invalidation remains in use.
Reads revalidate on navigation, focus, reconnect, and Refresh, without periodic polling. Transient
failures retain the last verified content with a stale-data notice and pause downloads. Authorization
rejection clears protected content. Background refresh does not move focus or replace the list
layout with a loading screen.

## Verification and release

Signed-token integration tests use disposable PostgreSQL databases and restricted runtime
credentials. They cover effective corrections, approval transitions, role/assignment boundaries,
disabling, archived cases, document removal/restoration, exact Unicode evidence, counts, partial
dates, leap days, ordering, pagination, and unknown fields. A 500-fact fixture checks both endpoints
use one data query and records `EXPLAIN ANALYZE` plans using the existing indexes.

Frontend tests cover strict contracts, timezone-independent display, URL round-tripping, preloading,
precise invalidation, protected-content/error behavior, and shared source-download authorization.
Browser checks use real components with isolated fictional responses for desktop and 390-pixel
layouts, expandable evidence, keyboard interaction, pagination, bookmarks/refresh, Back/Forward,
and transient/denied/empty states. They do not constitute hosted end-to-end verification.

The existing `20261116011952_human_review.sql` migration is a prerequisite; this feature adds no
migration. Hosted migration review/application and live extraction-to-review verification remain
separate release tasks. Do not backfill facts or enable extraction to test these read-only views.
See [human review](human-review.md) and [fact extraction](fact-extraction.md) for those release gates.
