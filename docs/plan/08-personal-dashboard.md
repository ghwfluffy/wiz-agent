# Phase 08: Personal Dashboard Insights

## Goal

Make the web UI feel like the assistant command center. The owner should be
able to inspect what the agent thinks matters, recent decisions, memory changes,
active threads, tasks, approvals, and communication cadence from one place.

## Implementation Scope

- Extend existing API surfaces or add a focused dashboard endpoint that returns:
  - active tasks and schedule rationale;
  - pending approvals;
  - recent decisions;
  - recent memory changes;
  - recent owner feedback;
  - active conversation threads;
  - recent outbound/contact cadence;
  - personal list summaries;
  - guardrail trips and failed runs.
- Update the web home/admin experience with a dense operational dashboard.
- Preserve existing tabs and workflows unless a small consolidation is clearly
  safer.
- Include a prompt box path to talk to the agent directly from the browser if
  not already obvious.
- Keep UI restrained and work-focused. Avoid marketing/landing-page treatment.

## Expected Behavior

The owner can quickly answer:

- "What is the agent doing?"
- "What did it learn or remember recently?"
- "Why did it decide something?"
- "What needs my approval?"
- "Has it been contacting me too much?"
- "What open threads/tasks need attention?"

## Suggested Tests

- API dashboard response is user-scoped.
- Web tests render the main insight sections with representative data.
- Empty states are useful and compact.
- Failed/guardrail/approval states are visible.
- No secrets, connector passwords, MCP tokens, or raw credentials are exposed.

## Docs

Update:

- `docs/architecture/80-observability-and-safety.md`
- `docs/architecture/90-testing-and-quality.md`
- `docs/development.md`

## Commit

Commit message:

```text
Add personal assistant dashboard
```

