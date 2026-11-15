# Python document processor

[Back to README](../README.md)

The extraction worker is implemented in `apps/document-processor`. It consumes
processing jobs, publishes native PDF text, and starts asynchronous Textract OCR.
The completion worker also collects Textract results and publishes OCR artifacts.
Neither worker is deployed or connected to a queue yet. Reconciliation, processing
API/UI, and operational monitoring are separate work.
Keep continuous dispatching disabled until those deployment prerequisites are ready.

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

Use Python 3.13 and uv. `pyproject.toml` pins direct dependencies; `uv.lock` locks
the full dependency graph and hashes. Python dependencies are separate from npm.
From the repository root:

```sh
uv sync --project apps/document-processor --locked
npm run test:processor
uv run --project apps/document-processor --locked ruff check apps/document-processor
uv run --project apps/document-processor --locked ruff format --check apps/document-processor
uv run --project apps/document-processor --locked mypy apps/document-processor/src --strict
uv build --project apps/document-processor
uv run --project apps/document-processor --locked pip-audit --skip-editable
```

Run database tests with `PROCESSOR_TEST_DATABASE_URL` set to an **operator connection
on a disposable local PostgreSQL server**, using database `postgres`. They reject
remote hosts, create a uniquely named test database, apply the repository migrations,
create a temporary restricted processor login, and remove both afterward. Never use
hosted credentials. The local server must provide the standard Supabase roles.

```sh
uv run --project apps/document-processor --locked pytest apps/document-processor/tests \
  -m integration --require-database
```

The existing Test & Build workflow runs the Python checks, unit and database tests,
and package build after its PostgreSQL tests. It uses only disposable local data.

The TypeScript and Python suites consume the same valid/invalid queue fixtures in
`packages/schemas/fixtures/processing-messages.json`. Changes to the queue contract
must pass both suites. These are handwritten contracts, not generated models.

## Formatting and readability

Ruff owns Python formatting; Prettier continues to format JavaScript/TypeScript,
JSON, CSS, and Markdown. Python uses 100-character lines, single quotes where they
avoid extra escaping, trailing commas in multiline constructs, LF line endings,
and four-space indentation. Docstrings retain conventional triple double quotes.
JavaScript-specific settings such as semicolons and arrow parentheses do not apply.

`pyproject.toml` is the source of truth for Python style. EditorConfig agrees on
four-space Python indentation. The workspace recommends the Python and Ruff editor
extensions and selects Ruff for Python format-on-save; install the recommended
extensions in VS Code or a compatible editor to enable this.

From the repository root:

```sh
npm run format:python
npm run format:python:check
```

`npm run format` and `npm run format:check` run both Prettier and Ruff and therefore
require the Python/uv setup above. Ruff lint and strict mypy remain separate checks.
Keep logical phases separated by blank lines, give helpers concrete responsibilities,
and retain comments that explain constraints or recovery behavior. Share test data
builders in `tests/factories.py`; tests should not import other test modules.

## Queue and database behavior

The message is strictly `{ "schemaVersion": 1, "jobId": "<uuid>" }`. Bucket names,
keys, credentials, filenames, and roles are never accepted from the queue. The
handler validates the configured standard queue ARN, event source, and Region.
It processes at most ten records sequentially and returns `batchItemFailures`.
Configure `ReportBatchItemFailures` on the eventual Lambda event source mapping;
start with batch size one during deployment verification.

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
the same ID **without sending another completion notification**. The later recovery
step must inspect saved jobs; retrying a start cannot replace reconciliation.
[Textract asynchronous behavior](https://docs.aws.amazon.com/textract/latest/dg/api-async.html)

## Configuration and activation prerequisites

`apps/document-processor/.env.example` lists server-only settings. The handler does
not automatically load `.env` files. Supply values through the local process or
deployment secret configuration; never commit credentials.

| Setting                                                      | Purpose                                                                                        |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `PROCESSOR_DATABASE_URL`                                     | Separate processor login, transaction pooler port 6543, `sslmode=verify-full`, trusted CA path |
| `PROCESSOR_QUEUE_ARN`                                        | Only the main processing queue may invoke this handler                                         |
| `PROCESSOR_STORAGE_BUCKET` / `PROCESSOR_STORAGE_ENVIRONMENT` | Restrict the trusted snapshot to this workload's storage                                       |
| `TEXTRACT_COMPLETION_QUEUE_ARN`                              | Required by the completion handler; separate standard queue in the same project/Region         |
| `TEXTRACT_NOTIFICATION_TOPIC_ARN`                            | Existing `AmazonTextract-` SNS topic                                                           |
| `TEXTRACT_NOTIFICATION_ROLE_ARN`                             | Existing Textract notification role                                                            |
| `AWS_REGION`                                                 | `us-east-2`                                                                                    |

The extraction handler is `caseflow_processor.handlers.processing.handler`; the
completion handler is `caseflow_processor.handlers.completion.handler`. The public
CA file must be packaged/mounted in the deployment, and the restricted database
password supplied through the deployment secret store. Boto3 uses the default
credential chain; deployed code uses its execution role.

Before activation, apply the reviewed processor and completion-correlation migrations,
provision the restricted login, and configure Lambda IAM, TLS/secrets,
timeouts, concurrency, and queue triggers. Native artifact writes need narrowly
scoped `s3:PutObject` and `s3:GetObjectVersion`; source reads need version access.
Textract starts need text-detection permission and scoped `iam:PassRole`. No additional
AWS permissions or resources are created by installing or testing this application.

## Related guides

- [Textract completion and artifact format](textract-completion.md)
- [Processor database and function contracts](processor-database.md)
- [Processing foundation and dispatcher](document-processing.md)
- [Hosted database](hosted-database.md)
- [Textract document limits](https://docs.aws.amazon.com/textract/latest/dg/limits-document.html)

## Lambda deployment

See [Lambda configuration](lambda-configuration.md) for the SAM template, Secrets Manager,
verified database TLS, container builds, IAM boundaries, and deployment/rollback steps.
Queue consumption remains disabled until full workflow verification.
