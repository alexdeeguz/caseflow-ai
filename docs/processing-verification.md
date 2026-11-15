# Processing workflow verification

[Back to README](../README.md)

Processing requires compatible hosted migrations, restricted database logins, secrets, deployed
consumers, and the dispatcher. Passing local tests does not prove that those deployed services
can communicate. Keep the release record outside Git when it contains project identifiers,
subscriber addresses, or test-document metadata.

## Current verification boundary

The API, processor, collector, recovery, migration-preservation, and permission suites pass on
disposable local databases. The SAM configuration and proposed IAM policies pass validation.
Linux packages verify dependency architecture, packaged CA trust, and parser memory enforcement.
A one-page fictional PDF also completes native extraction through the real database
functions with simulated storage; duplicate delivery publishes only once and never starts OCR.

The hosted development workflow was activated on November 15, 2026. All eleven migrations are
applied. Processor and completion share the restricted processor credential; recovery uses its
own restricted credential. All use verified TLS, packaged CA trust, and shared Regional Lambda concurrency. The two SQS mappings each
limit concurrency to two; recovery has no reserved slot. Its five-minute schedule and continuous
API dispatch are enabled. The API must remain running to send newly queued database work.

Live verification established:

- The supplied fictional native PDF reached Ready without OCR; a scanned copy and PNG reached
  Ready through Textract, SNS, the completion queue, and the collector.
- All eight published artifacts matched their saved S3 versions, checksums, sizes, encryption,
  cache settings, and source provenance. OCR artifacts retained page numbers and line confidence.
- Duplicate native/processor/completion deliveries left one result and completion audit per
  successful job. The two OCR jobs reserved two pages total; duplicates added no reservations.
- A deliberately invalid image failed before OCR. Explicit retry, removal cancellation,
  restoration, and automatic API dispatch were exercised without modifying historical jobs.
- Recovery repaired an overdue delivery through the existing outbox. A subsequent scheduled run
  emitted a successful heartbeat with no errors, backlog, or expired leases.
- CloudWatch ALARM and OK emails reached the confirmed subscriber. All 15 alarms were OK and
  both DLQs were empty at the final checks. Browser checks covered administrator controls, document status refresh, mobile
  cards, keyboard confirmation, navigation, and a byte-for-byte verified report download.

Versioned Textract notifications include `S3ObjectVersion`. The collector accepts that optional
provider field and checks it against the trusted database snapshot when present. A regression
fixture covers the actual shape; unknown fields and mismatched source versions remain rejected.

Deployments use reviewed change sets and shared concurrency without reserving capacity.
Exact resource identifiers, test jobs, and change sets are recorded privately.

Remaining verification limits: live browser checks used the existing Super Admin session, not a
second Staff sign-in. Role boundaries and race/failure matrices are covered by real PostgreSQL
integration tests; not every race or malformed-file fixture was reproduced in AWS. Whole-repository
formatting still flags unrelated existing files; changed-file checks pass. Production app hosting,
previews, extracted-text display, and any reviewed artifact cleanup remain separate work.

## Automated checks

Use [local database verification](development.md) to configure an explicitly local operator
connection. The integration fixtures create and remove disposable databases; never substitute a
hosted connection or reset the working database. Run from the repository root:

```sh
npm test
npm run test:integration
npm run lint
npm run typecheck
npm run build
npm run format:check
npm audit --audit-level=low
uv run --project apps/document-processor --locked pytest apps/document-processor/tests --require-database
uv run --project apps/document-processor --locked ruff check apps/document-processor infra/document-processing
uv run --project apps/document-processor --locked ruff format --check apps/document-processor infra/document-processing
uv run --project apps/document-processor --locked mypy apps/document-processor/src --strict
uv run --project apps/document-processor --locked pip-audit --progress-spinner off
```

The Python integration suite requires `PROCESSOR_TEST_DATABASE_URL` for the disposable local
PostgreSQL server. A missing integration configuration must fail verification, not silently skip
it. On macOS the Linux address-space test skips; the container package check exercises that limit.
Run the [SAM, security, IAM, and Linux package checks](lambda-configuration.md#build-and-validation)
with both locked environments. CI uses local databases and test fixtures, without hosted secrets
or deployment credentials. A formatting failure in an unrelated file must be reported rather
than silently excluded from a claim that the whole repository passes.

| Area             | Required evidence                                                                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extraction       | Native, scanned, mixed, sparse, blank, malformed, encrypted, oversized PDF/image fixtures; all pages considered                                          |
| Source integrity | Saved S3 version only; size, signature, checksum, and source mismatch rejection                                                                          |
| Delivery         | Duplicates, early notifications, uncertain starts, lost acknowledgments, bounded pagination, throttling                                                  |
| Publication      | Fenced leases, one atomic result/audit, stale collector rejection, S3 success followed by database failure                                               |
| Authorization    | Staff/Admin boundaries, disabled users, removed documents, archived cases, inaccessible IDs                                                              |
| Recovery         | Same-job outbox redispatch, three-recovery limit, missed notifications, six-day cutoff, budget preservation                                              |
| Upgrade          | Start at the seven-migration foundation; preserve users, assignments, documents, sessions, jobs, dispatches, audit; repeat seeds only on disposable data |
| Contracts        | Shared TypeScript/Python queue fixtures, strict public responses, no storage/provider/credential fields                                                  |

## Prepare the live run

1. Verify the AWS project and Ohio Region, Paid-plan/Textract access, credits, and relevant quotas.
   Credit balance is not a guarantee of a Textract free allowance. Check current billing details
   separately from the application's shared 100-page UTC-day OCR allowance.
2. Inventory the hosted migration history and run an explicitly targeted dry run. Review the
   exact pending filenames before applying additive migrations. Do not seed or reset hosted data.
3. Provision [processor credentials](processor-database.md#provision-the-processor-login) and
   [recovery credentials](processing-recovery.md). Verify their grants and transaction-pooler TLS.
   Store their different passwords in separate Secrets Manager secrets.
4. Review the [disabled-trigger change set](lambda-configuration.md#review-and-deploy-with-consumption-disabled).
   Existing queues, document bucket, Textract topic, and notification role remain external.
   Confirm the separate alert subscriber and test the actual alarm-to-email route.
5. Inventory queued jobs and dispatch records before enabling consumers. SQS messages can expire
   while their database dispatch remains `sent`. Inspect a specific overdue job and use the
   bounded [operator recovery procedure](processing-recovery.md#targeted-operator-recovery); never purge a
   queue, mark every dispatch pending, or send untracked replacement messages.
6. Record each fictional test's case/document/job ID, source version/checksum, result references,
   and expected extraction path privately. Use the selected native report unchanged. A separately
   identified rasterized copy and image can test OCR; do not replace the original source version.

## Controlled activation and live acceptance

The deployment parameters are independent and default to `false`. CloudFormation rejects
processing enabled with completion disabled. These are deployment changes and require review.

| Stage                     | Completion consumer | Processing consumer | Recovery schedule | Continuous dispatcher |
| ------------------------- | ------------------- | ------------------- | ----------------- | --------------------- |
| Initial deployment        | Off                 | Off                 | Off               | Off                   |
| Completion readiness      | On                  | Off                 | Off               | Off                   |
| Controlled document tests | On                  | On                  | Off               | Off                   |
| Recovery verified         | On                  | On                  | On                | Off                   |
| Normal operation          | On                  | On                  | On                | On                    |

For controlled tests, use the existing dispatch service for a bounded cycle after inventorying
its eligible backlog. Continuous dispatch stays off; every send still claims and acknowledges
its persisted outbox record. Enabling a mapping consumes existing messages too, not just new ones.

- Native PDF: reach Ready with page-oriented text/manifest artifacts and no OCR reservation/start.
- Scanned PDF and image: verify processor → Textract → SNS → completion SQS → collector, exact
  source/result versions, expected page counts, and a single completion audit.
- Duplicate the reviewed job's delivery: retain the same OCR request and one published result.
- Exercise one cancellation, failure/retry, and lost-progress recovery. Inspect counters and
  allowance before/after; do not alter unrelated jobs or create replacement paid OCR requests.
- Verify upload/status progression, confirmation modals, queued toasts, meaningful errors,
  Staff/admin visibility, refresh/Back/Forward, keyboard/mobile layouts, and downloads.
- Confirm alarm and recovery heartbeat delivery; then enable the five-minute schedule. Enable
  continuous dispatch last and monitor initial jobs. Do not automatically backfill old documents.

## Evidence, rollback, and cleanup

Record actual outcomes and limitations for each row; a simulated provider check does not count
as live OCR or alert delivery. Capture safe identifiers and failure codes without saving signed
URLs, credentials, extracted text, or full provider events in logs or public documentation.

For rollback, pause continuous dispatching and the recovery schedule, disable processing, then
disable completion. A reviewed stack update can set both consumer flags to `false` together.
Allow in-flight invocations up to 120 seconds to finish. Disabling triggers does not cancel an
already accepted Textract job or undo writes. Preserve queues, jobs, reservations, audit history,
and referenced S3 versions. Redeploy the previous compatible packages with triggers disabled;
use additive database fixes instead of destructive migration rollback.

Only remove explicitly identified disposable test resources. Referenced artifact versions remain
protected; unreferenced artifact reports require operator review before any deletion. Keep commit,
push, deployment approval, and activation decisions explicit in the release record.
