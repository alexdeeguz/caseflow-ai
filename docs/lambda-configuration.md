# Lambda configuration

[Back to README](../README.md)

The [SAM template](../infra/document-processing/template.yaml) defines two consumers and a scheduled reconciler
from the shared Python package. It creates functions, execution roles, event-source
mappings, retained log groups, a disabled Scheduler schedule/group, alarms, and a dashboard. Existing queues, DLQs, document storage, SNS topic, notification
role, and database secrets are managed outside this stack. Queue consumption is controlled by
separate per-consumer switches.

## Runtime configuration

| Setting                    | Both functions                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------- |
| Runtime / architecture     | Python 3.13 / x86-64                                                                            |
| Memory / temporary storage | 1,024 MiB / 512 MiB                                                                             |
| Function timeout           | 120 seconds                                                                                     |
| SQS batch size / window    | 1 message / 0 seconds                                                                           |
| Mapping concurrency        | At most 2 concurrent invocations per queue                                                      |
| Batch response             | `ReportBatchItemFailures`                                                                       |
| Queue mappings             | Separate `EnableProcessingConsumer` / `EnableCompletionConsumer` flags; both default to `false` |
| Queue visibility           | Existing queues must retain at least 720 seconds                                                |
| Log retention              | 30 days; log groups retained when the stack is deleted                                          |
| Network                    | Public HTTPS services and verified PostgreSQL TLS; no VPC or NAT                                |

The queue visibility follows [Lambda's six-times-timeout guidance](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html).
The two mappings can run four invocations combined. Recovery normally adds one scheduled invocation,
but has no function-level concurrency cap. All three functions use shared Regional concurrency;
no capacity is reserved. The mapping limits apply to SQS consumption, not manual invocations.
Recovery uses short database locks, persisted next-check times, and fenced collection leases to
coordinate overlapping deliveries. Shared-capacity contention can delay recovery; monitor throttles
and the missing-reconciliation alarm.
The 180-second database lease remains separate from queue visibility. Existing job ownership,
cancellation, attempt limits, and OCR allowance checks still apply.

## Database credentials and trust

Both functions use a restricted processor login, which inherits only the processor capability role and has no direct table-write or operator privileges; the API and dispatcher
use separate credentials. Credentials live in AWS Secrets Manager. Lambda receives only the
secret's ARN, never a password or connection string in its environment, and retrieves the current
version with its execution role.

The secret schema rejects extra fields, operator usernames, wrong hosts/ports, and attempts
to override TLS options. Lambda refuses direct `PROCESSOR_DATABASE_URL` configuration.
That variable remains available for local tests. Secret responses are validated, cached
for at most five minutes, and refreshed on a subsequent invocation. A failed refresh
never falls back to expired credentials. SDK clients are reused across warm invocations;
credential-bearing application objects are rebuilt so rotated credentials take effect.

The package includes [Supabase's public root CA](../services/document-processor/src/caseflow_processor/certs/supabase-ca.crt).
This certificate is public trust material, not a credential.

The runtime resolves its packaged path and always uses `sslmode=verify-full`, checking both
chain and hostname. It never uses a developer's certificate path or disables verification.

[Transaction pooling](https://supabase.com/docs/guides/database/connecting-to-postgres) uses
port 6543. Psycopg disables prepared statements (`prepare_threshold=None`) and opens one
short-lived connection per database operation. There is no per-container connection pool.
Connection timeout is 5 seconds; transaction-local statement, lock, and idle transaction
timeouts are 8, 5, and 10 seconds. Connections close before S3/Textract calls. Secret refresh
adds a bounded API call, not a persistent database connection.

## IAM boundaries

| Permission                       | Processor                                    | Completion                 |
| -------------------------------- | -------------------------------------------- | -------------------------- |
| SQS receive/delete/attributes    | Processing queue only                        | Completion queue only      |
| Create log stream / write events | Own log group                                | Own log group              |
| Get secret value                 | Processor secret only                        | Processor secret only      |
| Read original S3 version         | Configured environment's `original/` prefix  | None                       |
| Write / verify artifact versions | Configured environment's `processed/` prefix | Same                       |
| Textract operation               | `StartDocumentTextDetection`                 | `GetDocumentTextDetection` |
| Pass notification role           | Notification role, only to Textract          | None                       |

All file reads require `s3:GetObjectVersion`; neither role can read an unspecified latest
version, delete objects, list buckets, write originals, or send arbitrary SQS messages.
Artifact writes require explicit AES256 encryption. The existing S3 bucket must keep versioning,
Block Public Access, disabled ACLs, HTTPS enforcement, and SSE-S3 encryption enabled.
The original and artifact patterns are scoped to the configured bucket/environment and case/
document structure. Application authorization and trusted job snapshots provide finer checks.

[Textract's authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_textract.html)
does not support resource-level scoping for these two operations. Only those statements use
`Resource: "*"`, with a selected-Region condition. `GetDocumentTextDetection` cannot be restricted
to one job ID in IAM; trusted database correlation restricts the IDs the completion code uses.
The processor can pass only the existing notification role. That role must trust Textract and
allow publication only to the configured completion SNS topic. Its topic subscription,
queue policy, redrive settings, and DLQs stay outside this stack.

The policies assume SSE-SQS queues, SSE-S3 documents, and the AWS-managed Secrets Manager key.
A customer-managed KMS key requires a separate review of key policy and narrowly scoped decrypt/
data-key permissions. No wildcard KMS, S3 ACL/tag/retention, or administrative permissions are granted.

## Build and validation

The build wrapper exports hash-pinned runtime requirements from the service lockfile
into a temporary source directory, copies only the Python package and public certificate,
and builds the functions in a Python 3.13 x86-64 Linux container. It excludes local
environment files, tests, editor files, and development dependencies. Build tools have
a separate lockfile and never enter Lambda. Local commands are in
[development](development.md#infrastructure-validation).

Security validation uses checksum-verified CloudFormation Guard 3.2.1. Rules check runtime
limits, stack ownership, logging, and default-disabled consumption. Permission tests cover
both allowed and denied queues, prefixes, secrets, logs, operations, and PassRole conditions.
Package checks verify ELF architecture, size, imports, and bundled CA loading inside an offline,
read-only Linux container, including the parser memory ceiling. Bundles are staged in a temporary
directory so Docker Desktop does not need to mount the source checkout. Builds need package/image network access, but no AWS deployment
credentials. These CI checks use no live cloud resources.

Local secret tests cover validation, rotation caching, malformed responses, and provider errors. The PostgreSQL integration suite creates an additional disposable TLS server
to verify trusted connections succeed and wrong CA/hostname connections fail. It also tests
restricted processor credentials against migrated disposable databases.

## Logging

Logs use Lambda's JSON format. Job events contain trusted job/case/document IDs, stage, outcome,
and safe failure codes; delivery events contain message IDs and elapsed milliseconds. They do
not contain full events, filenames, extracted text, URLs, credentials, lease tokens, or raw
provider exception messages. A delivery acknowledgment does not necessarily mean Ready: an
OCR-start message is acknowledged only after its waiting state is persisted. Log groups are
retained when the stack is deleted, and events expire after 30 days.

The recovery function uses a separate restricted login and shared concurrency; see
[processing recovery](processing-recovery.md).
