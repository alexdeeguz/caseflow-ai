# Processing recovery and monitoring

[Back to README](../README.md)

Recovery repairs interrupted delivery and missing OCR notifications while preserving the original
job, source version, OCR request token, and reserved page allowance. Recovery and alerts are
verified in the active hosted development environment. Applying migrations, provisioning credentials,
and activating a new deployment still require the [workflow checks](processing-verification.md).

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

Apply `20261115203559_processing_recovery.sql` through the reviewed migration workflow.
It preserves existing rows, source snapshots, results, RLS, and credentials, and adds:

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

Create a separate login using an operator connection after reviewing the migration:

```sql
create role caseflow_recovery_login
  login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
grant caseflow_recovery to caseflow_recovery_login with inherit true, set false;
```

Set its unique password interactively with `\password caseflow_recovery_login`. Store it in a
separate Secrets Manager secret with the same structure as the processor secret, but username
`caseflow_recovery_login.YOUR_PROJECT_REFERENCE`. Use the Ohio transaction pooler, numeric
port `6543`, and database `postgres`. Supply its ARN as `RecoveryDatabaseSecretArn`.
The recovery runtime loads `RECOVERY_DATABASE_SECRET_ARN`; local tests can supply
`RECOVERY_DATABASE_URL`. Lambda rejects direct connection strings. Packaged CA verification,
hostname checks, disabled prepared statements, bounded connections, and five-minute secret
refresh are shared with the processor. Never grant processor, API, or operator membership to
this login.

## Scheduled runtime and IAM

The SAM stack adds a third Python function and an EventBridge Scheduler schedule:

- `rate(5 minutes)`, flexible window off, `EnableRecoverySchedule=false` by default.
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

## Monitoring and alert setup

Pass the existing processing and completion DLQ ARNs as `ProcessingDlqArn` and
`CompletionDlqArn`. Pass a **separate operational SNS topic** as `AlarmTopicArn`; never point
alarms at the Textract completion topic. Create/confirm the intended subscriber and allow
CloudWatch to publish to the topic. With a customer-managed encryption key, the topic/key
policy must also allow the CloudWatch service. The stack does not create subscriptions or
change external topic/key policies. An empty ARN leaves alarm actions disabled and is suitable
only for preparing the stack, not operational activation.

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
and do not replace the application's reservation check. Confirm their thresholds before activation.
CloudWatch alarms, custom metrics, dashboards, Secrets Manager, and Lambda can incur charges.

## Targeted operator recovery

1. Inspect the alarm, safe logs, and job using an operator database session. Check its current
   status, attempts, recovery count, next check, source version, and outbox status. Do not paste
   credentials, provider responses, or extracted text into logs or tickets.
2. Correct the cause: IAM, secret/TLS configuration, dispatcher availability, malformed delivery,
   provider failure, or exhausted allowance. Check case archival/document removal and verify the
   **exact saved S3 version** with an operator `head-object --version-id` request. Do not substitute
   the latest object or reset the saved OCR token/request.
3. For an active job with a lost processing delivery, run one targeted call as the operator:

   ```sql
   select caseflow.recover_processing_job('REVIEWED_JOB_UUID'::uuid);
   ```

   This uses the same lease, source, timing, three-redispatch, six-day, and audit checks. It does
   not send directly to SQS. The API dispatcher sends the resulting pending outbox record.
   A deferred or terminal result must be investigated, not overridden with direct table edits.

4. For a failed/cancelled job, use the application's explicit **Retry** action after correcting
   the cause. That creates a new application job and may reserve new OCR pages. Do not make a
   terminal job active by editing SQL. Budget failures must wait for allowance or a reviewed change.
5. For a missing completion notification, let one bounded reconciliation invocation inspect the
   saved provider ID. Do not manufacture a notification or create a replacement OCR start.
6. Inspect a DLQ **one message at a time** with a short visibility timeout. A receive temporarily
   hides it; this is not deletion. Correlate its job ID with the database. Prefer the tracked
   recovery/API retry paths above. Delete only the reviewed DLQ message using its receipt handle
   after verifying recovery or confirming it is a terminal duplicate. Never purge a queue or
   start a whole-DLQ message move as a routine repair. Malformed payloads require investigation.

For a controlled invocation after deployment, use the recovery function with the fixed payload
`{"schemaVersion":1,"task":"reconcile"}` and leave the schedule disabled until verification.
Review the returned check/error counts and database/audit outcome. It does not accept arbitrary
job IDs or storage locations from an invocation payload.

## Unpublished artifact review

Use an operator-only S3 version inventory and a database export of published artifact references.
Compare `(bucket, key, versionId)`, not keys alone. Preserve every version referenced by
`caseflow.document_processing_results.artifacts`, even if a newer version exists. Exclude any
active job or artifact younger than seven days. The helper
`services/document-processor/scripts/report_unreferenced_artifacts.py` creates a local JSON candidate report from those two
exports; it makes no network calls and deletes nothing. Its `--help` describes the input formats.
Export references for the same bucket with an operator query, saving the result privately:

```sql
select coalesce(jsonb_agg(jsonb_build_object(
  'jobId', j.id, 'status', j.status, 'artifacts', coalesce(r.artifacts, '{}'::jsonb)
)), '[]'::jsonb)
from caseflow.document_processing_jobs j
left join caseflow.document_processing_results r on r.job_id = j.id
where j.source_bucket = 'REVIEWED_BUCKET_NAME';
```

Do not use a truncated inventory or filter out published results. Treat the report as a review list: refresh database references and recheck job state immediately
before any separately authorized cleanup. Do not add deletion permissions to Lambda roles.

## Verification and activation

Run the existing Python unit/integration suites, SAM lint, infrastructure policy tests, Guard,
and all three Linux package checks. Disposable-database tests cover migration preservation,
repeatable seeds, counters, concurrent recovery, stale leases, cancellation, six-day expiry,
OCR reservation preservation, restricted credentials, and atomic audit rollback. Local provider
stubs verify bounded probes, missing/partial/expired results, safe errors and deadline behavior.

After reviewing and applying the deployment separately, verify the real alert route: use
CloudWatch's `set-alarm-state` on a selected test alarm, confirm receipt at the intended subscriber,
then return it to OK and verify recovery delivery. This verifies notification routing, not the
metric threshold. Also perform a controlled stalled-job/DLQ scenario to verify actual metric
publication and evaluation; clean up only its test records/messages. Local wiring tests cannot
prove SNS subscriber delivery. Keep `EnableRecoverySchedule=false` until these checks pass.

For rollback, disable the schedule and queue mappings, pause dispatching, and let in-flight
invocations finish. Deploy the previous reviewed application package; keep the additive database
columns and immutable artifacts. Do not reset counters, purge queues, or delete published results.
