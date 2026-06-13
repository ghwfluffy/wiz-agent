# Phase 01: Memory Quality Review Loop

## Goal

Add a scheduled memory-curator loop that helps memory improve over time instead
of merely accumulating. The assistant should periodically inspect recent memory
writes, personal lists, task outcome memory, newsletter interest notes, and
self-review notes, then record compact quality findings.

## Implementation Scope

- Add a recurring scheduled task, likely in `api/src/scheduler/autonomousTasks.ts`.
- Add prompt guidance for a memory quality review wake.
- Add host-provided context for:
  - recent markdown writes under `/personal/`, `/assistant/`, `/tasks/outcomes/`,
    `/newsletters/`, and `/assistant/newsletter-interest/`;
  - personal list summaries under `/personal/lists/*.md`;
  - recent task outcome memory;
  - recent self-review memory.
- Add a deterministic destination for review notes:
  - `/assistant/memory-review/YYYY-MM.md`.
- Prefer additive notes and cleanup proposals. Do not silently delete memory.
- Use existing memory/list tools for cleanup when a concrete safe mutation is
  appropriate, and otherwise write findings with rationale.

## Expected Behavior

The memory-review task should identify:

- duplicate or near-duplicate list entries;
- stale assumptions;
- contradictions between preference files;
- noisy low-value memory;
- memory that should be promoted into preferences;
- memory that needs owner confirmation before cleanup.

It should write compact bullets with evidence and uncertainty. It should not
message the owner solely because the review ran.

## Suggested Tests

- Worker keeps the memory-review recurring task scheduled.
- Scheduled prompt includes recent memory/list/task outcome context and
  instructions not to delete silently.
- A mock model can write `/assistant/memory-review/YYYY-MM.md` through the
  controlled tool path.
- Failed memory-review runs still schedule the next review.

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
Add memory quality review loop
```

