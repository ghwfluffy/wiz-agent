# System Overview

AI Assistant is a web application plus background worker for running a personal
agent safely.

## Runtime Components

- API service: HTTP API, session handling, user context, domain writes, and
  admin routes.
- Worker service: due task processing, per-user IMAP mailbox polling,
  rate-limited outbound queues, and agent runs.
- Web service: Vue/Carbon frontend.
- Nginx service: production-style static frontend and API proxy.
- Postgres: canonical durable state.

## Development Mode

The project starts in standalone local mode. The local Compose stack runs
Postgres, API, worker, web, and Nginx. It uses one development user. A
development sign-in endpoint creates a normal local session without involving
OAuth.

## Omnisite Mode

When published into the omnisite, this app becomes a sub-app behind a path
prefix. The root deployment repository owns the production route, public host,
OAuth client registration, and secrets. This submodule must stay deployable with
placeholder base paths and must not contain production hostnames or production
subpaths.

In omnisite mode, the API, worker, and migration service use the root-owned
shared Postgres service. The API and worker also need outbound egress for OpenAI
and SMTP delivery, but cross-app API calls remain on the root-owned internal
agent network. Production connector files are mounted read-only from the root
checkout's ignored `apps/agent/secrets/` directory.

User-owned connector settings are stored in the database and managed from the
web Settings tab. That includes the user's contact details, SMS/MMS gateway
addresses, assistant mailbox identity, IMAP settings, and SMTP settings. The
webmaster-provisioned OpenAI API key remains deployment-owned secret
configuration and is never displayed in the UI.

## Agent Boundary

The agent does not receive raw credentials or unrestricted access to databases,
mailboxes, file systems, shell commands, or external network fetches. It proposes
actions through typed tools. Deterministic host code validates user scope,
authorization, policy, budgets, idempotency, and approval requirements before
anything is persisted or sent.
