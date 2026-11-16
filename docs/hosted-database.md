# Hosted database

[Back to README](../README.md)

The API can use hosted Supabase PostgreSQL while the frontend and API run
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

## Local tests and environment isolation

Local and hosted data remain separate. Integration fixtures accept only a local server,
create disposable databases, and do not reset the working database. Test configuration
is independent of the application's current database connection; see
[local verification](development.md#verification).

## Data boundaries

PostgreSQL holds application records and document metadata; S3 holds file bytes.
Metadata binds each document and generated artifact to its exact object version.
An object alone does not recreate its database record, permissions, or audit history.
Restricted runtime roles cannot perform database administration or delete stored versions.

References: [connection modes](https://supabase.com/docs/guides/database/connecting-to-postgres)
and [SSL enforcement](https://supabase.com/docs/guides/platform/ssl-enforcement).

## Related guides

- [Local development](development.md)
- [Users and cases](users-and-cases.md)
- [Document processing](document-processing.md)
- [Processor database](processor-database.md)
