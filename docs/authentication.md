# Authentication

[Back to README](../README.md)

Microsoft Entra authenticates users; PostgreSQL stores their application profile, role, account status, and case access.

## Registration and configuration

Both Entra registrations support organizational and personal Microsoft accounts.
The browser registration uses a dedicated SPA callback bridge outside authentication
initialization. The callback is served with `no-store` and without
Cross-Origin-Opener-Policy so MSAL can complete its redirect flow.

The API registration exposes `access_as_user` (Admins and users may consent),
uses v2 access tokens, and the browser registration requests this delegated permission.
Some organizations require their administrator to approve third-party applications.
No client secret or Microsoft Graph permission is needed.

Frontend registration identifiers are public configuration fixed at build time.
Callback addresses must match registered redirects, and API CORS accepts only the
configured frontend origin. Environment-file setup is covered by
[local development](development.md#authentication-settings).

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
mutations invalidate cached resources. Authorization rejection clears protected content. Views that support stale data
retain it during transient failures and pause protected actions until access is verified.
Leaving the workspace clears its cache and cancels pending requests.

Tokens are managed by MSAL in session storage, sent only to the configured API,
and never displayed or deliberately logged. Sign-out clears the local MSAL session
and redirects to Microsoft; it does not revoke already-issued bearer tokens.

## Verification

Signed-token API tests run using ephemeral local keys, including
consumer/organizational identity, invalid signatures/claims, missing permission,
provider failure and CORS. Frontend tests cover configuration validation, network
errors, timeouts and response validation. API requests refuse HTTP redirects to
keep bearer tokens scoped to the configured endpoint. These tests do not establish that
an external Entra registration is configured correctly. Local checks are described in
[development](development.md#verification).

## Related guides

- [Users and cases](users-and-cases.md)
- [API reference](api.md)
- [Hosted database](hosted-database.md)
