# Auth And Tenancy

The app supports two auth modes.

## Standalone Mode

`AUTH_MODE=standalone` is for local development only.

Behavior:

- `GET /api/v1/auth/me` returns anonymous until the user signs in.
- `POST /api/v1/auth/dev-login` creates a normal local session for the
  configured development user.
- The frontend sign-in button calls `dev-login`.
- No password, registration, invitation-code, or local user-management workflow
  exists.
- The development endpoint must be disabled outside standalone mode.

Standalone mode still creates the same request context shape used by omnisite
mode: tenant id, user id, actor type, and permissions.

## Omnisite OAuth Mode

`AUTH_MODE=oauth` will be used when the app is published into the omnisite.

Behavior:

- login redirects to the central auth app;
- callback validates state and exchanges the code through an internal OAuth
  server URL;
- the app creates its own local session after successful OAuth;
- failed callbacks redirect back to the app UI with a friendly error token.

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
