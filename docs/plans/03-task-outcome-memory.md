# Phase 03: Task Outcome Memory

## Goal

Teach the assistant from completed work by writing compact task outcome summaries
to long-term markdown memory.

The agent should remember what happened, why schedules changed, what worked,
what failed, and what the owner corrected. This should improve future task
planning without dumping full task/event logs into prompts.

## Sub-Agent Prompt

Implement Phase 03 from `docs/plans/03-task-outcome-memory.md`.
Read `docs/plans/README.md`, `docs/architecture/30-domain-model.md`,
`docs/architecture/50-agent-runtime.md`, and
`docs/architecture/60-connectors-and-side-effects.md`.

Add task outcome memory behavior, tests, and docs. Commit with message:
`Record task outcomes in memory`.

## Desired Behavior

When meaningful task lifecycle events happen, the assistant should be able to
write a compact outcome note to markdown memory.

Trigger candidates:

- task completed;
- task failed;
- task cancelled after meaningful work;
- task split into follow-ups;
- task rescheduled with durable rationale;
- task blocked/waiting with durable reason;
- owner correction changes how a task should be approached in the future.

Recommended memory paths:

- `/tasks/outcomes/YYYY-MM.md`
- `/assistant/lessons/tasks.md`
- `/assistant/preferences/work-style.md`

Each outcome should include:

- task id and title;
- final status;
- relevant dates;
- source memory/message/task links when available;
- what the agent did;
- what the owner corrected or preferred;
- whether the lesson is durable or one-off;
- a short future-use note.

## Implementation Notes

Start with deterministic host-created outcome notes for task completion/failure,
then optionally let the model refine wording through the normal memory write
tool. Avoid requiring a model call for every trivial task state update.

Good first slice:

- add a helper that builds an outcome markdown entry from task and recent task
  events;
- call it when scheduled tasks finish and when explicit task status updates move
  to terminal states;
- append to monthly outcome memory;
- enqueue RAG indexing through existing markdown store behavior.

Use existing task event and markdown APIs. Do not add a parallel memory system.

## Acceptance Criteria

- Terminal task outcomes append compact markdown memory.
- The outcome memory entry is user-scoped and includes task id/title/status.
- Repeated status updates do not duplicate the same outcome entry.
- Outcome writes are audited and indexed through existing markdown/RAG behavior.
- Architecture docs describe task outcome memory and where it lives.

## Tests

Add tests for:

- task completion writes exactly one outcome entry;
- task failure writes failure reason;
- duplicate completion does not duplicate memory;
- split/follow-up events preserve source task links;
- markdown path is user-scoped;
- outcome memory appears in relevant prompt/context paths if applicable.

Run:

```bash
cd api && npm test -- worker.test.ts agentRuntime.test.ts markdownMemory.test.ts domain.test.ts
./scripts/validate.sh
```
