# Document processing

[Back to README](../README.md)

The database lifecycle, API dispatcher, processing endpoints, Python extraction and completion workers, bounded recovery, monitoring, and document-library controls are implemented. See [workflow verification](processing-verification.md) for test coverage and its limits.

- [Processing in the document library](#processing-in-the-document-library)
- [Processing API](#processing-api)
- [Job and dispatch records](#job-and-dispatch-records)
- [Processor database](#processor-database)
- [API dispatcher](#api-processing-dispatcher)
- [Dispatcher credentials and configuration](#dispatcher-credentials-and-configuration)

## Processing in the document library

Processing appears separately from file availability in the desktop table and mobile cards.
The labels are Not processed, Queued, Extracting text, Waiting for OCR, Collecting results,
Ready, Failed, and Cancelled. Details show the extraction method, processed page count,
latest processing update, and safe failure explanations. No progress percentages, time
estimates, extracted-text viewer, or previews are shown.

Admin and Super Admin can **Process** unprocessed available documents or **Retry** failed
and cancelled jobs in current cases. The confirmation names the file and explains applicable
limits: PDFs up to 20 pages; images up to 10 MB, 10,000 pixels per side, and 40 megapixels;
and a shared allowance of 100 OCR pages per UTC day. Staff can read status for assigned
cases. Archived cases and removed documents have no start/retry controls. API authorization
remains authoritative.

Submissions retain their original `expectedJobId` on uncertain responses. Controls prevent
repeat submission; the success toast confirms queueing, not completion. Idempotent responses
that have already advanced are described using their returned status. Conflicts refresh the
library and ask the user to review its latest state.

The visible library uses one cached list request every five seconds while any displayed job
is queued or processing. Polling stops when the page is hidden, offline, unmounted, or has no
active displayed jobs. Reconnection revalidates access before actions resume. Navigation,
expanded details, and keyboard focus remain stable during background updates.

Temporary refresh failures retain the last verified rows with a stale-data notice and pause
actions. A 401, 403, or 404 clears protected content through the existing access-rejection
boundary. One contextual live region announces meaningful job/stage changes; unchanged
poll results remain silent. Mutations invalidate the affected library, processing summary,
and audit history. Observed background processing changes also invalidate relevant summaries
and audit history.

The web tests cover role eligibility, labels, feedback, refresh decisions, stale/access-denied
states, request sharing, and cache invalidation. Browser verification uses isolated fictional
fixtures for state transitions, dialogs, keyboard focus, connection failures, navigation, and
responsive layouts. Jobs advance only when the dispatcher and workers are running.

## Processing API

| Endpoint                                               | Body                                                                                          | Successful response                 |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------- | ----------------------------------- |
| `GET /cases/:caseId/documents/:documentId/processing`  | None                                                                                          | Latest processing summary, HTTP 200 |
| `POST /cases/:caseId/documents/:documentId/processing` | `{ "expectedJobId": null }` or `{ "expectedJobId": "<latest-failed-or-cancelled-job-uuid>" }` | Resulting job summary, HTTP 200     |

Both routes require a valid Microsoft bearer token and an active application profile.
Unknown query/body fields are rejected; responses use `Cache-Control: no-store`.
Assigned Staff can read available documents; Admin and Super Admin can also read removed
metadata. Archived cases remain readable. Start/retry requires Admin or Super Admin,
an available document, and a current case. Inaccessible or mismatched case/document IDs
return 404. Visible pending uploads return `409 DOCUMENT_UNAVAILABLE`.

The shared `processingSummarySchema` has three fields:

- `status`: `not_processed`, `queued`, `processing`, `ready`, `failed`, or `cancelled`.
- `job`: the existing public job contract, or null when no job exists. It includes the
  job/document/requester IDs, stage, extraction attempt count/limit, safe failure code,
  and creation/update/completion timestamps.
- `result`: null until Ready; then `{ "extractionMethod": "native" | "ocr", "pageCount": 1..20, "pipelineVersion": "1" }`.

An existing document without a job returns exactly:

```json
{ "status": "not_processed", "job": null, "result": null }
```

Failure codes use the shared `ProcessingFailureCode` constants and
`processingFailureMessages` for display text. No provider error text, source locations,
artifact references, Textract IDs, lease tokens, or credentials appear in these responses.
A Ready job with a missing durable result fails closed with 503 instead of reporting an
incomplete result as usable. This API does not serve extracted text or artifact downloads.

Initial requests use `expectedJobId: null`. Retries use the latest failed/cancelled job ID.
Concurrent or repeated identical requests return the same resulting job at its current
state. A replay of its original creation request can return a job that has since become
Ready; it never starts another job. Requests to retry a Ready or active job, stale
expectations, and unknown expected job IDs return `409 PROCESSING_CONFLICT`.
Removed documents return `409 DOCUMENT_UNAVAILABLE`; archived cases return `409 CASE_ARCHIVED`.
The existing database function rechecks permissions under the administrative transaction
lock and atomically creates the job, dispatch record, and audit event.

`GET /cases/:caseId/documents` adds a `processing` summary to each item. Visibility,
filters, totals, stable pagination, latest job, and result summary are read from one SQL
snapshot. The indexed latest-job join runs only for the requested page, with no separate
request or SQL round trip per document. Upload and remove/restore response contracts
remain unchanged; clients refresh the library after mutations.

The API runtime can read only four result-summary columns under the existing
job/document/case RLS chain. Artifact fields remain inaccessible, and the API receives
no direct table-write permissions.

Starting a job records work in PostgreSQL. Execution requires a dispatcher and consumers;
the database itself does not send messages or perform OCR. API tests use local fixtures
without cloud credentials.

Integration tests verify signed-token requests, roles, cross-case IDs,
archived/removed/pending documents, strict inputs, idempotency, concurrent retries,
permission races, audit rollback, RLS/column grants, safe native/OCR summaries, missing
results, and migration preservation on disposable PostgreSQL databases.

## Job and dispatch records

The processing migration adds `document_processing_jobs` and `processing_dispatches`
to the private `caseflow` schema. Processing lifecycle is separate from document
availability and document versions. Historical documents are not automatically queued.

Verified upload completion atomically saves the
available document, completed upload session, queued processing job, dispatch record,
and audit events. Repeated completion requests return the existing upload without
creating another job. Each job snapshots the verified source object version and checksum.

The database foundation includes:

- Queued, processing, ready, failed, and cancelled job states; no job represents an
  unprocessed document. Extraction and collection attempts are each bounded at five, with fenced worker
  leases, durable OCR request parameters, and safe failure codes.
- An administrator-only start/retry function with expected-job checks and one active
  job per document. New attempts preserve previous jobs and audit history. Removed
  documents and archived cases cannot start or retry processing.
- RLS and column grants for case-authorized job metadata. Runtime credentials cannot
  write either table or select source storage details from processing jobs.
- A separate `caseflow_dispatcher` role created without login credentials. Its only
  application functions claim dispatch records, acknowledge successful sends, or
  release failed sends for retry. It cannot read application tables directly.
- Dispatch claims of at most 25 records, 60-second token-fenced leases, and a 30-second
  delay after send failures. Expired leases can be reclaimed after a sender crash.
  Dispatch retries are not capped; monitoring must surface repeated send failures.

The queue sender must commit its claim before making network requests. A crash after
sending but before acknowledgment can deliver a job more than once; the worker
deduplicates by job ID. Messages contain only a schema version and job ID, never
client-provided storage locations or credentials.

The database foundation does not create cloud resources or run OCR. The processing API
exposes job state and the document library provides authorized start/retry controls. The
[API dispatcher](#api-processing-dispatcher) sends queued jobs once enabled; until then, new jobs
remain queued in PostgreSQL. Starting the API never applies migrations.

Integration tests cover atomic rollback, completion and retry idempotency,
role changes, RLS, dispatch concurrency and expired claims, migration preservation,
and repeatable seeds using disposable local databases.

## Processor database

The processor database interface provides restricted worker
functions, 180-second job leases, separate extraction/collection retry counters,
versioned artifact references, service audit events, and a shared OCR allowance of
100 pages per UTC day (maximum 20 PDF pages per job). Removal and archival cancel
unfinished processing atomically; restoration requires an explicit retry.

The `caseflow_processor` role has no login and no direct table access. Workers connect
through a separate restricted login. [Processor database](processor-database.md) describes
the transaction contract, claim outcomes, artifact format, and allowance behavior. Audit
records created before this migration have a null service identity.

## Python extraction worker

The worker validates queue messages, verifies the saved S3 source version/checksum,
extracts native PDF text in a bounded subprocess, and starts OCR through saved,
idempotent requests. [Python processor setup](python-processor.md) covers its
configuration, limits, and tests. The
[Textract completion consumer](textract-completion.md) collects complete OCR results and
publishes immutable artifacts. The [reconciler](processing-recovery.md) recovers stalled delivery
and lost notifications. Workers run separately from the API.

## API processing dispatcher

The API includes an opt-in background dispatcher in `apps/api/src/processing/`.
Configuration, PostgreSQL queries, SQS operations, orchestration, and Fastify lifecycle
hooks are separate modules. The internal dispatch-claim schema and type live in the
API processing module; shared packages contain application and queue contracts.
There is no public dispatch endpoint and no browser configuration. It starts only after the API begins listening, polls once per second
between batches, and sends at most five jobs concurrently per API instance. Its
separate PostgreSQL pool holds at most two connections.

Each database claim commits before SQS I/O. A send has a 20-second deadline, shortened
when necessary to leave a 10-second lease margin. SDK requests use bounded connection
and request timeouts with at most three attempts. Successful sends are acknowledged
with the SQS message ID and lease token; failed sends use the existing 30-second
database backoff. Expired leases recover interrupted work. Shutdown stops polling,
aborts pending sends, waits for bounded database operations, and closes both clients.

Delivery is **at least once**. If SQS accepts a message but acknowledgement fails, its
lease eventually expires and another dispatcher may send the same job again. A send
timeout also cannot prove SQS rejected the message. Worker idempotency by job ID is
required. Dispatch attempts are distinct from processing attempts and do not mark a
processing job failed. PostgreSQL coordinates concurrent API instances; dispatching
runs only while at least one enabled API process is running.

### Dispatcher credentials and configuration

The dispatcher connects with its own login that inherits only the `caseflow_dispatcher` NOLOGIN
role. It can call only the three dispatch functions; it cannot read application tables or manage
users, and it is never granted runtime or operator membership. Connections use full TLS
verification against a trusted CA. The API's AWS identity needs only `sqs:SendMessage` on the
processing queue, in addition to its scoped S3 permissions; it has no receive or delete rights.

Server-only dispatcher settings:

| Setting                              | Purpose                                                                       |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| `PROCESSING_DISPATCHER_ENABLED`      | `false` by default; `true` enables dispatching                                |
| `PROCESSING_DISPATCHER_DATABASE_URL` | Restricted dispatcher connection described above                              |
| `PROCESSING_QUEUE_URL`               | HTTPS URL of the standard processing queue, not the completion queue or a DLQ |
| `AWS_REGION`                         | Selected Region for queue requests                                            |
| `AWS_PROFILE`                        | Optional restricted local workload identity                                   |

The queue URL must match `AWS_REGION`. Explicit local profiles are used without falling
back to unrelated environment credentials. Cloud workloads use temporary role credentials through the SDK credential chain. Invalid enabled configuration fails
at startup with value-free errors. Disabled configuration creates no dispatcher clients.

Dispatching is off by default. Existing uploaded documents are not automatically backfilled.

Logs contain event names and job/dispatch IDs, never connection strings, credentials,
lease tokens, document contents, or raw provider errors. `processing_dispatch_sent`
means SQS accepted the message and PostgreSQL recorded the acknowledgement; it does
not mean document processing completed. Failed acknowledgements leave the lease for
recovery.

Unit tests cover configuration, signed requests, safe errors, timeouts, and server
lifecycle. Disposable PostgreSQL integration tests cover concurrent senders, committed
claims before network I/O, failure backoff, duplicate delivery after acknowledgement
loss, stale lease fencing, and restricted credentials. These tests use an injected SQS
adapter and never send messages to the live processing queue.

## Related guides

- [Document management](document-management.md)
- [Hosted database](hosted-database.md)
- [Processor database function reference](processor-database.md)
- [Lambda configuration](lambda-configuration.md)

## Recovery and monitoring

See [processing recovery](processing-recovery.md). The scheduled reconciler resets tracked outbox
records, inspects saved OCR jobs, and emits aggregate health metrics.
