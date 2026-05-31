# Auth And Tenancy

The app supports two auth modes.

## Standalone Mode

`AUTH_MODE=standalone` is for local development only.

Behavior:

- `GET /api/v1/auth/me` returns anonymous until the user signs in.
- `POST /api/v1/auth/dev-login` creates or updates the configured development
  tenant, user, membership, email identity, and normal local session.
- The frontend sign-in button calls `dev-login`.
- No password, registration, invitation-code, or local user-management workflow
  exists.
- The development endpoint must be disabled outside standalone mode.
- Development auto-login writes an audit event.

Standalone mode still creates the same request context shape used by omnisite
mode: tenant id, user id, actor type, and permissions.

## Omnisite OAuth Mode

`AUTH_MODE=oauth` is used when the app is published into the omnisite.

Behavior:

- login creates a short-lived server-side state record and redirects to the
  central auth app with PKCE S256;
- callback consumes state once and exchanges the code through an internal OAuth
  server URL configured by `OAUTH_SERVER_BASE_URL`;
- callback fetches central userinfo and upserts a local tenant, user,
  membership, and identity;
- the app creates its own local session after successful OAuth;
- failed callbacks redirect back to the app UI with a friendly error token.

The local user id is derived from the central subject and identity provider. The
central `is_admin` userinfo claim controls the local admin flag.

The root omnisite repository owns production hosts, subpaths, redirect URIs, and
OAuth client registration.

## Tenant Context

Every authenticated request should resolve a context containing:

```text
tenantId
userId
actorType
permissions
requestId
```

Domain services should require this context for tenant-scoped operations.

## API Error Envelope

Authenticated API routes use a stable error envelope:

```json
{
  "error": {
    "code": "http_401",
    "message": "Not authenticated.",
    "field_errors": [],
    "request_id": "request-id"
  }
}
```
