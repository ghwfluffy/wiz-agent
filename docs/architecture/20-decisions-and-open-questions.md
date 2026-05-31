# Decisions And Open Questions

## Decisions

- Backend is TypeScript on Node.js 20+.
- API framework is Hono.
- Postgres is the canonical data store.
- Zod owns runtime schemas for config, API payloads, and tool contracts.
- Vitest is used for backend and frontend tests.
- Frontend is Vue 3, Vite, TypeScript, Pinia, Vue Router, and Carbon.
- Local development starts in `AUTH_MODE=standalone`.
- Standalone mode has one development tenant and one development user.
- Standalone sign-in uses a development-only endpoint, not passwords.
- Omnisite mode later uses federated OAuth and local server-side sessions.
- The app has separate API and worker process roles.
- The worker starts as a Compose-managed loop, with database locking added as
  scheduled work grows.

## Open Questions

- Which OpenAI model IDs should seed the default `fast`, `smart`,
  `orchestrator`, and `repair` tiers at the time of implementation?
- Which mailbox and SMS/MMS gateway providers will be used first?
- Should local attachment/article artifacts live in Postgres, mounted storage,
  or object storage for the first release?
- Which central auth claim or local config should grant admin rights in omnisite
  mode?
- What exact approval policy should allow automatic SMS, MMS, or email sends?
- What maximum image dimensions and byte limits should MMS use?
