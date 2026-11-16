# Processing workflow verification

[Back to README](../README.md)

Document processing is verified at two levels: automated suites against disposable local
databases, and end-to-end runs with fictional documents. Passing local tests shows the code and
database functions behave correctly; it does not by itself prove that separately hosted services
can communicate.

## What has been verified

The API, processor, collector, recovery, migration-preservation, and permission suites pass on
disposable local databases. Infrastructure configuration and proposed IAM policies pass
validation. Linux packages verify dependency architecture, packaged CA trust, and parser memory
enforcement. A one-page fictional PDF completes native extraction through the real database
functions with simulated storage; duplicate delivery publishes only once and never starts OCR.

End-to-end runs with fictional documents established:

- A native PDF reached Ready without OCR; a scanned copy and a PNG reached Ready through OCR.
- Published artifacts matched their saved versions, checksums, sizes, encryption, and source
  provenance. OCR artifacts retained page numbers and line confidence.
- Duplicate deliveries left one result and one completion audit per job, and added no OCR
  reservations.
- An invalid image failed before OCR. Explicit retry, removal cancellation, restoration, and
  automatic dispatch behaved as designed without modifying historical jobs.
- Recovery repaired an overdue delivery through the existing outbox.
- Browser checks covered administrator controls, status refresh, mobile layouts, keyboard
  confirmation, navigation, and a byte-for-byte verified download.

Versioned OCR notifications include the source object version. The collector accepts that
optional provider field and checks it against the trusted database snapshot when present; unknown
fields and mismatched versions are rejected.

Known limits: role boundaries and race/failure matrices are covered by PostgreSQL integration
tests, but not every race or malformed-file case was reproduced end to end. Production app
hosting, previews, extracted-text display, and artifact cleanup remain separate work.

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
uv run --project services/document-processor --locked pytest services/document-processor/tests --require-database
uv run --project services/document-processor --locked ruff check services/document-processor infra/document-processing
uv run --project services/document-processor --locked ruff format --check services/document-processor infra/document-processing
uv run --project services/document-processor --locked mypy services/document-processor/src --strict
uv run --project services/document-processor --locked pip-audit --progress-spinner off
```

The Python integration suite requires `PROCESSOR_TEST_DATABASE_URL` for the disposable local
PostgreSQL server. A missing integration configuration must fail verification, not silently skip
it. On macOS the Linux address-space test skips; the container package check exercises that limit.
Run the [SAM, security, and Linux package checks](lambda-configuration.md#build-and-validation)
with both locked environments. CI uses local databases and test fixtures, without hosted secrets
or cloud credentials. A formatting failure in an unrelated file must be reported rather
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
