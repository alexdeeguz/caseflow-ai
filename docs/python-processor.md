# Python document processor

[Back to README](../README.md)

The extraction worker is implemented in `services/document-processor`. It consumes
processing jobs, publishes native PDF text, and starts asynchronous Textract OCR.
The completion worker also collects Textract results and publishes OCR artifacts.
The [processing API](document-processing.md#processing-api) exposes saved job state; see
[workflow verification](processing-verification.md) for test coverage and its limits.

## Structure and local tooling

| Module                                   | Responsibility                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------- |
| `handlers/processing.py`                 | Validate the SQS envelope and return partial batch failures                      |
| `services/processor.py`                  | Coordinate claims, extraction, OCR starts, and publication                       |
| `handlers/completion.py`                 | Validate raw SNS completion messages delivered by SQS                            |
| `services/collector.py`, `ocr/`          | Collect complete OCR results and preserve page/line provenance                   |
| `services/artifacts.py`                  | Write immutable native/OCR text, raw OCR, and manifest artifacts                 |
| `adapters/`                              | Parameterized PostgreSQL calls, versioned S3 operations, and Textract            |
| `extraction/`                            | Conservative PDF/image inspection in a bounded subprocess                        |
| `models.py`, `constants.py`, `config.py` | Validated contracts, limits, and server configuration                            |
| `tests/`                                 | Shared-contract fixtures, parser, AWS adapter, orchestration, and database tests |

Python 3.13 dependencies are independent of npm. `pyproject.toml` pins direct
dependencies and `uv.lock` locks the full graph and hashes. Setup, formatting, and
test commands are in [local development](development.md#python-services).

Database fixtures accept only a local PostgreSQL server, create isolated databases,
exercise restricted processor permissions, and remove their own test resources.

The existing Test & Build workflow runs the Python checks, unit and database tests,
and package build after its PostgreSQL tests. It uses only disposable local data.

The TypeScript and Python suites consume the same valid/invalid queue fixtures in
`packages/schemas/fixtures/processing-messages.json`. Changes to the queue contract
must pass both suites. These are handwritten contracts, not generated models.

## Formatting and readability

Python uses Ruff with four-space indentation, single quotes, and 100-character lines.
Prettier formats TypeScript, JSON, CSS, and Markdown. See
[local formatting](development.md#python-formatting) for editor and command details.
Helpers separate logical phases, and comments explain constraints or recovery behavior.
Test data builders are shared without importing one test module from another.

## Queue and database behavior

The message is strictly `{ "schemaVersion": 1, "jobId": "<uuid>" }`. Bucket names,
keys, credentials, filenames, and roles are never accepted from the queue. The
handler validates the configured standard queue ARN, event source, and Region.
It processes at most ten records sequentially and returns `batchItemFailures`.
The Lambda event source mapping uses `ReportBatchItemFailures` with batch size one.

Every database function runs in its own short transaction and connection, which
closes before external I/O. The dedicated login calls only the existing processor
functions. Prepared statements are disabled for the transaction pooler. Connect,
statement, lock, idle-transaction, and network timeouts are bounded.

Terminal and already-waiting duplicates are acknowledged without repeating work.
Busy/stale claims, malformed messages, configuration/provider errors, and database
failures remain eligible for SQS retry and the existing DLQ. A permanent invalid or
over-limit document is acknowledged only after the database saves its terminal
failure and audit event. Provider errors and document contents are not logged.

The worker renews and rechecks its 180-second lease before external operations and
before publishing. It reserves 45 seconds of invocation time for the next operation;
near-timeout work is returned for retry. Cancellation during an external operation
cannot undo that operation, but the next checkpoint prevents further publication.

## Source validation and OCR decision

The worker reads the exact S3 version from the database. It verifies response version,
content type, byte count, and SHA-256 over the downloaded bytes; there is no fallback
to the latest object. Temporary directories are private, files use mode `0600`, and
cleanup runs on success, failure, and cancellation. The parser receives no AWS or
database environment variables.

| Check                    | Limit / behavior                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------- |
| Source file              | At most 25 MiB, matching PDF/JPEG/PNG signature and metadata                            |
| PDF                      | 1–20 pages; reject encryption, XFA, malformed structure, and over-limit dimensions      |
| PDF dimensions           | At most 40 inches per side, including page user-unit scaling                            |
| Decoded PDF page content | At most 8 MiB per page                                                                  |
| JPEG/PNG                 | At most 10,000,000 bytes, 10,000 pixels per side, and 40 megapixels; no animation       |
| Parser                   | 30-second wall deadline, CPU limit, bounded file output and descriptors                 |
| Parser memory            | 512 MiB address-space hard limit on Linux plus an RSS watchdog; macOS uses the watchdog |
| Artifacts                | At most 50 MiB combined per publication attempt                                         |

Native PDF text is accepted only when **every page** has at least 50 non-whitespace
characters, at least 95% of those characters are printable (excluding replacement
characters), and no raster images. Nested form/inline images, forms, annotations,
scanned, mixed, sparse, blank, or uncertain pages route the whole PDF to OCR. Images
always use OCR. Text that fails the test is not published as a partial native result.

This is deliberately conservative: logos, annotations, or sparse/blank pages can
cause a text PDF to use paid OCR. It avoids treating a small embedded text layer as
complete content. Thresholds are named constants with boundary tests, not a guarantee
of extraction accuracy. The subprocess bounds resource use; it is not a separate
security principal or a general-purpose malware sandbox.

## Native artifacts and interrupted OCR starts

Native extraction writes `text.json` with ordered, one-based page numbers and text.
The manifest records schema/pipeline versions, job/document identity, exact source
version/checksum, extraction method, page count, and the saved text reference.
Each publication attempt uses a fresh artifact-set UUID beneath the database-supplied
prefix. Writes are conditional, encrypted, and verified by exact version/checksum
before the atomic completion function publishes them. Failed/stale attempts may
leave unreferenced objects; cleanup is separate work.

Before the first OCR call, the database saves the exact request and reserves the page
allowance. The application job UUID is both `ClientRequestToken` and `JobTag`.
Textract receives the saved source version, SNS topic, and notification role. Only
after the receipt is saved as `waiting_for_ocr` can the delivery be acknowledged.

If a start times out or receipt persistence fails, the next claim reuses the saved
request unchanged, even after deployment settings change. It does not allocate a new
token or reservation. Database checks prohibit restarting unresolved intents after
six days. Textract tokens last seven days, and repeating a successful start returns
the same ID **without sending another completion notification**. Recovery inspects saved jobs; retrying a start cannot replace reconciliation.
[Textract asynchronous behavior](https://docs.aws.amazon.com/textract/latest/dg/api-async.html)

## Configuration

`services/document-processor/.env.example` lists server-only settings. The handler does
not automatically load `.env` files. Configuration comes from the process environment
or a secret store; credentials remain outside Git.

| Setting                                                      | Purpose                                                                                        |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `PROCESSOR_DATABASE_URL`                                     | Separate processor login, transaction pooler port 6543, `sslmode=verify-full`, trusted CA path |
| `PROCESSOR_QUEUE_ARN`                                        | Only the main processing queue may invoke this handler                                         |
| `PROCESSOR_STORAGE_BUCKET` / `PROCESSOR_STORAGE_ENVIRONMENT` | Restrict the trusted snapshot to this workload's storage                                       |
| `TEXTRACT_COMPLETION_QUEUE_ARN`                              | Required by the completion handler; separate standard queue in the same project/Region         |
| `TEXTRACT_NOTIFICATION_TOPIC_ARN`                            | Configured completion SNS topic                                                                |
| `TEXTRACT_NOTIFICATION_ROLE_ARN`                             | Existing Textract notification role                                                            |
| `AWS_REGION`                                                 | Selected Region for AWS requests                                                               |

The extraction handler is `caseflow_processor.handlers.processing.handler`; the
completion handler is `caseflow_processor.handlers.completion.handler`. The public
CA file is packaged with the code, and the restricted database password comes from a secret
store. Boto3 uses the default credential chain; in AWS the code uses its execution role.
Native artifact writes need narrowly scoped `s3:PutObject` and `s3:GetObjectVersion`; source
reads need version access. Textract starts need text-detection permission and scoped
`iam:PassRole`. Installing or testing the application creates no AWS resources.

## Related guides

- [Textract completion and artifact format](textract-completion.md)
- [Processor database and function contracts](processor-database.md)
- [Processing foundation and dispatcher](document-processing.md)
- [Hosted database](hosted-database.md)
- [Lambda configuration](lambda-configuration.md)
- [Textract document limits](https://docs.aws.amazon.com/textract/latest/dg/limits-document.html)
