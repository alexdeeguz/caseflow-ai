# Case timeline and reviewed summary

[Back to README](../README.md)

Case details provide **Overview**, **Documents**, **Timeline**, and **Reviewed summary** sections.
The last two are read-only projections of current approved facts. They use ordinary API queries;
there are no AI calls, queues, saved summaries, or additional background jobs. The manually entered
case summary and incident date remain unchanged in Overview.

- **Timeline** is a chronology: what happened on each date in the record's own words, how far each
  date is from the incident and from the previous date, and where care has gaps.
- **Reviewed summary** is a case brief: key dates, findings by certainty, treatment received versus
  recommended, and providers, each with its source quotation and citation.

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

Summary categories sort case-insensitively by effective value, then fact ID. Structured entries
preserve date meaning, qualifiers, recommended/performed treatment, suspected/confirmed findings,
and explicit negation. Approval does not establish that a negated event occurred. Empty states
describe an absence of approved information, not an absence of events.

## Chronology and brief design

| Decision                                           | Why                                                                                                                                                                                                                |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **One entry per date, described by its quotation** | A date alone says little; the source line (for example "Rehabilitation visit") says what happened. Lines that only repeat the date or its label are omitted.                                                       |
| **Incident, care, and record markers**             | Classified from the date's meaning so the incident and treatment dates stand out from statement and correspondence dates.                                                                                          |
| **Intervals from exact dates only**                | "Day 17" (from the incident) and "26 days later" are shown only when both dates are exact; partial dates never produce intervals.                                                                                  |
| **Care gaps flagged at 30 days**                   | Gaps between treatment dates matter when evaluating a claim, so long gaps are highlighted on the timeline and in key dates. The flag means no approved care date exists in that window, not that no care occurred. |
| **Key dates derived, not stored**                  | Incident, first care (and days after the incident), latest care, care span, and longest gap are calculated in the browser from approved date facts, so they always match the timeline.                             |
| **Findings and treatment grouped by status**       | Confirmed, suspected, and noted findings; treatment received, recommended (future care), and mentioned. Explicit negatives are listed separately so they are never read as present.                                |
| **Matching statements merged**                     | The same finding or treatment approved from several documents appears once with every citation and an "In N documents" marker, showing corroboration without hiding sources.                                       |
| **Pending review is visible**                      | The brief notes how many extracted facts still await review, because unapproved facts are not included.                                                                                                            |

The summary loads up to 100 approved facts per category (and the first 100 dates for key dates) and
says so when a category has more.

## Navigation, sources, and freshness

The URL retains `section` and `timelinePage`, together with existing case-list and document-list
context. Bookmarks, refresh, and Back/Forward use the same navigation/preloading helpers as the
workspace. The sidebar remains mounted. Mobile case navigation uses two columns; the timeline
collapses to a single rail and summary panels stack on narrow screens.

Each entry shows its quotation, document name, and page references without leaving the case. Source downloads reuse the document library's authenticated authorization and browser handoff;
no preview or persistent signed URL is added. Review/correction actions remain in Documents.

Review corrections, approval, rejection/reopening, and document removal/restoration invalidate the
affected case's timeline and summary queries. Existing case/permission invalidation remains in use.
Reads revalidate on navigation, focus, reconnect, and Refresh, without periodic polling. Transient
failures retain the last verified content with a stale-data notice and pause downloads. Authorization
rejection clears protected content. Background refresh does not move focus or replace the list
layout with a loading screen.

## Verification

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

The approved-fact view supplied by [human review](human-review.md) is a prerequisite.
Timeline and reviewed summary add no tables, stored summaries, or background jobs.
