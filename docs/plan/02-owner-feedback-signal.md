# Phase 02: Owner Feedback As Training Signal

## Goal

Make owner corrections first-class durable data. When the owner corrects the
assistant's behavior, wording, timing, memory categorization, or tool choice,
the system should capture the correction with enough context to improve future
behavior.

## Implementation Scope

- Add a model-facing tool for corrections, for example
  `record_owner_feedback`.
- Store structured feedback in markdown under:
  - `/assistant/feedback/YYYY-MM.md`.
- Include fields such as:
  - feedback type: communication, memory, task, tool, schedule, app action,
    preference, other;
  - owner correction text;
  - original behavior/context summary;
  - affected memory/task/tool/message ids when available;
  - whether the correction is durable, tentative, or one-off;
  - recommended follow-up target, such as communication preferences, newsletter
    preferences, task policy, list memory, or capability guidance.
- Update owner inbound prompt guidance so the model records feedback whenever
  the owner corrects the agent, even when the owner does not use consistent
  wording.
- Ensure feedback does not automatically rewrite preferences unless the owner's
  correction clearly states a durable preference or another controlled tool
  makes that update with rationale.

## Expected Behavior

Examples that should be captured:

- "Don't text me this early."
- "That was not a task, just remember it."
- "I care about infrastructure news, not funding announcements."
- "You asked me the same thing twice."
- "Use my goals app for that, not a generic task."

## Suggested Tests

- Tool validation and execution writes feedback markdown and audit events.
- Owner inbound prompt includes intent-based feedback guidance.
- A mock owner prompt can route an inconsistent correction into
  `record_owner_feedback`.
- Feedback memory is user-scoped and RAG-indexed through markdown writes.
- Feedback is included in scheduled self-review and memory-review context where
  useful.

## Docs

Update:

- `docs/architecture/30-domain-model.md`
- `docs/architecture/50-agent-runtime.md`
- `docs/architecture/60-connectors-and-side-effects.md`
- `docs/architecture/90-testing-and-quality.md`
- `docs/development.md`

## Commit

Commit message:

```text
Record owner feedback signals
```

