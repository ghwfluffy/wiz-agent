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
- The development endpoint must be disabled outside standalone mode and in
  production, even if standalone mode is accidentally configured there.
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
- failed callbacks, including provider-side OAuth errors, redirect back to the
  app UI with a friendly error token;
- OAuth state records are single-use and never treated as app sessions.

The local user id is derived from the central subject and identity provider. The
central `is_admin` userinfo claim controls the local admin flag.

The root omnisite repository owns production hosts, subpaths, redirect URIs, and
OAuth client registration.

The Vue shell uses the shared `vendor/federated-banner` package in both auth
modes. Standalone mode passes no federated app links; omnisite OAuth mode passes
app-switcher base paths from root-owned frontend build configuration and links
shared identity management back to central Account Settings.

The parent deployment may provide one `VITE_FEDERATED_APPS` JSON inventory.
When present it is authoritative; individual app base URL variables remain only
as a deployment-neutral fallback.

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

## Background session recovery

The browser API client handles an expired app session by fetching its configured
OAuth login URL in the background, with same-origin cookies, then retrying the
rejected request once. Redirects and PKCE callbacks run through the existing
server endpoints without replacing the visible document or losing UI state.
Concurrent failures share one recovery attempt; recovery has a ten-second limit.
Only authentication failures qualify; permission denials, network failures,
password sign-in and logout do not trigger recovery. OAuth-disabled consumers
retain their local behavior. If the retry fails, existing error/sign-in handling
applies. Central Remember Me cookies remain private to the auth app; no tokens
are exposed to browser JavaScript. Browser recovery grants no assistant access
and never applies to external gate-control requests or scoped assistant tokens.
