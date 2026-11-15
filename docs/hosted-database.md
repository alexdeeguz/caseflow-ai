# Hosted database

[Back to README](../README.md)

Run commands from the repository root after completing the [quick start](../README.md#getting-started) dependency and environment-file steps.

The API can use hosted Supabase PostgreSQL while the frontend and API run locally.
Local and hosted databases are independent: migrations create the schema, not a copy
of local users, assignments, cases, or document metadata. Microsoft Entra remains
the authentication provider. No Supabase browser keys are needed.

## Project and migrations

1. Create a Supabase project in the same region as the application's storage when
   available. Disable the Data API and automatic table exposure for this setup;
   never expose the `caseflow` schema.
2. From **Database → Settings → SSL Configuration**, enable SSL enforcement and
   download the CA certificate. Applying enforcement briefly restarts the database.
   Store the certificate at a stable path outside the repository.
3. Authenticate the pinned CLI and review pending migrations before applying them:

   ```sh
   export SUPABASE_TELEMETRY_DISABLED=1
   npx supabase login
   npx supabase link --project-ref PROJECT_REF
   npx supabase db push --remote=PROJECT_REF --dry-run --skip-vault
   npx supabase db push --remote=PROJECT_REF --skip-vault
   ```

   Review the target and confirmation before applying. CLI v3 defaults to local
   targets; explicit `--remote=PROJECT_REF` avoids ambiguity. Do not reset either
   database. Hosted seeding is optional; it is not part of migration application.

## Runtime connection

Use **Connect → Session pooler** for the persistent Node API. Copy the exact pooler
host from the dashboard; it cannot be derived from the region alone. The session
port is `5432`, and the database is `postgres`.

Connect with an administrator through `psql` using TLS verification, then set the
restricted role's password interactively:

```text
\password caseflow_runtime
```

This role already exists after migration. Use a separate password from the
administrator's password. The `\password` prompt avoids plaintext passwords in
SQL snippets and shell history.

Set the ignored `apps/api/.env` using URL-encoded credentials and the actual
absolute certificate path:

```dotenv
DATABASE_URL=postgresql://caseflow_runtime.PROJECT_REF:URL_ENCODED_PASSWORD@POOLER_HOST:5432/postgres?sslmode=verify-full&sslrootcert=/absolute/path/supabase-ca.crt
```

The shared pooler username includes the project reference; PostgreSQL still sees
`caseflow_runtime` as the role. Configuration accepts this qualified username only
on Supabase pooler hosts. Administrator usernames, unverified remote connections,
and query parameters that override credentials are rejected.

Restart the API after changing configuration. Keep passwords, full connection
URLs, and private environment files out of screenshots, logs, and Git. The CA
certificate is a trust anchor, not a database password. The API retains its bounded
five-connection pool and transaction-local identity settings.

## First sign-in and verification

A first authenticated `GET /me` creates an active Staff profile in the selected
database. Existing local privileges do not carry over. In hosted Studio, choose
**Table Editor → caseflow → users**, or use an administrative SQL session:

```sql
select id, display_name, role, active, created_at
from caseflow.users
order by created_at desc;
```

To bootstrap the verified application user, run the same audited function used
by the operator command:

```sql
select caseflow.operator_set_role('APPLICATION_USER_UUID'::uuid, 'super_admin');
```

Alternatively, configure a separate hosted `OPERATOR_DATABASE_URL` in the ignored
`apps/api/.env.operator` and use `npm run operator:role -- USER_UUID super_admin`.
Check its target first: a local operator connection changes only local roles.
Never place operator credentials in `apps/api/.env` or the deployed API. The
operator function protects the last active Super Admin. Disable users to block
access; deleting a profile allows automatic provisioning on the next sign-in.

Verify hosted configuration with:

```sh
npx supabase ssl-enforcement get --remote=PROJECT_REF --experimental
npx supabase db advisors --remote=PROJECT_REF --type security --level warn
npx supabase db query --remote=PROJECT_REF --read-only \
  "select version from supabase_migrations.schema_migrations order by version"
```

Then verify profile loading, creation of a fictional case, upload, download,
removal/restoration, and audit history through the application. A successful
Microsoft sign-in alone does not verify the database connection. Download URLs
are credentials; do not log or save them. If Chrome reports `ERR_BLOCKED_BY_CLIENT`,
check the browser separately from API authorization and S3 response validation.

## Local tests and switching environments

`npm run db:configure` is **local-only** and overwrites the API's `DATABASE_URL`.
Do not run it while expecting to retain hosted configuration. Keep local and hosted
credentials in separately protected configuration and restart the API when switching.
Existing uploaded S3 objects do not automatically acquire metadata in a new database.

Integration tests create and drop disposable databases. They require explicit
**local** operator and runtime URLs pointing at the same local server; the runtime
username must be `caseflow_runtime`. Their fixture rejects hosted targets. When
`apps/api/.env` targets hosted Supabase, supply local test credentials as shell
environment variables before `npm run test:integration`; shell values take
precedence over the environment files. Do not rotate a shared local role password
just to run tests. Use an isolated PostgreSQL instance when local credentials are
unavailable.

## Backup, recovery, and deployment

On the Free plan, maintain private exports rather than assuming paid-plan backup
retention. From an authorized operator session, an application-data export is:

```sh
umask 077
npx supabase db dump --remote=PROJECT_REF --schema caseflow \
  --data-only --use-copy --file /private/backup/location/caseflow-data.sql
```

Keep exports outside Git and encrypt off-device copies. Reapply the versioned
migrations to an isolated database, restore the data export with an administrative
client, and verify row counts, constraints, sequences, and permissions before
relying on recovery. Re-establish runtime passwords separately. Database backups
contain document metadata, not S3 file bytes; retain the referenced S3 versions.
Never test a restore against the working database.

Before deploying the API, provision runtime credentials through the hosting
platform's secret store, mount the trusted CA certificate, and establish credential
rotation, scheduled backups, recovery drills, and monitoring for database capacity,
connections, and application failures. These operational services are not enabled
by a local `.env` configuration or a one-time backup. Account for Free-plan project
pausing when preparing demos. No paid-plan upgrade is required by these instructions.

References: [connection modes](https://supabase.com/docs/guides/database/connecting-to-postgres),
[SSL enforcement](https://supabase.com/docs/guides/platform/ssl-enforcement), and
[backup guidance](https://supabase.com/docs/guides/platform/backups).

## Related guides

- [Local development](development.md)
- [Users and cases](users-and-cases.md)
- [Dispatcher credentials](document-processing.md#restricted-dispatcher-login)
- [Processor credentials](processor-database.md#provision-the-processor-login)
