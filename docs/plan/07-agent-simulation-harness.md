# Phase 07: Agent Simulation Harness

## Goal

Add scenario-level tests that simulate multi-step assistant days. This catches
regressions that single-call unit tests miss.

## Implementation Scope

- Add a test helper/harness under `api/tests/` or `api/tests/helpers/`.
- The harness should support:
  - creating a test user/session/context;
  - sending owner messages;
  - receiving newsletter messages;
  - advancing time;
  - running worker ticks;
  - supplying staged mock model tool calls;
  - asserting memory/task/outbox/approval/decision/thread state.
- Add scenario tests for at least:
  - newsletter ingestion stays knowledge-only, then scheduled interest check
    proposes one conversational message or stays quiet;
  - owner says "Desperado is one for movie night" and later asks for the
    remembered Banderas movie;
  - a repeated tool loop hits guardrails and self-review/memory-review can see
    the failure;
  - owner correction is recorded as feedback and affects future prompt context;
  - conversation thread continuity across a follow-up.

## Expected Behavior

The harness should be ergonomic enough for future agents to add scenarios
without duplicating large setup blocks. Keep it test-only and deterministic.

## Suggested Tests

The scenario tests are the deliverable. They should run as part of normal API
test execution and avoid network access.

## Docs

Update:

- `docs/architecture/90-testing-and-quality.md`
- `docs/development.md`

## Commit

Commit message:

```text
Add agent simulation harness
```

