# Phase 01: Self Review And Preference Memory

## Goal

Give the assistant a scheduled self-review loop that inspects recent activity,
records a compact operational note, and maintains durable owner communication
preferences in markdown memory.

This phase turns the existing `get_recent_bot_activity` MCP tool into an actual
behavior: the assistant periodically asks, "Have I been contacting the owner too
much, too little, or about the wrong things?"

## Sub-Agent Prompt

Implement Phase 01 from `docs/plans/01-self-review-preference-memory.md`.
Read `docs/plans/README.md`, `project-description.md`,
`docs/architecture/50-agent-runtime.md`,
`docs/architecture/60-connectors-and-side-effects.md`, and
`docs/architecture/80-observability-and-safety.md`.

Add a scheduled self-review task and communication preference memory behavior.
Update tests and architecture docs. Commit with message:
`Implement assistant self review memory`.

## Desired Behavior

The worker should ensure a recurring self-review task exists for each active
user. The task should run periodically, likely once or twice per day at first,
and should:

- call or prompt the agent to use `get_recent_bot_activity`;
- inspect pending approvals, failed outbound, failed runs, recent owner replies,
  and recent outbound attempts;
- read communication preferences from long-term memory;
- write a short self-review note into markdown memory;
- optionally update communication preference memory only when the owner has
  directly stated a durable preference or recent evidence is strong enough to
  record as a tentative observation;
- avoid contacting the owner solely because the review ran.

Recommended memory paths:

- `/assistant/self-review/YYYY-MM-DD.md`
- `/assistant/preferences/communication.md`
- `/assistant/preferences/newsletters.md`

The self-review note should be operational and compact. It should help future
agent runs know whether it is being noisy, quiet, blocked by approvals, or
failing to deliver outbound messages.

## Implementation Notes

Use existing scheduled task patterns in:

- `api/src/scheduler/autonomousTasks.ts`
- `api/src/scheduler/taskQueue.ts`
- `api/src/agent/runAgentTask.ts`
- `api/src/tools/toolExecutor.ts`

Prefer adding a clearly named recurring task kind such as
`assistant_self_review`. Keep it separate from the three-hour autonomous wake so
operators can reason about it.

The self-review prompt should explicitly say:

- this is an internal operational review;
- do not message the owner unless a separate task or owner instruction makes it
  necessary;
- write findings to memory through MCP;
- preserve uncertainty;
- summarize loops, failures, and approval backlog.

If new MCP tools are needed, keep them read-only or memory-write scoped. Avoid
adding a special direct database write path when `write_memory` or markdown MCP
tools already suffice.

## Acceptance Criteria

- A self-review recurring task is created deterministically for active users.
- A self-review run can write a dated markdown note under `/assistant/`.
- The communication preference memory path exists or is created with a sensible
  heading when first needed.
- Self-review does not queue owner messages by default.
- Self-review failures are visible in task events/audit and do not prevent the
  next review from being scheduled.
- Architecture docs describe the self-review loop and preference memory paths.

## Tests

Add focused tests for:

- recurring self-review task creation;
- self-review prompt includes `get_recent_bot_activity` intent and
  communication preference memory guidance;
- successful self-review writes memory and records task/run events;
- failed self-review still schedules the next review;
- self-review does not create outbound messages unless explicitly prompted by a
  separate owner-approved action.

Run:

```bash
cd api && npm test -- worker.test.ts agentRuntime.test.ts markdownMemory.test.ts
./scripts/validate.sh
```
