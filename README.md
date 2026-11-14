# CaseFlow AI

Initial TypeScript monorepo scaffold. Application features have not been implemented.

## Structure

- `apps/web`: minimal Next.js, React, and Tailwind starter.
- `apps/api`: Fastify server entry point with no application routes.
- `packages/schemas`: shared TypeScript package with Zod installed; no domain contracts yet.

## Setup

Use Node.js 24.22.3 and npm 11.x (expected npm version: 11.12.1).

```sh
cd ~/Desktop/caseflow-ai
npm install
npm run dev
```

If using nvm, run `nvm install` and `nvm use` first.

A project-local toolchain is also available on this Mac, without changing global Node:

```sh
export PATH="$PWD/.tools/node_modules/.bin:$PATH"
node --version
npm --version
```

To recreate that optional toolchain: `npm install --prefix .tools --no-save --package-lock=false node@24.22.3 npm@11.12.1`.

The web starter runs at http://localhost:3000. The API binds to http://127.0.0.1:4000; all requests currently return 404 because no routes exist. Stop development with Ctrl+C.

## Commands

```sh
npm run dev:web
npm run dev:api
npm run build
npm run lint
npm run typecheck
npm run format:check
```

There are no tests yet. No case data, authentication, database, AI integration, background jobs, containers, CI, or deployment has been added. `.env.example` documents optional API settings; the starter reads exported environment variables and does not automatically load this file.

## Dependency maintenance

The root `package.json` temporarily overrides `minimatch` to `11.0.1` only beneath
`@typescript-eslint/typescript-estree@8.72.2`. That lint dependency otherwise selects
an affected `10.x` release. This addresses
[GHSA-g3hv-75wg-m249](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249).
When upgrading TypeScript ESLint, revisit this override and remove it once the
upstream dependency resolves a patched version. Regenerate the lockfile and rerun
`npm audit`, `npm run lint`, `npm run typecheck`, and `npm run build` after changes.
