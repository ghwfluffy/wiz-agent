# Phase 07: Web Operator Console

## Goal

Turn the web frontend into the primary operator console for the assistant. The
owner should be able to inspect everything, browse memory, understand agent
behavior, and talk directly to the agent without sending SMS/email.

## Current Starting Point

- Vue/Carbon dashboard has tabs for overview, inbox, outbox, tasks, memory,
  senders, workers, logs, settings, and admin.
- Memory view previews simple documents.
- Sender trust management exists.

## UX Principles

- This is an operational tool, not a marketing page.
- Prioritize dense, scannable, explainable data.
- Make every agent action traceable: source -> run -> tool -> result.
- Avoid decorative UI that gets in the way.
- Use Carbon patterns and existing tab/dashboard conventions.

## Direct Agent Prompt Box

Add a persistent prompt surface:

- available from Overview and a dedicated Chat/Agent tab.
- textarea for prompt.
- optional context selectors:
  - task
  - memory path
  - recent message
  - mode
- submit to `POST /api/v1/agent/prompts`.
- show run status and final action result.
- link to created/updated task, memory doc, outbox message, or audit event.

Modes:

- normal: agent decides.
- planning: prefer no side effects except memory/task proposals.
- quick reply: focus on response drafting.

## Memory Browser

Replace or extend current Memory tab:

- tree view of markdown paths.
- file list with index status.
- markdown preview.
- heading outline.
- exact search.
- semantic search when RAG is ready.
- raw/source toggle for newsletter docs.
- edit mode for owner-authored assistant instructions.
- history/audit panel for memory writes.

Memory tree should include:

- personal
- preferences
- assistant
- tasks
- projects
- newsletters
- legacy

## Activity And Insight Views

Add drill-down views:

- Agent runs:
  - prompt version
  - model tier/model id
  - status
  - tool proposal
  - validation/repair result
  - linked source message/task/memory
- Tool calls:
  - tool name
  - arguments summary
  - result summary
  - side effect class
- RAG/index status:
  - pending jobs
  - failed jobs
  - per-user collection health
- Worker status:
  - outbound queue
  - IMAP poll health
  - next autonomous wake
  - next newsletter synthesis

## Agent Inbox Clarification

Label the Inbox as assistant mailbox/inbound agent messages. Avoid language
that implies it is the owner's personal inbox.

Suggested UI copy:

- tab: `Agent Inbox`
- empty state: `No messages received by the assistant mailbox.`
- settings help: `Configure the mailbox the assistant reads. This should be a
  dedicated assistant mailbox, not your personal inbox.`

## Approval Inbox

When phase 08 exists, add:

- pending approvals
- risk level
- source run/message
- approve/reject/edit
- "ask me later" option

## Frontend Architecture Work

Consider splitting `HomeView.vue` as it grows:

- `AgentPromptPanel.vue`
- `MemoryBrowser.vue`
- `MemoryTree.vue`
- `AgentRunsTable.vue`
- `TaskInsightPanel.vue`
- `ApprovalInbox.vue`
- `WorkerStatusPanel.vue`

Keep existing API client types current.

## Tests

Frontend:

- prompt box submits and renders result.
- memory tree navigation.
- memory search results.
- selected file preview.
- agent run/tool details.
- inbox labels use assistant mailbox language.
- task insight panel displays rationale.
- approval actions when implemented.

Backend:

- web prompt endpoint authorization.
- prompt endpoint cannot be used anonymously.
- prompt endpoint records run/audit.

## Completion Criteria

- Owner can talk to the agent from web UI.
- Owner can browse and search memory.
- Agent actions are inspectable end to end.
- Inbox copy reflects dedicated assistant mailbox.
- `./scripts/validate.sh` passes.
