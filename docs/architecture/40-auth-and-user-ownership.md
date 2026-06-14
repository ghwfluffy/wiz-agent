# Auth And User Ownership

The app supports two auth modes.

## Standalone Mode

`AUTH_MODE=standalone` is for local development only.

Behavior:

- `GET /api/v1/auth/me` returns anonymous until the user signs in.
- `POST /api/v1/auth/dev-login` creates or updates the configured development
  user, email identity, and normal local session.
- The frontend sign-in button calls `dev-login`.
- No password, registration, invitation-code, or local user-management workflow
  exists.
- The development endpoint must be disabled outside standalone mode.
- Development auto-login writes an audit event.

Standalone mode still creates the same request context shape used by omnisite
mode: user id, actor type, permissions, and request id.

## Omnisite OAuth Mode

`AUTH_MODE=oauth` is used when the app is published into the omnisite.

Behavior:

- login creates a short-lived server-side state record and redirects to the
  central auth app with PKCE S256;
- callback consumes state once and exchanges the code through an internal OAuth
  server URL configured by `OAUTH_SERVER_BASE_URL`;
- callback fetches central userinfo and upserts a local user and central
  identity;
- the app creates its own local session after successful OAuth;
- after the frontend restores auth state and finds no active session, it
  automatically redirects to the OAuth login endpoint;
- failed callbacks redirect back to the app UI with a friendly error token.

The local user id is derived from the central subject and identity provider. The
central `is_admin` userinfo claim controls the local admin flag.

The root omnisite repository owns production hosts, subpaths, redirect URIs, and
OAuth client registration.

The Vue shell uses the shared `vendor/federated-banner` package in omnisite
mode. The banner receives app-switcher base paths from root-owned frontend build
configuration and links shared identity management back to central Account
Settings.

For live operational seeding, the target central OAuth user must already have a
matching local agent user and `central-oauth` identity. A normal OAuth sign-in
creates that mapping automatically; operators may also insert it deliberately
before running `npm run seed:live-config` for an existing central admin account.

## User Context

Every authenticated request should resolve a context containing:

```text
userId
actorType
permissions
requestId
```

Domain services should require this context for user-owned operations. Normal
users are always filtered by their own `user_id`. Admin users may query all
users' audit logs through explicit admin-only routes.

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
