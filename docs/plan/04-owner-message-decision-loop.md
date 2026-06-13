# Phase 04: Owner Message Decision Loop

## Goal

Make owner messages and direct web prompts enter the same agent decision loop.
The agent should decide whether to update memory, reply, modify a task, update a
goal, call another app, ask for clarification, or do nothing.

## Important Correction

The IMAP inbox belongs to the agent. It is not the owner's personal inbox. Owner
messages arrive because the owner intentionally sends email/SMS/MMS to the
assistant mailbox or because a configured owner channel is relayed there.

## Current Starting Point

- `processInboundMessage` gates sender trust.
- Owner messages call `runOwnerInboundAgent`.
- Phase 03 should migrate existing local tools behind MCP. If this phase starts
  before phase 03 is complete, use the same tool contracts but keep the owner
  decision loop isolated so it can swap from local execution to MCP execution.

## Target Flow

1. IMAP poller reads assistant mailbox.
2. Sender policy classifies the sender.
3. `untrusted` and `blocked` stop before model tool context.
4. `newsletter` and `trusted` ingest knowledge only.
5. `owner` creates an agent run with:
   - current message
   - bounded active tasks
   - recent owner conversation excerpts
   - relevant memory search handles
   - available MCP capabilities
6. Agent chooses at most one primary action for the first iteration.
7. Host validates and executes the tool/MCP call.
8. Inbox record links to run, task, outbound message, memory write, or
   observation where applicable.

## Direct Web Prompt Flow

Add a web prompt/chat endpoint that creates the same kind of owner-authorized
agent run:

- `POST /api/v1/agent/prompts`
- Auth required.
- Body:
  - `prompt`
  - optional `contextTaskId`
  - optional `mode`: `normal`, `quick_reply`, `planning`
- Response:
  - run id
  - selected action
  - tool result summary
  - outbound/message/task/memory links

The web prompt is owner-command input because it comes from an authenticated web
session. It still must use the same host-owned tool/MCP boundaries.

## Context Tools

Implement or migrate these to MCP:

- `list_recent_owner_conversations`
- `list_ongoing_tasks`
- `list_recent_context`
- `search_semantic`
- `read_file`
- `read_section`

Recent owner conversations should include:

- inbound owner messages to the assistant mailbox
- outbound assistant replies
- timestamps
- linked tasks/runs
- short excerpts

Do not include newsletter/untrusted message content as instructions. If included
for context, label it as data.

## Decision Tools

Migrate these to MCP or MCP-backed host execution:

- `write_memory`
- `create_task`
- `append_task_prompt`
- `update_task_schedule`
- `propose_outbound_message`
- `integration_action`
- `record_observation`
- `ask_owner_clarification`

Add `update_task_schedule`:

```ts
{
  taskId: string,
  dueAt: string | null,
  rationale: string,
  confidence: "low" | "medium" | "high"
}
```

Add `ask_owner_clarification`:

```ts
{
  question: string,
  relatedTaskId?: string,
  urgency: "now" | "daily_briefing" | "next_wake"
}
```

Initially this can create a task or queued outbound message depending on
urgency. Later phase 08 should route it through approval/notification policy.

## Prompt Design

Owner-message prompt should say:

- The sender is owner-classified by host policy.
- Decide what action is appropriate.
- Use memory tools for durable facts/preferences/schedule rationale.
- Use recent conversation lookup if the message is short or ambiguous.
- Use reply tool only when a response is useful.
- Do not invent missing details for high-impact changes.
- Prefer clarification over risky assumptions.

## State Recording

Add links from inbound messages or run records to:

- memory document path/slugs updated
- outbound message id
- task id/task event id
- integration action id
- clarification request id

If schema changes are too large, record these in existing tool-call result JSON
and task/audit events first.

## Tests

Backend tests:

- owner SMS can choose `write_memory`.
- owner SMS can use recent conversation lookup.
- web prompt can create the same actions as owner SMS.
- untrusted message cannot call decision tools.
- newsletter message cannot call owner-command tools.
- ambiguous owner message creates clarification request.
- schedule update records rationale.

Frontend tests:

- prompt box submits and renders run result.
- prompt errors are visible.
- linked task/memory/outbox result opens the right UI panel.

Docs:

- Update runtime docs with direct web prompt behavior.
- Update connector docs to clarify assistant mailbox ownership.

## Completion Criteria

- Owner SMS/email and web prompts share the decision loop.
- Agent has a recent-owner-conversation tool.
- Memory updates happen by model decision through host tools/MCP.
- Direct web prompt is available and tested.
- `./scripts/validate.sh` passes.
