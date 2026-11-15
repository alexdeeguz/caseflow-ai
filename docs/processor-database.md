# Processor database

[Back to README](../README.md)

The additive `20261115170546_processor_database.sql` migration supplies the database
interface for document workers. It does not start processing, create Lambda
functions, or enable the API dispatcher. Apply it before deploying a processor.

## Tables and access

| Table                         | Purpose                                                                                             | Direct application access                                                                          |
| ----------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `document_processing_jobs`    | Source snapshot, lifecycle, extraction/collection attempts, leases, OCR intent and provider receipt | Runtime can select its existing safe columns through case-aware RLS; processor uses functions only |
| `document_processing_results` | Published manifest/text/OCR references, exact S3 versions, checksums, method and page count         | None                                                                                               |
| `processing_ocr_days`         | Workspace OCR pages reserved per UTC day                                                            | None                                                                                               |
| `processing_ocr_reservations` | One immutable allowance reservation per job                                                         | None                                                                                               |
| `audit_events`                | Existing history with an additional nullable service identity                                       | Existing administrator-only RLS                                                                    |

The three new tables have RLS enabled without direct runtime or processor policies.
This is intentional: their service operations run through narrowly granted functions
in the private `caseflow` schema. Do not expose that schema through the Data API.
The processor role cannot select application tables, update rows directly, provision
users, change roles, or call dispatcher/operator functions.

Existing jobs, dispatches, documents, upload sessions, assignments, and user/operator
audit records are preserved. Historical documents are not backfilled. The new fields
default to pipeline version `1`, zero collection attempts, and no OCR request.

## Worker interface

Every call runs in a short transaction. Commit before S3 or Textract I/O. Each write
uses the existing permission lock, then case, document, and job locks. Workers do not
set Entra identity variables or impersonate the requester.

| Function                                                                           | Behavior                                                                                                 |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `claim_document_processing(job)`                                                   | Claim queued work or reclaim an expired extraction lease; return a new token and trusted source snapshot |
| `renew_document_processing_lease(job, token)`                                      | Extend an unexpired owned lease; return false for expired, superseded, or cancelled work                 |
| `prepare_document_ocr(job, token, pages, topic_arn, role_arn)`                     | Reserve OCR pages and persist the exact request before calling Textract                                  |
| `bind_document_textract_job(job, token, provider_job)`                             | Save the provider receipt, enter `waiting_for_ocr`, and release the extraction lease                     |
| `claim_document_collection(job, provider_job)`                                     | Validate correlation and claim OCR collection with a separate attempt counter                            |
| `complete_document_processing(job, token, method, pages, artifact_set, artifacts)` | Publish result references, Ready state, and audit event atomically                                       |
| `fail_document_processing(job, token, failure)`                                    | Record a terminal safe failure and audit event atomically                                                |

Claim responses always contain `outcome`, `jobId`, `status`, `stage`, and
`failureCode`. Only `claimed` responses contain source metadata, lease credentials,
pipeline version, attempt counts, OCR intent/receipt, and the trusted artifact prefix.

| Outcome            | Caller behavior                                                                 |
| ------------------ | ------------------------------------------------------------------------------- |
| `claimed`          | Process using the returned lease token                                          |
| `busy`             | Retry later; another worker owns an unexpired lease                             |
| `waiting`          | The processing message has already handed off to OCR/collection; acknowledge it |
| `awaiting_binding` | A completion notification arrived before its receipt was saved; retry later     |
| `terminal`         | Acknowledge the duplicate; do not repeat external work                          |

`prepare_document_ocr` returns `prepared` plus the saved `request`, or a lifecycle
response with `stale`/`terminal`. Boolean mutations return false for a stale lease or
terminal job. A false result must never be interpreted as permission to publish.
Invalid input and mismatched provider/request parameters raise stable database errors.

Leases last 180 seconds. Extraction and collection each allow five claims. A transient
external failure can leave the lease to expire and return the SQS message for retry;
the terminal failure function is for failures that should stop the job. The database
does not send or acknowledge SQS messages.

## OCR authorization

Processing accepts at most 20 PDF pages. An image is one page. The shared workspace
can authorize 100 new OCR pages per UTC day. `prepare_document_ocr` reserves the whole
document atomically, rejects over-budget jobs with `ocr_budget_exceeded`, and reuses
the reservation for repeated calls to the same job, including across UTC day changes.
Existing reservations are not refunded on cancellation, provider failure, or uncertain
starts. A later administrator retry creates a new job and needs a new reservation.

The request token and job tag are the application job UUID. Bucket, key, and source
version come from the database snapshot. Topic and notification-role ARNs must have
matching project IDs; the topic must be an `AmazonTextract-` topic in `us-east-2`.
The saved request cannot be changed by a retry. An uncertain start must reuse those
parameters. Unresolved OCR intents become ineligible for restart after six days.

This is an application authorization allowance, not a guarantee of an AWS billing
limit. An accepted Textract request can continue after cancellation, and its actual
completion/billing time can differ from its reservation day.

## Result publication

Workers write artifacts before calling the completion function. The database cannot
verify S3 contents; the worker must verify the upload and pass its exact version and
SHA-256 checksum. Ready is committed only with the result row and audit event.

The completion argument is an object containing `manifest` and `text`, plus `ocr` for
OCR extraction. Each entry contains exactly `versionId`, `checksumSha256` (base64
SHA-256), and positive integer `sizeBytes`. Total artifact size is limited to 50 MiB.
Keys, buckets, URLs, filenames, and extra fields are rejected. Native completion is
allowed only for a PDF with no OCR intent; OCR completion requires a collection lease
and a page count matching the reservation.

```json
{
  "manifest": {
    "versionId": "saved-s3-version",
    "checksumSha256": "<base64-sha256>",
    "sizeBytes": 512
  },
  "text": {
    "versionId": "saved-s3-version",
    "checksumSha256": "<base64-sha256>",
    "sizeBytes": 2048
  }
}
```

Keys are constructed by the database under:

```text
{environment}/cases/{case-id}/documents/{document-id}/processed/{job-id}/{artifact-set-id}/manifest.json
{environment}/cases/{case-id}/documents/{document-id}/processed/{job-id}/{artifact-set-id}/text.json
{environment}/cases/{case-id}/documents/{document-id}/processed/{job-id}/{artifact-set-id}/ocr.json
```

Use a fresh artifact-set UUID per publication attempt. A stale worker can leave
unreferenced objects, but cannot replace the published result. Object cleanup and
result download APIs are separate work.

## Cancellation and audit

Removing a document or archiving its case cancels every unfinished affected job in
the administrative transaction. Restoration preserves cancellation and requires an
explicit administrator retry. Cancellation clears leases but preserves source
metadata, OCR reservations/receipts, dispatch records, and audit history. Completed
results remain unchanged. Every worker checkpoint also rechecks case/document
eligibility, including jobs that predate this migration.

An accepted job belongs to the workspace. Disabling or demoting its original requester
does not impersonate them or automatically cancel the job. User access and subsequent
start/retry requests still use current application permissions.

Background terminal events use `service_name = 'document_processor'`, with no user or
operator actor. Audit records contain safe lifecycle values and identifiers, never
source keys, object versions, lease tokens, notification ARNs, or document contents.
Cancellation retains the separate administrative event identifying who removed or
archived the document/case. Audit failure rolls back the associated mutation.

## Provision the processor login

The migration creates only the `caseflow_processor` NOLOGIN capability role. It does
not create a password or change API/dispatcher credentials. After reviewing and
applying the migration, connect with operator credentials and verified TLS, then run:

```sql
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'caseflow_processor_login') then
    create role caseflow_processor_login login inherit
      nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
end $$;

grant caseflow_processor to caseflow_processor_login with inherit true, set false;

select rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
from pg_roles where rolname = 'caseflow_processor_login';
```

Only `rolcanlogin` should be true in that result. Inspect existing memberships before
reusing an existing login; it must not inherit other application or privileged roles.
Set a unique password using psql's interactive command, which avoids a plaintext SQL
password in terminal history:

```text
\password caseflow_processor_login
```

Store the password in the deployment secret store during Lambda configuration. Use
the transaction pooler on port 6543, database `postgres`, and username
`caseflow_processor_login.<project-ref>`. Keep TLS certificate/hostname verification
enabled and disable prepared statements in psycopg. Package the trusted public CA
certificate with the deployment; do not reference a laptop path.

Verify the actual login can call `claim_document_processing` for an explicitly chosen
fictional test job and cannot select `caseflow.documents` or call
`claim_processing_dispatches`. Claiming changes job state, so keep this check
controlled and do not use an unrelated queued job.

## Verification

The PostgreSQL integration suite covers actual restricted-login calls, competing
claims, stale leases, duplicate OCR starts, early completion notifications, separate
attempt limits, input/metadata validation, cancellation and restoration races, service
audit serialization, atomic rollback, UTC allowance contention and rollover, explicit
function grants, RLS, and additive migration preservation. It creates isolated test
databases; never run it against the hosted working database.

## Related guides

- [Document processing and dispatcher](document-processing.md)
- [Hosted database](hosted-database.md)
- [Local verification](development.md#verification)
