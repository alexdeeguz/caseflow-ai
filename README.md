# CaseFlow AI

CaseFlow AI is a case and document workspace built with TypeScript and Python. It combines
Microsoft sign-in, role-based access, case management, and private document storage.
Use fictional data for demonstrations and testing.

## Features

- **Users and permissions:** persistent profiles, Staff/Admin/Super Admin roles,
  case assignments, account access controls, and audit history.
- **Cases:** creation, searchable lists, details, editing, and reversible archiving
  with version checks to prevent overwriting concurrent changes.
- **Documents:** direct S3 uploads with server verification, a paginated library,
  authorized downloads, reversible removal, and processing status with Admin start/retry controls.
- **Document processing:** atomic job/dispatch creation, an opt-in API dispatcher
  for SQS, authorized processing status/start/retry endpoints, restricted processor database functions,
  and Python extraction/completion workers.

Native PDF extraction, Textract OCR, bounded recovery, and monitoring are implemented and verified with fictional documents. Queue consumers and scheduled recovery run in AWS; continuous dispatch runs with the API. See [workflow verification](docs/processing-verification.md). File previews and extracted-text viewing remain outside this phase.

- **Fact extraction:** OpenAI-only unreviewed facts, queued automatically when document processing
  reaches Ready, with exact source quotations and a shared daily allowance. Retries and human
  review remain manual. The development consumer and dispatcher are enabled. See [fact extraction](docs/fact-extraction.md).

- **Human review:** versioned fact corrections, Staff rejection, administrator approval/reopening,
  immutable evidence, and protected review history. See [human review](docs/human-review.md).

- **Case timeline and reviewed summary:** read-only approved facts across available case documents,
  precise dates, category counts, source quotations, and authorized downloads. See [case history](docs/case-history.md).

- **Document search:** keyword and pgvector semantic search over processed document text,
  restricted to cases the user can access, with highlighted snippets, a global Search page, and
  per-case search. See [document search](docs/document-search.md).

## Stack and structure

| Location                                                   | Responsibility                                                               |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [apps/web](apps/web)                                       | Next.js, React, and Tailwind frontend with Microsoft Entra authentication    |
| [apps/api](apps/api)                                       | Fastify API with PostgreSQL authorization, S3 storage, and an SQS dispatcher |
| [services/document-processor](services/document-processor) | Python workers for native text, Textract starts, and OCR completion          |
| [services/fact-extractor](services/fact-extractor)         | Python worker for OpenAI structured facts and evidence validation            |
| [services/search-indexer](services/search-indexer)         | Python worker for search chunks and OpenAI embeddings                        |
| [infra/fact-extraction](infra/fact-extraction)             | Fact queue/worker, secrets, and monitoring definitions                       |
| [infra/search-indexing](infra/search-indexing)             | Search indexing queue/worker, secrets, and monitoring definitions            |
| [infra/document-processing](infra/document-processing)     | SAM template, isolated validation tooling, and container builds              |
| [packages/schemas](packages/schemas)                       | Handwritten shared Zod contracts, constants, and TypeScript types            |
| [supabase](supabase)                                       | PostgreSQL migrations, local configuration, and fictional seed data          |
| [docs](docs)                                               | Setup guides, feature behavior, and technical references                     |

The API connects to a private PostgreSQL schema using restricted credentials.
Microsoft Entra provides authentication; S3 stores document bytes. The browser does
not receive database credentials. See [code organization](docs/development.md#code-organization)
for module boundaries and reusable frontend components.

## Getting started

Use **Node.js 24.22.3** and **npm 11.x** (expected version: **11.12.1**).
With nvm, run `nvm install` and `nvm use` from the repository root first.
Local PostgreSQL requires Docker Desktop; hosted Supabase is also supported.

1. Install dependencies and create local environment files on first setup:

   ```sh
   npm install
   cp apps/web/.env.example apps/web/.env.local
   cp apps/api/.env.example apps/api/.env
   ```

   Preserve existing environment files when updating an installation.

2. Configure [Microsoft Entra authentication](docs/authentication.md#registration-and-configuration)
   and choose either [local PostgreSQL](docs/development.md#local-database) or
   [hosted Supabase](docs/hosted-database.md). Complete that guide's migrations and
   restricted database connection setup before starting the app.
3. Start both apps from the repository root:

   ```sh
   npm run dev
   ```

4. Open [localhost:3000](http://localhost:3000) and sign in. New users start as Staff
   with no case assignments. Follow [roles and administration](docs/users-and-cases.md#roles-and-administration)
   to bootstrap a Super Admin in the selected database.
5. Configure [document storage](docs/document-management.md#configuration) to enable
   uploads and downloads. Core profile and case features work without S3 configuration.

The API binds to `http://127.0.0.1:4000`; its root path returns 404 and `GET /me`
requires a valid CaseFlow access token. Stop the apps with Ctrl+C. If using local
Supabase, stop its containers separately with `npm run db:stop`.

## Common commands

Run commands from the repository root.

| Command                    | Purpose                                                        |
| -------------------------- | -------------------------------------------------------------- |
| `npm run dev`              | Start the frontend, API, and shared-schema watcher             |
| `npm run build`            | Build all workspaces for production                            |
| `npm run test:processor`   | Run Python unit tests (requires uv/Python setup)               |
| `npm run test:facts`       | Run fact-extractor unit tests                                  |
| `npm test`                 | Run unit tests                                                 |
| `npm run test:integration` | Run PostgreSQL integration tests on disposable local databases |
| `npm run lint`             | Check ESLint rules                                             |
| `npm run typecheck`        | Check TypeScript types                                         |
| `npm run format:check`     | Check Prettier formatting                                      |

See [local development](docs/development.md) for database commands, running apps
individually, integration-test prerequisites, and dependency maintenance.

## Documentation

| Guide                                              | Contents                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [Local development](docs/development.md)           | Docker/PostgreSQL setup, verification, code organization, and dependency maintenance        |
| [Hosted database](docs/hosted-database.md)         | Connection design, TLS, restricted roles, environment switching, and backups                |
| [Authentication](docs/authentication.md)           | Entra registration, token validation, session behavior, and sign-in verification            |
| [Users and cases](docs/users-and-cases.md)         | Permission matrix, Super Admin setup, assignments, editing, and archiving                   |
| [Fact extraction](docs/fact-extraction.md)         | OpenAI facts, evidence, allowance controls, evaluation, and monitoring                      |
| [Case history](docs/case-history.md)               | Approved timeline, structured summary, sources, permissions, and freshness                  |
| [Human review](docs/human-review.md)               | Corrections, approval permissions, immutable evidence, revision history, and release checks |
| [API reference](docs/api.md)                       | Route organization, request/response contracts, pagination, and errors                      |
| [Document management](docs/document-management.md) | S3 configuration, uploads, library, downloads, removal, and consistency rules               |
| [Document processing](docs/document-processing.md) | Job/dispatch records, the API dispatcher, permissions, and configuration                    |
| [Processor database](docs/processor-database.md)   | Worker functions, leases, OCR allowance, artifacts, cancellation, and the processor login   |
| [Python processor](docs/python-processor.md)       | Extraction, OCR decisions, resource limits, configuration, and verification                 |
| [Textract completion](docs/textract-completion.md) | Notification validation, result collection, artifact format, and publication recovery       |

See [Lambda configuration](docs/lambda-configuration.md) for runtime settings, credentials and
packaged TLS trust, IAM boundaries, and container builds.

See [processing recovery and monitoring](docs/processing-recovery.md) for recovery rules, monitoring, alerts, and operator recovery principles.

See [workflow verification](docs/processing-verification.md) for the automated test matrix, end-to-end results with fictional native, scanned, and image documents, and known limits.
