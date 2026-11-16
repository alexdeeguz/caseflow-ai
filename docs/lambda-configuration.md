# Lambda configuration

[Back to README](../README.md)

The [SAM template](../infra/document-processing/template.yaml) defines two consumers and a scheduled reconciler
from the shared Python package. It creates functions, execution roles, event-source
mappings, retained log groups, a disabled Scheduler schedule/group, alarms, and a dashboard. Existing queues, DLQs, document storage, SNS topic, notification
role, and database secrets remain externally managed. Neither deployment nor queue
consumption runs automatically from CI.

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

1. Apply the reviewed migrations, including processor lifecycle and Textract completion
   correlation, using the [hosted migration workflow](hosted-database.md). Review the dry run
   against the intended project before applying it. Do not reset or seed the hosted database
   as part of deployment.
2. Create the restricted `caseflow_processor_login` and set its own password as described
   in [processor database credentials](processor-database.md#provision-the-processor-login). It must inherit
   `caseflow_processor` only, with no direct table-write or operator privileges. Both Lambda
   functions use this processor login; the API and dispatcher retain separate credentials.
3. In **Secrets Manager**, selected Region **us-east-2**, choose **Store a new secret →
   Other type of secret**. Use the AWS-managed `aws/secretsmanager` encryption key. Save a
   JSON object with exactly these fields, entering the password privately in the console:

   ```json
   {
     "host": "aws-0-us-east-2.pooler.supabase.com",
     "port": 6543,
     "dbname": "postgres",
     "user": "caseflow_processor_login.YOUR_PROJECT_REFERENCE",
     "password": "YOUR_PROCESSOR_PASSWORD"
   }
   ```

   Use the actual transaction-pooler host from Supabase Connect. The project reference
   must be the 20-character reference for that database. Keep `port` numeric. Name the
   secret for its environment, for example `caseflow/dev/processor-database`. Do not put
   secret JSON into template parameters, local deployment parameter files, Git, or shell
   arguments. Automatic rotation needs its own coordinated database rotation workflow;
   this stack does not configure it.

4. Set the template's `ProcessorDatabaseSecretArn` to the complete secret ARN. Lambda
   receives only this ARN, never the password or a database connection string in its
   environment. It retrieves `AWSCURRENT` using its execution role.

The secret schema rejects extra fields, operator usernames, wrong hosts/ports, and attempts
to override TLS options. Lambda refuses direct `PROCESSOR_DATABASE_URL` configuration.
That variable remains available for local tests. Secret responses are validated, cached
for at most five minutes, and refreshed on a subsequent invocation. A failed refresh
never falls back to expired credentials. SDK clients are reused across warm invocations;
credential-bearing application objects are rebuilt so rotated credentials take effect.

The package includes [Supabase's public root CA](../services/document-processor/src/caseflow_processor/certs/supabase-ca.crt).
Its SHA-256 DER fingerprint is
`AD:62:1A:B5:F1:62:31:97:13:A6:91:C7:3D:D0:52:C3:B4:CD:49:B6:02:49:96:2A:D8:B5:FB:6B:D1:A0:D4:B5`;
it expires on April 26, 2031. Replace it through a reviewed source/build update if Supabase
rotates its trust chain. This certificate is public trust material, not a credential.
The runtime resolves its packaged path and always uses `sslmode=verify-full`, checking both
chain and hostname. It never uses a developer's certificate path or disables verification.

[Transaction pooling](https://supabase.com/docs/guides/database/connecting-to-postgres) uses
port 6543. Psycopg disables prepared statements (`prepare_threshold=None`) and opens one
short-lived connection per database operation. There is no per-container connection pool.
Connection timeout is 5 seconds; transaction-local statement, lock, and idle transaction
timeouts are 8, 5, and 10 seconds. Connections close before S3/Textract calls. Secret refresh
adds a bounded API call, not a persistent database connection.

For manual password rotation, disable mappings, let in-flight invocations finish, change the
restricted database password and secret together, then allow the five-minute cache to expire
before re-enabling consumption. Existing API/dispatcher passwords are unaffected.

## IAM boundaries

| Permission                       | Processor                                    | Completion                 |
| -------------------------------- | -------------------------------------------- | -------------------------- |
| SQS receive/delete/attributes    | Processing queue only                        | Completion queue only      |
| Create log stream / write events | Own log group                                | Own log group              |
| Get secret value                 | Processor secret only                        | Processor secret only      |
| Read original S3 version         | Configured environment's `original/` prefix  | None                       |
| Write / verify artifact versions | Configured environment's `processed/` prefix | Same                       |
| Textract operation               | `StartDocumentTextDetection`                 | `GetDocumentTextDetection` |
| Pass notification role           | Named role, only to `textract.amazonaws.com` | None                       |

All file reads require `s3:GetObjectVersion`; neither role can read an unspecified latest
version, delete objects, list buckets, write originals, or send arbitrary SQS messages.
Artifact writes require explicit AES256 encryption. The existing S3 bucket must keep versioning,
Block Public Access, disabled ACLs, HTTPS enforcement, and SSE-S3 encryption enabled.
The original and artifact patterns are scoped to the configured bucket/environment and case/
document structure. Application authorization and trusted job snapshots provide finer checks.

[Textract's authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_textract.html)
does not support resource-level scoping for these two operations. Only those statements use
`Resource: "*"`, with an Ohio Region condition. `GetDocumentTextDetection` cannot be restricted
to one job ID in IAM; trusted database correlation restricts the IDs the completion code uses.
The processor can pass only the existing notification role. That role must trust Textract and
allow publication only to the configured `AmazonTextract-...` SNS topic. Its topic subscription,
queue policy, redrive settings, and DLQs stay outside this stack.

The policies assume SSE-SQS queues, SSE-S3 documents, and the AWS-managed Secrets Manager key.
A customer-managed KMS key requires a separate review of key policy and narrowly scoped decrypt/
data-key permissions. No wildcard KMS, S3 ACL/tag/retention, or administrative permissions are granted.

## Build and validation

Install Docker and uv 0.13.8. From the repository root:

```sh
uv sync --project infra/document-processing --locked
uv sync --project services/document-processor --locked
uv run --project infra/document-processing --locked sam validate --lint --region us-east-2 --template-file infra/document-processing/template.yaml
uv run --project infra/document-processing --locked python infra/document-processing/scripts/validate_security.py
uv run --project infra/document-processing --locked pytest infra/document-processing/tests
uv run --project infra/document-processing --locked python infra/document-processing/scripts/build.py
uv run --project infra/document-processing --locked python infra/document-processing/scripts/verify_build.py
```

Use the build wrapper rather than calling `sam build` directly on the source template. It
exports hash-pinned runtime requirements from `services/document-processor/uv.lock` into a temporary
source directory, copies only the Python package and public certificate, and builds all three
functions using SAM's versioned Python 3.13 x86-64 Linux image. It excludes local environment
files, tests, editor files, and development dependencies. SAM output is ignored under
`.aws-sam/document-processing/`. Build tools have a separate lockfile and never enter Lambda.

Security validation uses checksum-verified CloudFormation Guard 3.2.1. Rules check runtime
limits, stack ownership, logging, and default-disabled consumption. Permission tests cover
both allowed and denied queues, prefixes, secrets, logs, operations, and PassRole conditions.
Package checks verify ELF architecture, size, imports, and bundled CA loading inside an offline,
read-only Linux container, including the parser memory ceiling. Bundles are staged in a temporary
directory so Docker Desktop does not need to mount the source checkout. Builds need package/image network access, but no AWS deployment
credentials. CI performs these checks and does not run `deploy`, `sync`, or cloud login.

After authenticating to the intended AWS project, an optional **read-only** IAM check is:

```sh
uv run --project infra/document-processing --locked python infra/document-processing/scripts/verify_iam.py --profile personal --account YOUR_AWS_PROJECT_ID
```

This uses IAM's custom-policy simulator and changes no policies. Simulation checks the proposed
identity policies; it does not prove deployed resource policies, SCPs, secret values, or network
connectivity. Local secret tests cover validation, rotation caching, malformed responses, and
provider errors. The PostgreSQL integration suite creates an additional disposable TLS server
to verify trusted connections succeed and wrong CA/hostname connections fail. It also tests
restricted processor credentials against migrated disposable databases.

## Review and deploy with consumption disabled

Before preparing a change set, verify:

- AWS project identity and selected Region match the intended CaseFlow environment.
- Check `aws lambda get-account-settings` for the actual Regional concurrency limit before deployment.
  New projects can have lower limits than the documented default. This stack uses shared capacity
  without reservations and fits a ten-invocation project for its normal scheduled/queue workload.
  Account for other workloads and direct invocations; shared capacity is not guaranteed per function.
- All ARN parameters belong to that project and Ohio. Processing/completion queue ARNs are
  distinct, standard queues with visibility at least 720 seconds, the intended DLQs and redrive
  policies, and SSE-SQS encryption. Neither parameter points to a DLQ.
- Bucket settings, SNS subscription/raw delivery, and notification-role permissions are correct.
- Hosted migrations and the restricted processor login are ready; the secret contains the
  matching credentials and can reach the transaction pooler with verified TLS.
- Continuous API dispatching stays disabled, and both consumer flags remain `false`.
- A separate reviewed deployment-artifact bucket is available in Ohio. Do not use the document
  library's original/processed prefixes for Lambda deployment packages.

Prepare a change set with the **built** template, substituting the non-secret resource identifiers:

```sh
uv run --project infra/document-processing --locked sam deploy \
--template-file .aws-sam/document-processing/template.yaml \
--stack-name caseflow-processing-dev \
--region us-east-2 --profile personal \
--s3-bucket YOUR_DEPLOYMENT_ARTIFACT_BUCKET \
--capabilities CAPABILITY_IAM --no-execute-changeset \
--parameter-overrides \
  Environment=dev \
  ProcessingQueueArn=YOUR_PROCESSING_QUEUE_ARN \
  CompletionQueueArn=YOUR_COMPLETION_QUEUE_ARN \
  DocumentBucketName=YOUR_DOCUMENT_BUCKET \
  TextractTopicArn=YOUR_TEXTRACT_TOPIC_ARN \
  TextractNotificationRoleArn=YOUR_NOTIFICATION_ROLE_ARN \
  ProcessorDatabaseSecretArn=YOUR_PROCESSOR_SECRET_ARN \
  RecoveryDatabaseSecretArn=YOUR_RECOVERY_SECRET_ARN \
  ProcessingDlqArn=YOUR_PROCESSING_DLQ_ARN \
  CompletionDlqArn=YOUR_COMPLETION_DLQ_ARN \
  AlarmTopicArn=YOUR_OPERATIONAL_ALERT_TOPIC_ARN \
  EnableRecoverySchedule=false \
  EnableProcessingConsumer=false \
  EnableCompletionConsumer=false
```

This command uploads code and creates a pending change set; it does not execute that change set.
Review it in CloudFormation. Expect three Lambda functions, four roles, three log groups, two
**disabled** event-source mappings, a **disabled** recovery schedule/group, 15 alarms, and a dashboard. There should be no replacement/creation of document buckets,
queues, SNS resources, database credentials, or hosted tables. Execute only the reviewed change
set, then verify stack outputs, mapping state, runtime configuration, and resource permissions.
Enable the completion consumer first for controlled verification, then the processing consumer.
The template rejects processing enabled with completion disabled. Keep recovery and continuous
dispatching disabled until their controlled checks pass; follow the
[workflow verification sequence](processing-verification.md).
Deploying disabled functions does not itself prove a successful secret/database connection;
that needs a controlled, reviewed runtime verification before consumption is enabled.

## Logs and rollback

Logs use Lambda's JSON format. Job events contain trusted job/case/document IDs, stage, outcome,
and safe failure codes; delivery events contain message IDs and elapsed milliseconds. They do
not contain full events, filenames, extracted text, URLs, credentials, lease tokens, or raw
provider exception messages. A delivery acknowledgment does not necessarily mean Ready: an
OCR-start message is acknowledged only after its waiting state is persisted.

For a bad release, disable the recovery schedule and both mappings first and pause continuous dispatching. Allow up to
120 seconds for in-flight invocations to finish. Prepare a reviewed change set from the previous
known-good source revision and lockfile, with both consumer flags set to `false`, and deploy its built
packages. Do not purge queues, reset the database, or delete document/artifact versions.
Existing job leases, stable Textract tokens, and fenced publication support safe retries after
the service is restored. Database changes need a separately reviewed additive compatibility fix.

Deleting this stack removes its functions, roles, mappings, schedule/group, alarms, and dashboard
but retains log groups for review;
log events still expire after 30 days. Externally managed queues, secrets, SNS, S3, and the hosted
database remain. Reusing a deleted stack name can conflict with retained log-group names; retain
and import those groups deliberately or choose a new stack name. Do not delete resources simply
to make a redeployment succeed.

The recovery function uses a separate restricted login/secret and shared concurrency. See [recovery setup](processing-recovery.md) for its permissions, additional parameters, alert delivery verification, and operator procedures.
