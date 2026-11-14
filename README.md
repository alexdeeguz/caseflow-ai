# CaseFlow AI

TypeScript monorepo with Microsoft Entra sign-in and a protected identity endpoint. Case management and document processing are not implemented.

## Structure

- `apps/web`: Next.js, React, and Tailwind frontend with Microsoft sign-in.
- `apps/api`: Fastify API with a protected `/me` endpoint.
- `packages/schemas`: shared TypeScript package with Zod installed; no domain contracts yet.

## Setup

Use Node.js 24.22.3 and npm 11.x (expected npm version: 11.12.1).

```sh
cd ~/Desktop/caseflow-ai
npm install
cp apps/web/.env.example apps/web/.env.local
cp apps/api/.env.example apps/api/.env
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

The web starter runs at http://localhost:3000. The API binds to http://127.0.0.1:4000; `GET /me` requires a valid CaseFlow access token. The root path returns 404. Stop development with Ctrl+C.

## Commands

```sh
npm run dev:web
npm run dev:api
npm run build
npm run lint
npm run typecheck
npm run format:check
npm test
```

## Authentication

Both Entra registrations support organizational and personal Microsoft accounts.
Configure `CaseFlow Web - Local` with the SPA redirect URI
`http://localhost:3000/auth/callback`. MSAL 5 uses this dedicated redirect bridge;
the page is outside authentication initialization and is served with `no-store`.
Do not configure Cross-Origin-Opener-Policy on the callback page.

The API registration exposes `access_as_user` (Admins and users may consent),
uses v2 access tokens, and the Web registration requests this delegated permission.
Some organizations require their administrator to approve third-party applications.
No client secret or Microsoft Graph permission is needed.

Copy each app's `.env.example` as shown above only on first setup; preserve existing
local settings. The supplied IDs and scope are public registration identifiers.
Next.js reads `.env.local`; the API loads `.env` through Node's environment-file
support. Production should supply environment variables through its host. The
frontend's `NEXT_PUBLIC_*` settings are public and fixed at build time. Rebuild
when changing them. Use HTTPS origins and register the deployment's callback URI
before deploying; allow only that frontend origin in API CORS settings.

`GET /me` accepts `Authorization: Bearer <access-token>` and responds with:

```json
{
  "subject": "subject-from-the-verified-token",
  "tenantId": "verified-tenant-id",
  "name": "Display name or null",
  "access": "demo"
}
```

Responses: 200 verified identity; 401 missing/invalid token; 403 missing delegated
scope; 503 signing-key service unavailable. Responses are not cached. The API
checks RS256 signatures, tenant/issuer consistency, signing-key issuer, audience,
expiry/not-before, v2 format, allowed client and scope. Identity is scoped by tenant
and subject; display names and email addresses are not authorization identifiers.
All accepted users receive only the demo designation. No case data or admin
permissions are granted by this endpoint. Future case routes require their own
server-side authorization checks.

Tokens are managed by MSAL in session storage, sent only to the configured API,
and never displayed or deliberately logged. Sign-out clears the local MSAL session
and redirects to Microsoft; it does not revoke already-issued bearer tokens.

`npm test` runs signed-token API tests using ephemeral local keys, including
consumer/organizational identity, invalid signatures/claims, missing permission,
provider failure and CORS. Frontend tests cover configuration validation, network
errors, timeouts and response validation. API requests refuse HTTP redirects to
keep bearer tokens scoped to the configured endpoint. These tests do not establish that your live Entra
registration is configured correctly. To verify live: run `npm run dev`, open
`http://localhost:3000`, sign in, click **Verify demo access**, then sign out.
Repeat with a personal and a work/school account when available. Never paste tokens
or session cookies into issue reports.

## Frontend organization

- `app/globals.css`: brand palette and semantic theme tokens; exact source colors are documented inline.
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
