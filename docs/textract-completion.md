# Textract completion

[Back to README](../README.md)

The completion worker in `services/document-processor` collects real Textract results through
SNS and SQS. Verification covers local AWS stubs, bounded HTTP retries, disposable PostgreSQL
databases, and the hosted development workflow. See [workflow verification](processing-verification.md)
for results and known limits.

## Delivery and correlation

The Lambda entry point is `caseflow_processor.handlers.completion.handler`.
`TEXTRACT_COMPLETION_QUEUE_ARN` identifies the existing standard completion queue.
It must differ from the processing queue and share its project and `us-east-2` Region.
The remaining server-only settings are described in [Python processor setup](python-processor.md).

The SNS subscription must use **raw message delivery**. The SQS body is Textract's
JSON notification, not an SNS `Message` envelope. Validation requires
`API=StartDocumentTextDetection`, a UUID `JobTag`, a valid provider `JobId`, recognized
status, timestamp, and document location. Optional `S3ObjectVersion` values must match the
saved source version when supplied. The handler accepts only the configured
queue/event source/Region, at most ten records, and notification bodies up to 16 KiB.
The event source mapping uses `ReportBatchItemFailures` with batch size one.

PostgreSQL supplies the source snapshot, saved request, provider receipt, pipeline
version, and artifact prefix. Notification locations are compared with that snapshot
and never used as storage authority. The queue policy must continue allowing delivery
only from the intended SNS topic; raw delivery does not include an SNS signature for
the application to validate.

The collection function correlates the application and provider IDs before returning
terminal duplicates. An early notification with a saved OCR intent but no receipt
retries until receipt persistence succeeds. Competing collectors see `busy` while a
180-second lease is active. Each successful claim gets a new ownership token and
consumes one of five collection attempts, independently of extraction attempts.

Unexpected/malformed notifications, mismatched IDs, unbound terminal receipts, and
unrecordable failures return partial batch failures for retry and eventual DLQ review.
Logs contain a static retry event, not notification contents, provider errors,
credentials, or lease tokens. Recorded terminal duplicates perform no external work.

## Bounded result retrieval

The adapter calls `GetDocumentTextDetection` using the **saved** provider ID. The
installed SDK has no generated paginator for this operation, so the adapter configures
Botocore's paginator with Textract's documented tokens and result key. It does not use
`MaxItems`, which could silently truncate a document.

| Bound              | Behavior                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------ |
| Document pages     | 1–20, matching the saved OCR reservation                                                   |
| Provider responses | At most 100, requesting up to 1,000 blocks per response                                    |
| Collection         | 120-second request-launch budget plus the invocation deadline                              |
| AWS retry policy   | Standard mode, at most two attempts per request; 3-second connect / 5-second read timeouts |
| Publication        | At most 50 MiB combined across text, raw OCR, and manifest                                 |

Every response must report success and a consistent document page count. The normalizer
requires every numbered PAGE exactly once, resolves its LINE/WORD child references,
and rejects missing, duplicated, cross-page, or orphaned blocks. A blank page is
accepted only when an explicit PAGE block is present. Line order follows the provider's
PAGE child order; this is not a custom layout or table reconstruction engine.

| Provider outcome                                                       | Application behavior                           |
| ---------------------------------------------------------------------- | ---------------------------------------------- |
| `IN_PROGRESS` or temporary network/throttling failure                  | Retry through SQS after bounded SDK retries    |
| `FAILED` / error notification                                          | Persist `ocr_unavailable` before acknowledging |
| Partial success, warnings, missing/inconsistent results, invalid graph | Persist `ocr_incomplete`; never Ready          |
| Invalid/expired provider job                                           | Persist `ocr_results_expired`                  |
| Response or artifact size/count limit                                  | Persist `limit_exceeded`                       |

The existing database also stops collection after its conservative six-day OCR
retention deadline. Failed terminal-state persistence remains retryable.
[GetDocumentTextDetection](https://docs.aws.amazon.com/textract/latest/APIReference/API_GetDocumentTextDetection.html)

## Common artifact format

Both extraction paths use the same writer and schema version. Each publication attempt
allocates a fresh artifact-set UUID:

```text
{environment}/cases/{case-id}/documents/{document-id}/processed/{job-id}/{artifact-set-id}/
  manifest.json
  text.json
  ocr.json       # OCR jobs only
```

- `text.json`: schema version and ordered pages with one-based page numbers and text.
  OCR pages also contain ordered lines with source block IDs and confidence when supplied.
- `ocr.json`: schema version and every raw result response, preserving blocks, geometry,
  model version, and word confidence. Transport `ResponseMetadata` is excluded.
- `manifest.json`: schema/pipeline versions, job/case/document identity, source bucket/key,
  exact source version/checksum, extraction method, page count, and exact artifact
  keys/version IDs/checksums/sizes.

The writer uses conditional S3 writes (`If-None-Match: *`), AES256 encryption, JSON
content type, and `private, no-store`. Exact-version HEAD verification confirms each
saved checksum and size. Storage permissions remain scoped to the processed prefix;
browser credentials and public artifact routes are not added. No previews or normalized
PDFs are generated.

## Publication and recovery

Database calls use short transactions that close before AWS I/O. Checkpoints renew the
owned lease and recheck cancellation before result requests, artifact writes, and
publication. The completion function atomically stores all artifact references, marks
the job Ready, and inserts the service audit event. Its final locked checks prevent
stale or cancelled collectors from publishing.

An S3 success followed by database/audit failure leaves that artifact set **unpublished**.
After lease expiry, a retry writes to a new artifact-set ID and attempts the same atomic
publication. No cleanup or object deletion runs in this phase. Future orphan cleanup
must check result references and must never delete referenced object versions.
Cancellation cannot retract a Textract request already accepted by AWS. The application
will stop subsequent publication when cancellation is observed.

## Verification

Run the Python checks and disposable PostgreSQL tests in [the processor guide](python-processor.md).
The suite covers multi-response graphs, raw/confidence preservation, early/duplicate
notifications, failure statuses, expiry, actual bounded SDK retries against a local HTTP
server, storage failures, stale leases, cancellation, audit rollback, unreferenced-artifact
recovery, migration preservation, and restricted role grants. Existing API/database
regressions also exercise the revised correlation behavior.
