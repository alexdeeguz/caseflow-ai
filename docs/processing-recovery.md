# Processing recovery and monitoring

[Back to README](../README.md)

Recovery repairs interrupted delivery and missing OCR notifications while preserving the original
job, source version, OCR request token, and reserved page allowance. See
[workflow verification](processing-verification.md) for test coverage and its limits.

## Recovery rules

| Condition                                                                       | Action                                                                                                           |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Sent processing delivery has no progress for at least 15 minutes; no live lease | Reset the same outbox record to pending, preserving its job ID and send-attempt history                          |
| Extraction lease expired                                                        | Use the same tracked redispatch path; the old ownership token cannot publish                                     |
| OCR start accepted but receipt not saved                                        | Redispatch the same job; the processor verifies the original S3 version and repeats only its saved request/token |
| Waiting OCR or expired collection lease, unchanged for 15 minutes               | Inspect the saved Textract ID; if finished, use the existing fenced collector                                    |
| Provider still running or temporarily unavailable                               | Persist the next check 15 minutes later; do not allocate a new provider job                                      |
| Three automatic redispatches already used, or worker attempts exhausted         | Fail with `attempts_exhausted`; require diagnosis and explicit administrator retry                               |
| Unresolved OCR reaches six days from its original reservation                   | Fail with `ocr_results_expired`, including uncertain starts                                                      |
| Removed document, archived case, or changed source snapshot                     | Cancel or fail through the existing locked lifecycle functions                                                   |
| Ready, failed, cancelled, or budget-exhausted job                               | Never automatically revive it                                                                                    |

The original's exact version, length, content type, and checksum are checked before every
Textract start, including an uncertain-start retry. No latest-version fallback is allowed.
[Textract request tokens and results last seven days](https://docs.aws.amazon.com/textract/latest/dg/api-async.html).
A repeated successful start returns the original provider ID without another completion
notification. The six-day cutoff leaves margin for intervention. Already accepted OCR may
continue after application cancellation; recovery cannot cancel provider billing retroactively.

Redispatches are distinct from SQS receive counts, outbox send attempts, extraction attempts,
and collection attempts. Recovery allows at most three redispatches per application job.
Existing extraction and collection limits remain five each. Pending or leased outbox records
belong to the API dispatcher; recovery does not steal their lease or send SQS messages directly.
If the dispatcher is stopped, recovery can prepare pending work but cannot deliver it.

## Database interface

The recovery migration preserves existing rows, source snapshots, results, RLS, and credentials, and adds:

| Object                                                      | Purpose                                                              |
| ----------------------------------------------------------- | -------------------------------------------------------------------- |
| `recovery_count`                                            | Persisted, maximum-three redispatch counter                          |
| `recovery_check_count` / `recovery_next_check_at`           | Inspection history and durable pacing                                |
| `processing_recovery_due` / `processing_ocr_expiry` indexes | Due-work lookup and six-day expiry lookup                            |
| `reconcile_document_processing(bucket, environment)`        | Consider one due job in one short transaction                        |
| `check_processing_recovery(job, provider)`                  | Recheck source/case state and provider correlation before inspection |
| `processing_health(bucket, environment)`                    | Aggregate operational metrics without identifiers                    |
| `recover_processing_job(job)`                               | Operator-only targeted recovery using the same checks and limits     |

The `caseflow_recovery` NOLOGIN permission role can call reconciliation/health functions and
the existing fenced collection/renew/fail/complete functions. It cannot claim extraction,
reserve OCR pages, bind new provider IDs, send dispatches, read tables directly, or write tables.
Functions use fixed search paths and explicit grants. The existing permission lock and
case/document/job lock order coordinate recovery with removal and archival. Redispatch and its
`document.processing_recovered` audit event commit together.

Recovery connects through its own restricted login that inherits only `caseflow_recovery`, with
credentials in a separate secret. It shares the processor's packaged CA verification, hostname
checks, disabled prepared statements, bounded connections, and five-minute secret refresh, and is
never granted processor, API, or operator membership.

## Scheduled runtime and IAM

The SAM stack adds a third Python function and an EventBridge Scheduler schedule:

- Runs every five minutes with no flexible window; the schedule can be switched off independently.
- Shared Regional concurrency, 120-second timeout, at most 25 database candidates per invocation.
  There is no dedicated slot or hard single-invocation cap. Database locks, durable next-check
  times, and fenced collection leases coordinate overlapping invocations. Capacity contention
  may delay recovery; monitor throttles and missing runs.
- Stop starting candidates with less than 60 seconds remaining. Collection checkpoints leave
  time for safe failure and a final health snapshot; unfinished work stays unpublished.
- No Scheduler delivery retry or Lambda asynchronous retry storm; persisted pacing and the
  next scheduled invocation handle recovery. Failed invocations appear in Lambda metrics.
- Scheduler's role can invoke only this function and trusts only its schedule group/project.
- Recovery can read only its own secret, write its own logs, read Textract results, and write/
  verify encrypted artifacts in the configured environment. It cannot start Textract, pass a
  notification role, consume/send/purge queues, read originals, or delete object versions.
- Existing queues, DLQs, bucket, topic, and notification role remain externally managed.

No preview, normalized PDF, or new processing pipeline is introduced. The existing collector
validates all result pages, enforces limits, writes immutable artifact sets, and publishes under
a fenced lease. A lost database commit after S3 writes leaves unpublished versions for review.

## Monitoring

Alarms notify a separate operational alert topic, never the OCR completion topic.

| Signal                                            | Alarm behavior                                     |
| ------------------------------------------------- | -------------------------------------------------- |
| Each DLQ's visible message count                  | Greater than zero                                  |
| Each main queue's oldest-message age              | Greater than 900 seconds                           |
| Each function's errors and throttles              | Greater than zero per five-minute period           |
| Expired leases / recovery errors / exhausted jobs | Greater than zero                                  |
| Oldest pending dispatch age                       | Greater than 900 seconds                           |
| Reconciliation heartbeat                          | Missing or below one for three five-minute periods |

The missing-run alarm has actions enabled only when both recovery and an alert topic are
configured. Other alarms treat missing data as nonbreaching. AWS native queue/function metrics
are complemented by raw JSON [embedded metrics](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html)
under `CaseFlow/Processing`. The only custom dimension is `Environment`; use one recovery
stack per environment/database to avoid merging unrelated environments' metrics. No document,
user, provider, or lease identifiers are metric dimensions. Safe diagnostic logs may contain
job IDs and failure codes, never document text, filenames, credentials, or provider responses.

The dashboard shows rolling-24-hour Ready/Failed counts, mean end-to-end latency in seconds,
attempts for jobs created in that window, backlog/lease health, queue state, function failures,
and OCR pages reserved against the shared 100-page UTC-day allowance. These are sampled gauges:
use Maximum/Latest, not Sum, to read rolling counts or allowance usage. Heartbeat and recovery
errors/checks are per-invocation counts. A heartbeat is emitted only after database health
retrieval succeeds. At larger history volumes, replace full health aggregation with reviewed
incremental rollups; the current database statement deadline bounds query duration.

The application allowance limits reserved OCR pages, not total AWS dollars. It is shared by
all environments using the same database and does not refund uncertain starts. AWS Budgets
and project spending controls are separate: they cover AWS usage, can notify or pause a project,
and do not replace the application's reservation check.
CloudWatch alarms, custom metrics, dashboards, Secrets Manager, and Lambda can incur charges.

## Operator recovery

When automatic recovery stops (exhausted attempts, expired OCR, or a malformed delivery), an operator
investigates and uses the tracked paths rather than editing tables or queues directly:

- An operator-only database function redispatches one active job with the same lease, source,
  timing, three-redispatch, six-day, and audit checks. It never sends to SQS directly; the API
  dispatcher delivers the resulting outbox record.
- Failed or cancelled jobs use the application's explicit **Retry**, which creates a new job and may
  reserve new OCR pages. Terminal jobs are never revived by editing data.
- Missing completion notifications are resolved by bounded reconciliation against the saved
  provider ID, never by a manufactured notification or a replacement OCR start.
- Dead-letter messages are reviewed individually and correlated with the database; queues are never
  purged as routine repair.

The recovery function accepts only a fixed reconcile payload, never job IDs or storage locations.

## Unpublished artifact review

A lost database commit after S3 writes leaves unpublished artifact versions. The helper
`services/document-processor/scripts/report_unreferenced_artifacts.py` compares an S3 version
inventory with published artifact references by bucket, key, **and** version ID, excludes active
jobs and artifacts younger than seven days, and produces a candidate report. It makes no network
calls and deletes nothing. Every referenced version is preserved, and no Lambda role has delete
permission.

## Verification

The Python unit and integration suites, SAM lint, infrastructure policy tests, Guard,
and Linux package checks cover the recovery path. Disposable-database tests cover migration preservation,
repeatable seeds, counters, concurrent recovery, stale leases, cancellation, six-day expiry,
OCR reservation preservation, restricted credentials, and atomic audit rollback. Local provider
stubs verify bounded probes, missing/partial/expired results, safe errors and deadline behavior.
