# Authentication

[Back to README](../README.md)

Microsoft Entra authenticates users; PostgreSQL stores their application profile, role, account status, and case access.

## Registration and configuration

Both Entra registrations support organizational and personal Microsoft accounts.
Configure `CaseFlow Web - Local` with the SPA redirect URI
`http://localhost:3000/auth/callback`. MSAL 5 uses this dedicated redirect bridge;
the page is outside authentication initialization and is served with `no-store`.
Do not configure Cross-Origin-Opener-Policy on the callback page.

The API registration exposes `access_as_user` (Admins and users may consent),
uses v2 access tokens, and the Web registration requests this delegated permission.
Some organizations require their administrator to approve third-party applications.
No client secret or Microsoft Graph permission is needed.

Copy each app's `.env.example` using the [quick start](../README.md#getting-started) only on first setup; preserve existing local settings. The supplied IDs and scope are public registration identifiers.
Next.js reads `.env.local`; the API loads `.env` through Node's environment-file
support. Production should supply environment variables through its host. The
frontend's `NEXT_PUBLIC_*` settings are public and fixed at build time. Rebuild
when changing them. Use HTTPS origins and register the deployment's callback URI
before deploying; allow only that frontend origin in API CORS settings.

## Identity and access checks

`GET /me` returns `{ id, displayName, role, active }` from PostgreSQL. Provisioning
uses the verified Entra tenant ID and subject as immutable identity, never an email
or editable name. Later sign-ins do not overwrite roles, disabled status, or names.

The API checks RS256 signatures, tenant/issuer consistency, signing-key issuer,
audience, expiry/not-before, v2 format, allowed client and delegated scope before
accessing application data. Every request reloads current application authorization.

## Session behavior

The frontend waits for session restoration before choosing the sign-in or workspace
screen. Workspace queries use an in-memory React Query client scoped to the current
user and role. Navigation revalidates the destination before switching sections;
mutations invalidate cached resources. Request failures hide cached results, and
leaving the workspace clears its cache and cancels pending requests.

Tokens are managed by MSAL in session storage, sent only to the configured API,
and never displayed or deliberately logged. Sign-out clears the local MSAL session
and redirects to Microsoft; it does not revoke already-issued bearer tokens.

## Verification

`npm test` runs signed-token API tests using ephemeral local keys, including
consumer/organizational identity, invalid signatures/claims, missing permission,
provider failure and CORS. Frontend tests cover configuration validation, network
errors, timeouts and response validation. API requests refuse HTTP redirects to
keep bearer tokens scoped to the configured endpoint. These tests do not establish that your live Entra
registration is configured correctly. To verify live: run `npm run dev`, open
`http://localhost:3000`, sign in, confirm the workspace opens, then sign out.
Repeat with a personal and a work/school account when available. Never paste tokens
or session cookies into issue reports.

## Related guides

- [Users and cases](users-and-cases.md)
- [API reference](api.md)
- [Hosted database](hosted-database.md)
