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
Do not use `--no-backup` unless you intend to delete local database volumes.
Stopping the app with Ctrl+C does not stop these containers.

Configuration lives in `supabase/config.toml`. Microsoft Entra remains the sign-in provider.
Local data is separate from any hosted Supabase project and does not sync automatically.

### First-time database setup

After copying the app environment examples, create the ignored
`apps/api/.env.operator` with this **local-only** operator connection:

```dotenv
OPERATOR_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
```

Then run from the repository root:

```sh
npm run db:start
npm run db:migrate
npm run db:configure
npm run db:seed
npm run dev
```

`db:configure` generates a random runtime password and writes `DATABASE_URL` to
`apps/api/.env`. Running it again rotates that local password; restart the API.
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

When the application uses hosted Supabase, follow [local tests and switching environments](hosted-database.md#local-tests-and-switching-environments) to keep integration tests on a disposable local database.

## Code organization

- `apps/web`: Next.js, React, and Tailwind frontend with Microsoft sign-in.
- `apps/api`: Fastify API with database-enforced user and case permissions.
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
