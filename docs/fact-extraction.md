# OpenAI fact extraction

[Back to README](../README.md)

Fact extraction is a separate stage queued automatically when document text processing reaches
Ready for an available document in a current case, including assigned Staff uploads. The feature
creates unreviewed dates, providers, treatments, and findings with exact source quotations. Human
review remains manual. Admin/Super Admin can explicitly retry failed or cancelled extraction and
start extraction for historical Ready documents; historical documents are not backfilled.

Automatic creation uses the same persisted outbox as manual requests; dispatch requires the API
dispatcher and the queue consumer. Queue consumption, API dispatch, and scheduled recovery can each
be switched off independently without losing queued work.

## Components and request flow

| Component                                  | Responsibility                                                               |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| `packages/schemas`                         | Strict public contracts, constants, and cross-language queue fixtures        |
| `apps/api/src/routes/fact-extraction.ts`   | Protected status, start/retry, and fact-list routes                          |
| `apps/api/src/database/fact-extraction.ts` | Parameterized extraction lifecycle queries                                   |
| `apps/api/src/processing`                  | Shared bounded outbox dispatcher with a separate fact target                 |
| `services/fact-extractor`                  | Python SQS handler, extraction service, and storage/database/OpenAI adapters |
| `services/document-processor`              | Existing text/OCR services and optional scheduled fact reconciliation        |
| `infra/fact-extraction`                    | SAM resources and isolated Linux build checks                                |

1. A database trigger commits the first extraction job, preparation task, dispatch record, and
   service audit event in the same transaction that publishes the processing result as Ready.
   Explicit administrator starts and retries reuse the same internal creation function.
2. The fact dispatcher sends only `{ schemaVersion: 1, taskId }` to the dedicated SQS queue.
3. The worker claims a fenced lease and reads the exact saved processing text artifact version.
   It verifies the checksum and source identity, then checkpoints deterministic page-aware chunks.
4. Each later invocation handles one chunk. It counts the complete provider request, reserves its
   maximum cost, requests structured facts, validates evidence, and saves the validated output.
5. The final chunk atomically publishes the complete fact set, marks the run Completed, and writes
   its audit event. Partial results are never exposed as completed facts.

A task UUID remains stable during transport recovery. API dispatch acknowledges its own database
lease after SQS accepts a message. Duplicate delivery is expected: completed tasks are ignored,
active leases prevent competing publication, and an interrupted call may consume another separately
reserved provider attempt. This is at-least-once delivery, not exactly-once provider execution.

## Model, evidence, and limits

The pinned model is `gpt-5.4-mini-2026-03-17`, with low reasoning effort, no tools, foreground
Responses requests, strict structured output, and `store: false`. This disables response storage;
it does not promise zero provider retention. Document text is explicitly treated as untrusted data.
See [model documentation](https://developers.openai.com/api/docs/models/gpt-5.4-mini) and
[conversation-state documentation](https://developers.openai.com/api/docs/guides/conversation-state).

The structured-output schema uses a separate branch for each fact category. Date fields are
required only for dates, treatment status for treatments, and finding status for findings; unrelated
fields must be null. This gives the provider the same category constraints enforced by application
validation. Invalid schema and citation failures remain terminal and never publish partial facts.

The application supplies document/result IDs and evidence offsets. Exact quotation matches take
precedence. If a quotation differs only in whitespace runs, a unique match may restore the original
line breaks or spacing from the checkpointed page. Matching never changes words, punctuation, case,
or word boundaries; ambiguous matches remain invalid. The persisted quotation always equals its
exact source slice, stays within the quotation limit, and never crosses a page or chunk boundary.
Offsets count Unicode code points and are end-exclusive.
Dates retain year/month/day precision. Recommended and performed treatments, suspected and confirmed
findings, negation, and conflicting statements remain distinct. Newly extracted facts start Unreviewed. [Human review](human-review.md) adds versioned corrections and approval while preserving the original extraction.
A matching quotation proves source location; it does not by itself prove the model interpreted it
correctly. Fixture evaluation and human review are still required.

| Limit                    | Value                                                                        |
| ------------------------ | ---------------------------------------------------------------------------- |
| Text artifact            | Exact S3 version, SHA-256 verified, at most 50 MiB                           |
| Pages                    | Existing 20-page processing limit                                            |
| Initial chunk            | At most 16,000 characters on one page, with a 300-character boundary overlap |
| Input per provider call  | At most 12,000 tokens including instructions and output schema               |
| Output per provider call | At most 8,192 tokens, including reasoning tokens                             |
| Tasks per document       | At most 64 extraction chunks, plus preparation                               |
| Provider attempts        | At most 3 per chunk, each accounted separately                               |
| Automatic recovery       | At most 3 redispatches per task                                              |

Oversized counted requests split before a paid extraction call. No page is silently truncated.
Invalid citations, refusals, incomplete responses, source failures, and exhausted limits produce
safe terminal failures. Only identical facts with identical evidence are deduplicated; conflicting
or differently supported facts remain separate.

## Database and permissions

The extraction schema contains private jobs, tasks, dispatches,
versioned model prices, daily usage/reservations, facts, and evidence. Existing profiles, cases,
documents, assignments, processing results, and audit history are preserved. It does not backfill
extraction jobs.

A Ready-transition trigger uses a private shared creation function. It does not change existing rows or grant new table-write
permissions. Duplicate completion, a no-op Ready update, or an existing extraction job cannot
create another automatic job. Failed/cancelled jobs therefore remain terminal until an explicit
administrator retry. The shared permission lock serializes the handoff with removal and archival.
Automatic audit events identify `document_processor` as the service; `requested_by` retains the
originating processing requester for provenance.

| Role                       | Allowed operations                                                           |
| -------------------------- | ---------------------------------------------------------------------------- |
| `caseflow_runtime`         | Authorized start/retry and RLS-filtered public reads                         |
| `caseflow_fact_dispatcher` | Claim, finish, and retry fact dispatch records only                          |
| `caseflow_fact_extractor`  | Fenced task lifecycle, usage reservations/settlement, and atomic publication |
| `caseflow_recovery`        | Bounded, environment-scoped fact recovery through the persisted outbox       |

Workers and dispatchers have no direct application table privileges. Security-definer functions
use fixed empty search paths and explicit grants. The shared permission lock serializes mutations
with removal and case archival; short transactions never encompass provider calls.

Staff can read available documents in assigned cases. Administrators can read available documents
across cases. Archived cases remain readable, but cannot start extraction. Removed document content
is hidden from everyone until restoration. Removal or archival cancels unfinished runs. Restoration
does not restart work. Completed facts and audit history are preserved.

## API and UI

All routes require a valid bearer token and return uncached, validated responses.

| Route                                                       | Behavior                                              |
| ----------------------------------------------------------- | ----------------------------------------------------- |
| `GET /cases/:caseId/documents/:documentId/fact-extraction`  | Latest safe state, or Not extracted                   |
| `POST /cases/:caseId/documents/:documentId/fact-extraction` | `{ expectedJobId }`; returns HTTP 200                 |
| `GET /cases/:caseId/documents/:documentId/facts`            | Paginated reviewed facts with category/status filters |

Initial requests use `expectedJobId: null`. A retry names the latest failed/cancelled job. Identical
requests return the same resulting job; stale requests conflict. Completed runs cannot be rerun.
Unknown fields and forged identifiers are rejected. Inaccessible resources return 404. Public
responses omit provider identifiers, storage locations, leases, credentials, and model responses.

The document list includes the latest extraction summary and required integer
`unreviewedFactCount` in its existing query, without one query per document. The count includes
only published facts whose current review status is Unreviewed. Approved/rejected facts do not
contribute; corrections and reopening follow the persisted review status. Documents without
visible published facts, including removed documents, return zero. Counts follow the caller
identity/RLS and share the list response snapshot.

The UI separates text processing from fact extraction. Explicit administrator starts/retries
confirm the document and provider before submission and report that work was queued. It polls visible active work every five seconds and
stops when hidden, offline, or terminal. Transient failures retain verified content and pause actions;
authorization rejection clears protected content. Detail cards include categories, review states, immutable quotations, page references, and the existing authorized source download. [Human review](human-review.md) defines corrections, approvals, and revision history; its queries live in the separate fact-review database module.

## Usage allowance

The shared application allowance is **$1 per UTC day**. Prices are versioned in PostgreSQL and
bound to each job: initially $0.75 per million input tokens and $4.50 per million output tokens.
Costs use integer nanodollars. Before each attempt, the worker uses the official complete-request
[token counting endpoint](https://developers.openai.com/api/docs/guides/token-counting), then
atomically reserves input cost plus the maximum output cost. Missing prices or counting failures
prevent the extraction call.

Returned usage settles the reservation, conservatively charging input tokens without a cached-input
discount. Uncertain calls retain their full maximum reservation. Another attempt requires another
reservation. Settlement after UTC rollover adjusts the original reservation day. Budget exhaustion
is terminal until an administrator explicitly retries. This allowance does not cover AWS costs,
other OpenAI projects, or the separate fixture evaluation command.

## Verification

Automated tests use disposable local PostgreSQL databases and provider substitutes;
they do not call OpenAI or require hosted credentials. The committed fictional fixtures
exercise dates, ambiguity, negation, recommendations, conflicts, Unicode, irrelevant
content, and document instructions. Commands are in [local development](development.md#python-services).

Provider evaluation is separate from the automated suite. It sends committed fictional
fixtures to OpenAI, has a conservative $0.50 per-invocation ceiling independent of the
application allowance, and produces a private report. Repeated evaluations have separate
ceilings. Reports compare actual facts with source text and expected facts, including
unsupported statements and missed information. Exact citation matching alone does not
prove semantic correctness.

## Monitoring and recovery

The stack includes queue-age, visible-DLQ, and Lambda-error alarms, with an optional existing SNS
alert topic. The dashboard shows provider attempts, retries, failures, latency, completed chunks,
and conservative maximum allowance reservations. Reserved-usage metrics do not subtract later
settlements; PostgreSQL is authoritative for the actual remaining application allowance. Partial
batch failures do not count as Lambda invocation errors, so DLQ and queue-age alarms remain important.
Metrics use environment-only dimensions. Logs omit text, quotations, responses, and secrets.

Scheduled recovery checks overdue work in bounded batches, preserves task IDs and reservations,
and uses the outbox rather than direct queue sends. It cannot call OpenAI or reserve additional
usage. Exhausted jobs require an explicit administrative retry; recovery never purges
queues or performs an unbounded redrive.

### Evaluation review checks

The evaluator records a prompt checksum and checks expected provider affiliations and report
attribution in structured qualifiers. Exact citations alone do not satisfy those checks.
The report includes `missingQualifiers`, unsupported facts, and missed facts; these fixture
checks do not replace semantic review. Progress messages contain only fixture counts,
and existing reports are preserved.

Evaluation also reports `statusMismatches`, `unexpectedFactsWhenNoneExpected`, and
`missedExpectedFacts`. Coverage checks compare fixture values case-insensitively and preserve
category, polarity, date precision, status, and required qualifiers. Semantically equivalent
wording can still need reviewer adjudication; empty diagnostics do not prove general accuracy.
A small fixture evaluation does not establish accuracy on complete documents.
