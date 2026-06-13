# Phase 05: Memory Write Preview And Diff UI

## Goal

Make memory mutations inspectable in the web UI. The owner should be able to
see recent memory writes, where they came from, and how markdown changed.

## Implementation Scope

- Add API support for recent markdown revisions or memory write events if the
  store already records enough data. Prefer existing audit/revision data before
  adding new tables.
- Expose:
  - recent memory writes;
  - path;
  - source/audit action;
  - actor type;
  - created/updated time;
  - before/after versions or a bounded line diff;
  - linked task/run/tool/message ids where available.
- Add a web UI surface for:
  - recent memory changes feed;
  - path/source filters;
  - before/after or unified diff view;
  - quick links to read the markdown file;
  - personal list changes.
- Do not add destructive revert controls unless they are host-validated and
  tested. A read-only diff view is acceptable for this phase.

## Expected Behavior

The owner can answer:

- "What did the agent just remember?"
- "Which newsletter/source wrote this?"
- "Did that list update go where I expected?"
- "What changed in preferences?"

## Suggested Tests

- API returns recent memory writes scoped to current user.
- Admin/global variants respect existing admin rules if added.
- Web tests render memory change rows and diff detail.
- Redaction tests confirm secrets/MCP tokens are not exposed.

## Docs

Update:

- `docs/architecture/30-domain-model.md`
- `docs/architecture/80-observability-and-safety.md`
- `docs/architecture/90-testing-and-quality.md`
- `docs/development.md`

## Commit

Commit message:

```text
Add memory diff insights
```

