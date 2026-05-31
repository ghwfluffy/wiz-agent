# Agent Instructions

## Project Basics

- This is a TypeScript personal AI assistant app with an API service, worker,
  Vue/Carbon web UI, and PostgreSQL persistence.
- Read `project-description.md` first when present.
- Early development targets standalone local mode. Omnisite OAuth is added later
  without adding local password auth.

## Documentation Map

- Reusable cross-project defaults: `docs/project-standards/README.md`
- Project-specific architecture: `docs/architecture/`
- Development/runbook: `docs/development.md`
- Public overview: `README.md`

## Working Rules

- Follow reusable standards unless project-specific docs explicitly override
  them.
- Keep project-specific decisions in `docs/architecture/`, not in
  `docs/project-standards/`.
- Update docs when introducing a durable architecture, config, auth, deployment,
  or validation decision.
- Keep `api/src/integrations/capabilityRegistry.ts` current whenever the agent
  learns about a GHWIZ app, app API, or user-facing capability. Registry updates
  should include purpose, allowed actions, token/scope expectations, safety
  boundaries, and response guidance.
- Do not read, print, or expose files under `secrets/` unless the user
  explicitly asks for secret-file maintenance.
- Keep production hostnames, production subpaths, redirect URIs, and deployment
  config out of this submodule. The omnisite root repo owns those values.
- Add or update automated tests for behavior changes.

## Verification Loop

- Run the narrowest relevant tests while iterating.
- Before declaring completion, run `./scripts/validate.sh` when feasible.
- If full validation cannot be run, state exactly what was and was not verified.
- Do not claim success without running or explaining verification.
