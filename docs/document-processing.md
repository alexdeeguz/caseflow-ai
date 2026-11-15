# Document processing

[Back to README](../README.md)

The database foundation, API dispatcher, and processor database interface are implemented. The Python extraction worker is implemented locally; the Textract completion handler, deployment, processing API/UI, and operational monitoring remain pending. Keep continuous dispatching disabled until the consumer is ready.

- [Job and dispatch records](#job-and-dispatch-records)
- [Processor database](#processor-database)
- [API dispatcher](#api-processing-dispatcher)
- [Dispatcher login](#restricted-dispatcher-login)
- [SQS permission and configuration](#sqs-permission-and-api-configuration)

## Job and dispatch records

The processing migration adds `document_processing_jobs` and `processing_dispatches`
to the private `caseflow` schema. Processing lifecycle is separate from document
availability and document versions. Historical documents are not automatically queued.

After this migration is applied, verified upload completion atomically saves the
available document, completed upload session, queued processing job, dispatch record,
and audit events. Repeated completion requests return the existing upload without
creating another job. Each job snapshots the verified source object version and checksum.

The database foundation includes:

- Queued, processing, ready, failed, and cancelled job states; no job represents an
  unprocessed document. Extraction and collection attempts are each bounded at five, with fenced worker
  leases, durable OCR request parameters, and safe failure codes.
- An administrator-only start/retry function with expected-job checks and one active
  job per document. New attempts preserve previous jobs and audit history. Removed
  documents and archived cases cannot start or retry processing.
- RLS and column grants for case-authorized job metadata. Runtime credentials cannot
  write either table or select source storage details from processing jobs.
- A separate `caseflow_dispatcher` role created without login credentials. Its only
  application functions claim dispatch records, acknowledge successful sends, or
  release failed sends for retry. It cannot read application tables directly.
- Dispatch claims of at most 25 records, 60-second token-fenced leases, and a 30-second
  delay after send failures. Expired leases can be reclaimed after a sender crash.
  Dispatch retries are not capped; monitoring must surface repeated send failures.

The queue sender must commit its claim before making network requests. A crash after
sending but before acknowledgment can deliver a job more than once; the worker
deduplicates by job ID. Messages contain only a schema version and job ID, never
client-provided storage locations or credentials.

This foundation does not create cloud resources, run OCR, add processing API routes,
or display processing status. The [API dispatcher](#api-processing-dispatcher) sends queued jobs once enabled;
Worker deployment and operational monitoring remain separate steps. Apply the migration
through the existing reviewed migration workflow; starting the API never applies it.
Until dispatching is enabled, new jobs remain queued in PostgreSQL.

`npm run test:integration` covers atomic rollback, completion and retry idempotency,
role changes, RLS, dispatch concurrency and expired claims, migration preservation,
and repeatable seeds using disposable local databases.

## Processor database

The additive `20261115170546_processor_database.sql` migration adds restricted worker
functions, 180-second job leases, separate extraction/collection retry counters,
versioned artifact references, service audit events, and a shared OCR allowance of
100 pages per UTC day (maximum 20 PDF pages per job). Removal and archival cancel
unfinished processing atomically; restoration requires an explicit retry.

The `caseflow_processor` role has no login and no direct table access. Its dedicated
login/password must be provisioned separately after the migration is applied.
[Processor database setup and function reference](processor-database.md) describes
the transaction contract, claim outcomes, artifact format, allowance behavior, and
restricted credential setup. API/dispatcher credentials are unchanged.

The audit API remains compatible while the migration is pending, returning a null
service identity for existing records. The migration does not start workers, run OCR,
or enable continuous dispatching. Verify it on disposable
PostgreSQL before applying it to the explicitly selected hosted project.

## Python extraction worker

The worker validates queue messages, verifies the saved S3 source version/checksum,
extracts native PDF text in a bounded subprocess, and starts OCR through saved,
idempotent requests. [Python processor setup](python-processor.md) covers its
configuration, limits, tests, and remaining activation prerequisites. The completion
consumer and reconciliation remain separate work; no worker is activated automatically.

## API processing dispatcher

The API includes an opt-in background dispatcher in `apps/api/src/processing/`.
Configuration, PostgreSQL queries, SQS operations, orchestration, and Fastify lifecycle
hooks are separate modules. The internal dispatch-claim schema and type live in the
API processing module; shared packages contain application and queue contracts.
There is no public dispatch endpoint and no browser configuration. It starts only after the API begins listening, polls once per second
between batches, and sends at most five jobs concurrently per API instance. Its
separate PostgreSQL pool holds at most two connections.

Each database claim commits before SQS I/O. A send has a 20-second deadline, shortened
when necessary to leave a 10-second lease margin. SDK requests use bounded connection
and request timeouts with at most three attempts. Successful sends are acknowledged
with the SQS message ID and lease token; failed sends use the existing 30-second
database backoff. Expired leases recover interrupted work. Shutdown stops polling,
aborts pending sends, waits for bounded database operations, and closes both clients.

Delivery is **at least once**. If SQS accepts a message but acknowledgement fails, its
lease eventually expires and another dispatcher may send the same job again. A send
timeout also cannot prove SQS rejected the message. Worker idempotency by job ID is
required. Dispatch attempts are distinct from processing attempts and do not mark a
processing job failed. PostgreSQL coordinates concurrent API instances; dispatching
runs only while at least one enabled API process is running.

### Restricted dispatcher login

First apply the processing migration using the reviewed migration workflow. It creates
a `caseflow_dispatcher` permission role with `NOLOGIN`. Keep that role without a password;
create a separate login that inherits only its permissions. Run the following once
through the operator connection to the intended database:

```sql
create role caseflow_dispatcher_login
  login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
grant caseflow_dispatcher to caseflow_dispatcher_login with inherit true, set false;
```

In the same interactive `psql` session, assign a unique password without placing it in
SQL history or this repository:

```text
\password caseflow_dispatcher_login
```

For the hosted Session pooler, use `caseflow_dispatcher_login.<project-ref>` as the
connection username. Use the same host, port, database, and project as the API runtime
connection, with `sslmode=verify-full` and the trusted certificate path. Local direct
connections use `caseflow_dispatcher_login`. Do not use the operator password, grant
this login membership in `caseflow_runtime`, or grant either runtime role membership
in the dispatcher role. The dispatcher can call only the three dispatch functions;
it cannot read application tables or manage users.

Production needs its own CA certificate file at the path in `sslrootcert`; a developer's
local filesystem path is not available inside a deployed container. Include the trusted
public CA certificate in the image or mount it at a stable path such as
`/app/certs/supabase-ca.crt`, then configure both database URLs with that path and
`sslmode=verify-full`. The CA certificate is public trust material. Database passwords
are secrets and belong in the deployment secret store. The Python processor will also
need a trusted CA configuration when it is deployed.

### SQS permission and API configuration

Grant the API workload's AWS role this additional permission, substituting the intended
project ID. Retain its existing scoped S3 permissions. Do not broaden the role to
administrator access or grant it SQS receive/delete permissions.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "sqs:SendMessage",
      "Resource": "arn:aws:sqs:us-east-2:123456789012:caseflow-document-processing"
    }
  ]
}
```

Set these **server-only** values in the API environment or deployment secret store:

| Setting                              | Value                                                                         |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| `PROCESSING_DISPATCHER_ENABLED`      | `false` by default; `true` enables dispatching                                |
| `PROCESSING_DISPATCHER_DATABASE_URL` | Restricted dispatcher connection described above                              |
| `PROCESSING_QUEUE_URL`               | HTTPS URL of the standard processing queue, not the completion queue or a DLQ |
| `AWS_REGION`                         | `us-east-2`                                                                   |
| `AWS_PROFILE`                        | Local restricted workload profile; omit when using a deployment workload role |

The queue URL must match `AWS_REGION`. Explicit local profiles are used without falling
back to unrelated environment credentials. Deployment uses the SDK credential chain
and should supply a workload role, not static keys. Invalid enabled configuration fails
at startup with value-free errors. Disabled configuration creates no dispatcher clients.

Keep the dispatcher disabled until the queue, restricted database login, IAM permission,
and processing consumer are ready. A deliberately sent test message can wait for a
consumer, but SQS retention still applies; messages can expire if the worker is not
running. The dispatcher does not requeue records already acknowledged as sent. Queue
age, DLQ depth, database dispatch backlog, and recurring dispatch failures need monitoring
before deployment. Existing uploaded documents are not automatically backfilled.

Logs contain event names and job/dispatch IDs, never connection strings, credentials,
lease tokens, document contents, or raw provider errors. `processing_dispatch_sent`
means SQS accepted the message and PostgreSQL recorded the acknowledgement; it does
not mean document processing completed. Failed acknowledgements leave the lease for
recovery. Check IAM permissions, connection configuration, and migration state when
send or claim failures repeat; leave direct outbox updates to reviewed recovery procedures.

Unit tests cover configuration, signed requests, safe errors, timeouts, and server
lifecycle. Disposable PostgreSQL integration tests cover concurrent senders, committed
claims before network I/O, failure backoff, duplicate delivery after acknowledgement
loss, stale lease fencing, and restricted credentials. These tests use an injected SQS
adapter and never send messages to the live processing queue.

## Related guides

- [Document management](document-management.md)
- [Hosted database](hosted-database.md)
- [Processor database function reference](processor-database.md)
