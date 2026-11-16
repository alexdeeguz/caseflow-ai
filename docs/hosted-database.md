# Hosted database

[Back to README](../README.md)

The API can use hosted Supabase PostgreSQL (AWS Ohio, `us-east-2`) while the frontend and API run
locally. Local and hosted databases are independent: migrations create the schema, not a copy of
local users, assignments, cases, or document metadata. Microsoft Entra remains the authentication
provider; the application does not use Supabase Auth or browser keys, and the `caseflow` schema is
never exposed through the Supabase Data API.

## Connection design

| Aspect               | Design                                                                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connection mode      | The persistent Node API uses Supabase's **session pooler** (IPv4, PostgreSQL session behavior). Short-lived workers use the transaction pooler.                        |
| Identity             | The API connects as the restricted `caseflow_runtime` role, never an administrator. Pooler usernames are project-qualified; PostgreSQL still sees the restricted role. |
| Transport            | TLS with full certificate verification against the trusted Supabase CA. Unverified remote connections are rejected.                                                    |
| Configuration checks | The API rejects administrator usernames, unverified remote connections, and connection options that could override credentials.                                        |
| Pooling              | A bounded pool of five connections with connection, statement, and idle-transaction timeouts.                                                                          |
| Request identity     | The verified user identity is set per transaction, so pooled connections never share identity.                                                                         |

Workers and dispatchers use their own restricted login roles that can only call the database
functions they need. Credentials stay in private, ignored configuration or a secret store, never
in Git, logs, or screenshots.

## Users in a new database

A first authenticated `GET /me` creates an active Staff profile in whichever database the API
targets; privileges from another environment do not carry over. Super Admin is granted only through
an audited, operator-only database function that also protects the last active Super Admin.
Disabling a user blocks access; deleting a profile allows automatic provisioning on the next
sign-in.

## Local tests and switching environments

`npm run db:configure` is **local-only** and overwrites the API's `DATABASE_URL`. Do not run it
while expecting to retain hosted configuration. Keep local and hosted credentials in separately
protected configuration and restart the API when switching. Existing uploaded S3 objects do not
automatically acquire metadata in a new database.

Integration tests create and drop disposable databases. They require explicit **local** operator
and runtime URLs pointing at the same local server; the runtime username must be
`caseflow_runtime`. Their fixture rejects hosted targets. When `apps/api/.env` targets hosted
Supabase, supply local test credentials as shell environment variables before
`npm run test:integration`; shell values take precedence over the environment files. Do not rotate
a shared local role password just to run tests. Use an isolated PostgreSQL instance when local
credentials are unavailable.

## Data and backups

PostgreSQL holds application records and document metadata; S3 holds file bytes. A usable backup
therefore needs both a database export and the referenced S3 object versions. Restores are verified
against an isolated database, never the working one, and runtime credentials are re-established
separately. The Free plan does not include long backup retention and can pause idle projects.

References: [connection modes](https://supabase.com/docs/guides/database/connecting-to-postgres),
[SSL enforcement](https://supabase.com/docs/guides/platform/ssl-enforcement), and
[backup guidance](https://supabase.com/docs/guides/platform/backups).

## Related guides

- [Local development](development.md)
- [Users and cases](users-and-cases.md)
- [Document processing](document-processing.md)
- [Processor database](processor-database.md)
