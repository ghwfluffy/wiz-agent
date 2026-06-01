# Decisions And Open Questions

## Decisions

- Backend is TypeScript on Node.js 20+.
- API framework is Hono.
- Postgres is the canonical data store.
- Schema migrations are currently applied by the TypeScript migration runner in
  `api/src/db/migrate.ts`.
- Zod owns runtime schemas for config, API payloads, and tool contracts.
- Vitest is used for backend and frontend tests.
- Frontend is Vue 3, Vite, TypeScript, Pinia, Vue Router, and Carbon.
- Local development starts in `AUTH_MODE=standalone`.
- Standalone mode has one development user.
- Standalone sign-in uses a development-only endpoint, not passwords.
- Omnisite mode uses federated OAuth and local server-side sessions.
- Central OAuth `is_admin` userinfo controls the local admin flag.
- The app has separate API and worker process roles.
- The worker starts as a Compose-managed loop, discovers users with due work or
  deliverable outbound messages, and runs one scheduler tick per user.
- The worker outbound delivery loop is globally rate-limited to one message per
  20 second tick, which is no more than three messages per minute.
- Standalone sign-in persists the configured development user, identity,
  session, and audit event.
- Task APIs enforce user ownership in the service layer.
- Agent runtime uses an internal `AgentModelClient` adapter.
- Real OpenAI calls are isolated behind `OpenAIModelClient`; tests use
  `MockModelClient`.
- OpenAI calls use the Responses API through the `OpenAIModelClient` adapter.
- Validated local persistence tools execute through deterministic host code.
- Sender classification gates inbound mail before any agent/tool path.
- Unknown senders are `untrusted` and can only queue owner review; they cannot
  trigger tool calls.
- Cross-app API access goes through a deterministic gateway with user-scoped
  tokens that are never exposed to the model.
- The app capability registry is the source of truth for the agent's durable
  understanding of Goals, Fluffynomics, and future GHWIZ app APIs.

## Open Questions

- Should local attachment/article artifacts live in Postgres, mounted storage,
  or object storage for the first release?
- What exact long-term approval policy should allow automatic SMS, MMS, or email
  sends beyond explicitly owner-authorized deployment checks?
- What maximum image dimensions and byte limits should MMS use?
- How should durable user-wide spam/rate limits be stored for live IMAP
  polling?
- Whether future apps should keep using the shared HMAC agent-token secret or
  move to a central token-exchange service when integration count grows.
