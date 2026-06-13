# Domain Model

The durable model is user-owned. A signed-in user owns their personal agent
configuration, schedules, messages, memory, audit history, outbox, and app
integration activity. `users.id` is the isolation boundary for user-owned data.

## Core Entities

- User: local representation of a signed-in person.
- Session: server-side session tied to one user.
- Connector: configured external integration such as IMAP or SMTP.
- Conversation: grouped messages and agent interactions.
- Message: inbound, outbound, or internal communication.
- Task: scheduled or on-demand work item for the agent or worker.
- Task event: append-only task state transition history.
- Approval: user/admin decision required before a high-risk side effect.
- Memory document: user-visible long-term memory.
- Memory revision: proposed or accepted memory change.
- Outbound message: queued email, SMS, or MMS side effect.
- Link/article snapshot: fetched content under safe-fetch policy.
- Agent run: one bounded model invocation or task execution.
- Tool call: model-proposed action and deterministic host outcome.
- Audit log: durable record of meaningful writes and privileged actions.
- AI backend config: admin-managed model tiers and budgets.

## Initial Schema

The first migration creates all core Phase 3 tables so later features can add
behavior without revisiting ownership boundaries. Only a subset is actively used
by the current API:

- standalone user/session creation;
- inbound message recording/listing;
- task CRUD, task event listing, and follow-up prompts;
- memory document listing/detail and explicit preference writes;
- audit listing;
- admin AI config.

Unused tables are intentionally present for connectors, memory, messages,
outbound side effects, agent runs, tool calls, and article snapshots.

## Ownership Rule

User-owned tables must include `user_id`, and services should accept explicit
user context rather than deriving scope deep in database helpers. Normal API
queries must filter by the current `user_id` for reads and writes.

Admin-only global data, such as `admin_ai_config`, is not user-owned, but every
privileged write must still carry audit context such as `updated_by`, `user_id`
where applicable, request id, and actor type.

Admin audit queries may intentionally inspect all users' audit records. Normal
users may only inspect records tied to their own `user_id`.

Future shared workspaces, organizations, or household accounts would require a
new explicit design. Do not reintroduce generic tenant fields ad hoc.

## Source And Derived State

Source records such as messages, tasks, approvals, memory revisions, tool calls,
and audit logs should be preserved. Summaries, dashboards, and cached activity
views should be rebuildable from source records where practical.

## Task Events

`task_events` is the user-visible timeline for a task. It records task creation,
status changes, worker claims, agent prompt/response summaries, agent run
completion/failure, tool-call outcomes, and user follow-up prompts. The API
returns only events for tasks owned by the signed-in user.

Adding a follow-up prompt appends the new instruction to the task prompt, returns
the task to `pending`, and records a `task.prompt_added` event so the user can
see why the task re-entered the queue.

Inbound owner messages that the agent associates with a task also record
`message.inbound.assigned` on that task. The inbox record stores the task id,
task event id, agent run id, outbound review id where applicable, and handling
action in `messages.auth_json` so the web UI can link from a message to the
task timeline without adding deployment-specific columns.

## Inbox Messages

Inbound email/SMS/MMS records are source records in `messages` with
`direction = 'inbound'`. They are listed chronologically through
`GET /api/v1/messages` for the signed-in user. Sender classification is stored
in `auth_status`; derived handling state such as `routed_to_agent`,
`queued_owner_review`, `accepted_newsletter`, `accepted_trusted`,
`sender_reviewed`, `blocked`, and `rate_limited` is stored in `auth_json`.

Inbox entries are not command history by themselves. Only messages classified as
`owner` may be handed to the owner-command agent path. Newsletter and trusted
third-party messages may be integrated into knowledge. Untrusted and blocked
messages remain durable data for review/audit and must not trigger model tool
calls.

Newsletter sender review is represented as source inbox records plus derived
handling state. Unknown newsletter-like senders start as `untrusted` and queue
owner review. Owner replies can mark the sender as `newsletter` or `blocked`.
Accepted newsletters create path-like markdown knowledge records under
`newsletters/YYYY-MM-DD/*.md`; they do not create immediate digest tasks.

Sender trust rows are explicit user-owned classifications for known addresses.
They can be created, updated, listed, and deleted through the API and operations
UI. Deleting a sender row does not delete any historical message or audit data;
it only removes the explicit classification so future inbound messages from that
address are classified by the default policy again.

## Memory Documents

Memory documents are user-owned markdown-like records in `memory_documents`.
They are readable from the operations UI and API. Writes should remain explicit
host-owned workflows or controlled model/MCP tool calls with audit records.
Owner messages can update durable memory when the agent chooses the memory write
tool. Trusted newsletter content is stored as knowledge input under path-like
memory titles such as `newsletters/2026-06-13/forbes.md`. The
`newsletter-preferences` document stores owner-stated newsletter interests and
style preferences that are injected into later scheduled newsletter synthesis
tasks.
