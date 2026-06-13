# Assistant Reliability And Insight Plan

This plan turns the next assistant-improvement suggestions into sequential
implementation phases. Each phase should be implemented and committed by one
worker, then reviewed by the main agent before the next phase begins.

## Shared Constraints

- Read `AGENTS.md`, `project-description.md`, this overview, the phase doc, and
  relevant `docs/architecture/` files before editing.
- Do not read, print, or expose files under `secrets/`.
- Preserve existing user changes and previous phase commits.
- Keep deterministic host code responsible for state, authorization, policy,
  scheduling, credentials, and side effects.
- Agent/model-facing behavior must go through existing MCP/tool contracts where
  practical.
- Add or update automated tests for behavior changes.
- Update architecture/development docs for durable design, config, UX, or
  operational decisions.
- Run focused tests while iterating and `./scripts/validate.sh` when feasible.

## Phase Order

1. Memory quality review loop.
2. Owner feedback as a durable training signal.
3. Decision ledger.
4. Conversation threading and continuity.
5. Memory write preview and diff UI.
6. Owner-message intent classifier.
7. Agent simulation harness.
8. Personal dashboard insights.

Phases are ordered so durable data and review surfaces arrive before the UI and
simulation layers that depend on them.

