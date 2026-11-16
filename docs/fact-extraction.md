# OpenAI fact extraction

Fact extraction is a separate stage after document text processing reaches Ready. An Admin or
Super Admin requests extraction for an available document in a current case. The feature creates
unreviewed dates, providers, treatments, and findings with exact source quotations. It does not
approve facts, generate summaries, or process historical documents automatically.

New deployments default to disabled queue consumption, API dispatch, and scheduled fact recovery.
Enable each only after reviewing its configuration and verifying the live workflow. Extraction
remains an explicit administrator action even when the dispatcher and queue consumer are enabled.

## Verified development deployment

On November 15, 2026, controlled native PDF, scanned PDF, and image runs completed with 8, 10, and
13 source-linked facts respectively. The image run exercised the continuous API dispatcher and
Lambda queue trigger from the application request through publication and visible review records.
The fact consumer and local API dispatcher are enabled; the API must remain running to dispatch
new database tasks. Scheduled fact recovery remains deferred to a separate deployment and check.

The facts endpoint also requires the human-review migration, `20261116011952_human_review.sql`.
It initializes review records for existing facts without changing their original values or evidence.
A completed extraction count alone does not verify that this read-path prerequisite is installed.
All newly published facts remain Unreviewed; these checks do not establish complete extraction recall.
No historical documents are automatically submitted for extraction.

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

1. The API commits an extraction job, preparation task, dispatch record, and audit event together.
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

The application supplies document/result IDs and evidence offsets. Every quotation must occur
exactly in its checkpointed page text. Offsets count Unicode code points and are end-exclusive.
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

Migration `20261115230115_fact_extraction.sql` adds private-schema jobs, tasks, dispatches,
versioned model prices, daily usage/reservations, facts, and evidence. Existing profiles, cases,
documents, assignments, processing results, and audit history are preserved. It does not backfill
extraction jobs or create login passwords.

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

The document list includes the latest summary in its existing query, without one query per document.
The UI separates text processing from fact extraction, confirms the document and provider before
submission, and reports that work was queued. It polls visible active work every five seconds and
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

## Local verification

```sh
uv sync --project services/fact-extractor --locked
npm test
npm run test:integration
uv run --project services/fact-extractor --locked pytest services/fact-extractor/tests
uv run --project services/fact-extractor --locked ruff check services/fact-extractor
uv run --project services/fact-extractor --locked mypy services/fact-extractor/src --strict
uv run --project services/fact-extractor --locked pip-audit --skip-editable
```

For Python database tests, explicitly set `FACT_TEST_DATABASE_URL` to the local PostgreSQL operator
connection. The fixture accepts only a loopback server and creates/drops isolated databases. Without
that variable, database tests are skipped; CI supplies it. Tests do not use hosted credentials or call
OpenAI. Existing processor checks now run from `services/document-processor`.

The committed fictional fixtures exercise dates, ambiguity, negation, recommendations, conflicts,
Unicode, irrelevant content, and document instructions. A live release evaluation is separate:

```sh
uv run --project services/fact-extractor --locked python services/fact-extractor/scripts/evaluate.py \
  --output /absolute/private/path/fact-evaluation.json
```

Set `OPENAI_API_KEY` privately in the command environment. Never put it on the command line or in
Git. The evaluation sends only committed fictional fixtures, has a separate conservative $0.50
per-invocation ceiling, and creates a private report outside the repository. Repeated invocations
have separate ceilings. Review every actual fact against the source and expected facts; record
unsupported facts and missed expected facts. Citation validation alone is insufficient. The report
never automatically approves release. Material errors block activation.

## Reviewed deployment

1. Verify the target project and Ohio Region. Review and apply the additive migration explicitly.
2. Create separate login roles using operator credentials. Grant only `caseflow_fact_extractor` to
   `caseflow_fact_extractor_login` and only `caseflow_fact_dispatcher` to
   `caseflow_fact_dispatcher_login`, with inherited membership and `SET FALSE`. Assign unique
   passwords through a private credential workflow.
3. Validate and build locally:

   ```sh
   uv run --project infra/document-processing --locked sam validate --lint --region us-east-2 \
     --template-file infra/fact-extraction/template.yaml
   uv run --project infra/document-processing --locked pytest infra/fact-extraction/tests
   uv run --project infra/document-processing --locked python infra/fact-extraction/scripts/build.py
   uv run --project infra/document-processing --locked python infra/fact-extraction/scripts/verify_build.py
   ```

4. Prepare and review a change set with `Environment`, the existing `DocumentBucketName`, the
   existing operational `AlarmTopicArn`, and `EnableConsumer=false`. The new stack owns only its
   fact queue/DLQ, Lambda, execution role, two empty secret resources, log group, alarms, and dashboard.
   It does not recreate the document bucket, OCR queues, Textract topic, or notification role.
5. After separate deployment approval, populate the generated database secret with JSON fields
   `host`, `port` (6543), `dbname` (`postgres`), `user`
   (`caseflow_fact_extractor_login.<project-ref>`), and `password`. Populate the OpenAI secret with
   `{ "api_key": "<private value>" }`. Secret values are absent from templates and outputs.
6. Lambda uses the hosted Ohio transaction pooler, disabled prepared statements, and `verify-full`
   with the packaged public CA. No laptop path or VPC/NAT dependency is required. The API dispatcher
   uses its own login through the same Session pooler endpoint as the API.
7. Grant the API execution role `sqs:SendMessage` only for the new fact queue. Configure
   `FACT_EXTRACTION_DISPATCHER_DATABASE_URL`, `FACT_EXTRACTION_QUEUE_URL`, and existing AWS Region/
   credential settings. Keep `FACT_EXTRACTION_DISPATCHER_ENABLED=false` until activation review.
8. Review the existing processing stack update with `EnableFactRecovery=false`. Fact recovery is
   an explicit opt-in extension; existing OCR recovery behavior is preserved by default.
9. Complete live fictional evaluation and restricted-runtime checks. Then separately authorize
   consumer, recovery, and dispatcher activation. Do not backfill historical documents.

The Lambda has a 120-second timeout, 1,024 MiB memory, 512 MiB temporary storage, Python 3.13 x86-64,
batch size one, partial batch responses, maximum mapping concurrency two, and shared concurrency.
The queue visibility timeout is 720 seconds. The role reads exact text object versions only, reads
its two secrets, consumes its own queue, and writes its own logs. It cannot write/delete S3 objects,
start Textract, access unrelated queues, or directly update database tables.

## Monitoring and rollback

The stack includes queue-age, visible-DLQ, and Lambda-error alarms, with an optional existing SNS
alert topic. The dashboard shows provider attempts, retries, failures, latency, completed chunks,
and conservative maximum allowance reservations. Reserved-usage metrics do not subtract later
settlements; PostgreSQL is authoritative for the actual remaining application allowance. Partial
batch failures do not count as Lambda invocation errors, so DLQ and queue-age alarms remain important.
Metrics use environment-only dimensions. Logs omit text, quotations, responses, and secrets.

Scheduled recovery checks overdue work in bounded batches, preserves task IDs and reservations,
and uses the outbox rather than direct queue sends. It cannot call OpenAI or reserve additional
usage. Exhausted jobs require an explicit administrative retry. Do not purge or redrive whole
queues automatically.

To pause, disable fact dispatch in the API, disable the fact event-source mapping, and turn off
`EnableFactRecovery`. Leave the existing OCR controls unchanged. In-flight provider calls may
finish; fenced publication and reservations still apply. Preserve jobs, facts, evidence, queues,
secrets, and audit history. The template retains queues, secrets, and logs on stack deletion.

### Evaluation review checks

The evaluator records a prompt checksum and checks expected provider affiliations and report
attribution in structured qualifiers. Exact citations alone do not satisfy those checks. Review
`missingQualifiers` alongside unsupported and missed facts before approving a release. These
fixture checks do not replace semantic review. Progress messages contain only fixture counts.
Choose a new report path for each run; existing reports are preserved.

Evaluation also reports `statusMismatches`, `unexpectedFactsWhenNoneExpected`, and
`missedExpectedFacts`. Coverage checks compare fixture values case-insensitively and preserve
category, polarity, date precision, status, and required qualifiers. Semantically equivalent
wording can still need reviewer adjudication; empty diagnostics do not prove general accuracy.
A passing small fixture run does not replace full-document verification before activation.
