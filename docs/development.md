# Local development

[Back to README](../README.md)

Complete the dependency and environment-file steps in the [quick start](../README.md#getting-started) first. Run commands from the repository root. Use this guide for local PostgreSQL, verification, code organization, and dependency maintenance.

## Local database

Install and start Docker Desktop, then run from the repository root:

```sh
npm run db:start
npm run db:status
```

The pinned Supabase CLI manages the local Docker containers. The first start
downloads the required images. Open Studio at http://127.0.0.1:54323 to inspect
the database; PostgreSQL listens on port 54322 and the local Supabase API on
port 54321. `npm run db:status` displays connection details and local development
keys. Keep privileged keys out of frontend code.

Run `npm run db:stop` when finished. This preserves local data for the next start.
Stopping the app with Ctrl+C does not stop these containers.

Configuration lives in `supabase/config.toml`. Microsoft Entra remains the sign-in provider.
Local data is separate from any hosted Supabase project and does not sync automatically.

### First-time database setup

After copying the app environment examples, create the ignored `apps/api/.env.operator`
with `OPERATOR_DATABASE_URL` pointing to the local Docker PostgreSQL instance. Keep its
value private. The connection is for local operator tooling, not the API or browser.

Then run from the repository root:

```sh
npm run db:start
npm run db:migrate
npm run db:configure
npm run db:seed
npm run dev
```

`db:configure` generates a random runtime password and writes `DATABASE_URL` to
`apps/api/.env`. This command is local-only and replaces existing local runtime settings.
The API requires `caseflow_runtime`, never the operator role. Hosted database
connections require TLS verification (`sslmode=verify-full`). Connection URLs accept
TLS options and `application_name`; credentials and host belong in the URL itself,
not query-string overrides. Operator credentials
belong only in operator tooling, never in the web app or deployed API environment.

Migrations create a private `caseflow` schema with RLS and a restricted login.
Do not add this schema to Supabase's exposed schemas or grant access to `anon`,
`authenticated`, or `service_role`. Runtime writes use narrowly scoped private
functions with fixed search paths and explicit execution grants. The runtime
cannot update tables, modify audit history, or call operator functions directly.
Identity context comes exclusively from verified Microsoft claims and lasts only
for the request transaction. It is not a defense against a compromised API process.

The seed command adds three fictional cases idempotently. It does not reset users
or assignments. Migration and seed commands never reset the existing database.

## Running individual apps

`npm run dev` builds and watches the shared schemas and starts both apps. When running an app individually, build schemas first:

```sh
npm run build -w @caseflow/schemas
npm run dev:web
```

Use `npm run dev:api` in a separate terminal for the API. Rebuild schemas after changing shared contracts when their watcher is not running.

## Verification

```sh
npm test
npm run test:integration
npm run lint
npm run typecheck
npm run format:check
npm run build
```

Integration tests require Docker plus the local operator/runtime environment files.
They create and drop a uniquely named disposable database, apply migrations and
seeds there, and exercise real restricted-login permissions. They never reset the
working database and do not silently skip when the database is unavailable. Coverage includes partial edits, archive access/filtering, retained assignments, concurrent writes, demotion/disable races, audit rollback, migration preservation, and direct runtime-role restrictions.

When the application uses hosted Supabase, test credentials must still point to an
isolated local server. Shell environment values take precedence over app environment files.
Do not change the application's hosted settings to run local tests.

| Setting                       | Local test purpose                                                  |
| ----------------------------- | ------------------------------------------------------------------- |
| `OPERATOR_DATABASE_URL`       | Create and remove disposable API test databases on the local server |
| `DATABASE_URL`                | Restricted API test connection to that same local server            |
| `PROCESSOR_TEST_DATABASE_URL` | Local database fixture for processor lifecycle tests                |
| `FACT_TEST_DATABASE_URL`      | Local database fixture for extraction lifecycle and allowance tests |
| `SEARCH_TEST_DATABASE_URL`    | Local database fixture for search indexing and authorization tests  |

## Code organization

- `apps/web`: Next.js, React, and Tailwind frontend with Microsoft sign-in.
- `apps/api`: Fastify API with database-enforced user and case permissions.
- `services/document-processor`: Python extraction worker; [setup and verification](python-processor.md).
- `packages/schemas`: shared strict Zod request/response contracts and TypeScript types.

Shared domain values live in `packages/schemas/src/constants` (roles, case statuses, archive filters and limits, error codes,
and audit actions). Request/response schemas and inferred types live in
`packages/schemas/src/contracts`, grouped by feature. Import both through
`@caseflow/schemas`; the package entry point only re-exports its public API.

API database code lives in `apps/api/src/database`: connection/transaction lifecycle
in `index.ts`, operation identifiers and access requirements in `operations.ts`,
operation dispatch and shared queries in `queries.ts`, case queries in `cases.ts`, connection URL validation in
`connection-config.ts`, and safe database-error translation in `errors.ts`. Application errors are defined separately in `apps/api/src/errors.ts`.

Frontend workspace components live in `apps/web/components/workspace`; case list,
shared create/edit form, versioned drafts, status badge, detail, and assignment-picker components are grouped under `cases/`. Reusable
controls, accessible confirmation dialogs, toast notifications, and loading/pagination components live in `components/ui`. In-memory edit drafts are owned by the current workspace through `lib/case-drafts.ts`. Constants used
by one component stay with that component. Shared workspace navigation constants live in
`lib/constants/navigation.ts`; URL parsing/serialization lives in `lib/workspace-location.ts`.

## Frontend organization

These paths are relative to `apps/web/`.

- `app/globals.css`: brand palette and semantic theme tokens.
- `components/ui`: shared buttons and accessible status messages.
- `components/auth`: responsive page shell, panels and sign-in presentation.
- `hooks/use-authentication.ts`: Microsoft sign-in/session actions, separate from styling.
- `lib/config.ts`, `lib/auth.ts`, `lib/api.ts`: configuration validation, MSAL initialization and API access.

Inter is self-hosted from the pinned font package. Reuse theme tokens and shared
components for new screens instead of copying colors or authentication logic.

## Dependency maintenance

The root `package.json` temporarily overrides `minimatch` to `11.0.1` only beneath
`@typescript-eslint/typescript-estree@8.72.2`. That lint dependency otherwise selects
an affected `10.x` release. This addresses
[GHSA-g3hv-75wg-m249](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249).
When upgrading TypeScript ESLint, revisit this override and remove it once the
upstream dependency resolves a patched version. Regenerate the lockfile and rerun
`npm audit`, `npm run lint`, `npm run typecheck`, and `npm run build` after changes.

## Related guides

- [Hosted database](hosted-database.md)
- [Authentication](authentication.md)
- [API reference](api.md)

## Python formatting

Use `npm run format:python` for the processor and `npm run format:python:check` to
check it without changes. The root `format` and `format:check` commands include both
Prettier and Ruff. Install the locked Python environments below first. The workspace recommends the
Python and Ruff editor extensions and uses Ruff for Python format-on-save.

## Python services

Independently deployed Python workloads live under `services/`: `document-processor` handles
native text/OCR, `fact-extractor` handles OpenAI facts, and `search-indexer` handles
passages and embeddings. Each has its own `pyproject.toml`, pinned
`uv.lock`, adapters, services, handlers, and tests. JavaScript workspaces remain under `apps/` and
`packages/`; Python environments are not npm workspaces.

After moving an existing checkout, recreate its virtual environment or run
`uv sync --project services/document-processor --locked --reinstall` to refresh executable paths.
Formatting uses Ruff with four spaces, single quotes, and 100-character lines. Prettier continues
to format TypeScript, CSS, JSON, and Markdown.

Use Python 3.13 and uv with the committed lockfiles:

```sh
uv sync --project services/document-processor --locked
uv sync --project services/fact-extractor --locked
uv sync --project services/search-indexer --locked
npm run test:processor
npm run test:facts
npm run test:search
```

Python integration fixtures require the corresponding local test setting listed above.
The processor can require database coverage explicitly:

```sh
uv run --project services/document-processor --locked pytest services/document-processor/tests --require-database
uv run --project services/fact-extractor --locked pytest services/fact-extractor/tests
uv run --project services/search-indexer --locked pytest services/search-indexer/tests
```

Lint, type, and dependency checks use each service's locked environment. For example:

```sh
uv run --project services/document-processor --locked ruff check services infra
uv run --project services/document-processor --locked mypy services/document-processor/src --strict
uv run --project services/document-processor --locked pip-audit --skip-editable
```

The same checks apply to the fact extractor and search indexer with their own project
and source paths. Live provider evaluations are separate from CI; their behavior and
limitations are described in [fact extraction](fact-extraction.md#verification).

## Infrastructure validation

Local infrastructure checks need Docker and the locked tooling environment, not cloud
credentials. The wrapper builds Linux-compatible packages from temporary source directories.

```sh
uv sync --project infra/document-processing --locked
uv run --project infra/document-processing --locked python infra/document-processing/scripts/validate_security.py
uv run --project infra/document-processing --locked pytest infra/document-processing/tests
uv run --project infra/document-processing --locked python infra/document-processing/scripts/build.py
uv run --project infra/document-processing --locked python infra/document-processing/scripts/verify_build.py
```

## Authentication settings

Next.js reads `apps/web/.env.local`; the API reads `apps/api/.env`. Public frontend
identifiers are fixed at build time. The local SPA callback is
`http://localhost:3000/auth/callback`; it must match the Entra registration.
The [authentication guide](authentication.md) explains registration and token boundaries.

## Local role administration

After signing in to the local application once, copy the application user ID from
**Profile**. With the operator connection pointing to that same local database:

```sh
npm run operator:role -- <application-user-id> super_admin
```

Replace the angle-bracket argument with the profile ID before running the command.
The tool also supports `staff` and `admin`, audits changes, and protects the last active
Super Admin. This is local developer tooling; hosted operations are documented privately.
