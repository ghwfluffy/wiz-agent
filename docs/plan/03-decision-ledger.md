# Phase 03: Decision Ledger

## Goal

Add a durable decision ledger so the owner can inspect why the assistant acted,
stayed quiet, deferred work, requested approval, or changed a schedule.

## Implementation Scope

- Add host-side helper(s) for appending decisions under:
  - `/assistant/decisions/YYYY-MM.md`.
- Record decisions from meaningful autonomous paths:
  - scheduled newsletter interest checks;
  - autonomous wake reviews;
  - self-review and memory-review outcomes;
  - owner-visible outbound proposals;
  - owner-clarification requests;
  - cross-app approval requests;
  - task schedule/status changes.
- Decision entries should include:
  - timestamp;
  - trigger/source;
  - action chosen;
  - alternatives/deferred action when available;
  - context summary;
  - rationale;
  - linked task/run/tool/message/approval ids;
  - owner-visible side effect status.
- Prefer deterministic host-side entries based on existing records and tool
  results. Do not require a second model call just to write the ledger.

## Expected Behavior

The web UI and future tools should be able to answer:

- "Why did you message me?"
- "Why didn't you message me?"
- "Why did you reschedule this?"
- "What did you decide during the 3-hour wake?"

## Suggested Tests

- Tool calls that propose outbound messages create decision entries.
- Scheduled task completion/failure creates decision entries.
- Cross-app approval requests include approval id/action/rationale.
- Decision ledger writes are user-scoped, idempotent enough for retries, and
  RAG-indexed.

## Docs

Update:

- `docs/architecture/30-domain-model.md`
- `docs/architecture/50-agent-runtime.md`
- `docs/architecture/80-observability-and-safety.md`
- `docs/architecture/90-testing-and-quality.md`
- `docs/development.md`

## Commit

Commit message:

```text
Add assistant decision ledger
```

