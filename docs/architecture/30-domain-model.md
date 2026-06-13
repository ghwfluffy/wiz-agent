# Domain Model

The durable model is user-owned. A signed-in user owns their personal agent
configuration, schedules, messages, memory, audit history, outbox, and app
integration activity. `users.id` is the isolation boundary for user-owned data.

## Core Entities

- User: local representation of a signed-in person.
- Session: server-side session tied to one user.
- Connector: configured external integration such as IMAP or SMTP.
- Conversation: grouped messages and agent interactions.
- Conversation thread: lightweight owner-scoped continuity record that groups
  related owner/assistant exchanges across messages, tasks, and memory paths.
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

## Approvals

Approvals are user-owned source records for high-risk or owner-interrupting
effects. Each approval stores the source agent run id when available, a source
reference, action type, proposed payload, risk level, summary, expiration time,
status, decision user, and decision timestamp. The proposed payload is metadata
for host-owned execution; it must not contain connector credentials, deployment
hostnames, raw secret references, or model-selected recipients.

The first active approval actions are outbound owner messages and cross-app
write proposals. Outbound approvals link to an outbox record with
`requires_approval`; approving the approval changes the outbox record to
`approved`, and rejecting or expiring it cancels the outbox record.

Cross-app write approvals store host-owned execution state on the approval:
`execution_status`, `execution_result_json`, `execution_error`, and
`executed_at`. Approving a `cross_app_write_action` moves execution from
`not_applicable` to `pending`. The worker atomically claims pending approved
executions by moving them to `running`, rehydrates `action_id`, `path_params`,
`query`, and `body` from `action_json`, revalidates the registered capability as
a write action, and then records either `succeeded` with a redacted result or
`failed` with a visible error. Duplicate worker ticks cannot execute the same
approval because only `pending` executions can be claimed.

## Task Events

`task_events` is the user-visible timeline for a task. It records task creation,
status changes, worker claims, agent prompt/response summaries, agent run
completion/failure, tool-call outcomes, and user follow-up prompts. The API
returns only events for tasks owned by the signed-in user.

Tasks also carry host-owned schedule context in `schedule_context_json`. That
JSON stores durable rationale, source memory/message/task references,
recurrence policy, last and next agent review times, waiting-on state, blocked
reason, and whether owner clarification is needed. These fields are exposed on
task records for operator inspection, but model writes must go through
validated MCP tools that require rationale for schedule and status changes.

Adding a follow-up prompt appends the new instruction to the task prompt, returns
the task to `pending`, and records a `task.prompt_added` event so the user can
see why the task re-entered the queue.

`task.schedule_updated`, `task.status_updated`, `task.waiting_on`,
`task.split`, `task.followup_created`, and
`task.schedule_rationale_recorded` events preserve the visible history behind
agent-managed schedules. Long-lived rationale may also be written under
`/tasks/schedule-rationale.md` when it is useful beyond a single task event.

When a task reaches a terminal status (`completed`, `failed`, or `cancelled`),
host code writes a compact outcome note to monthly markdown memory at
`/tasks/outcomes/YYYY-MM.md`. The note includes the task id, title, final
status, relevant dates, source memory/message/task references, recent task-event
summaries, failure reason when present, owner correction/preference fields when
recorded, durability, and a short future-use note. Each entry carries a
deterministic hidden marker for the task id and terminal status so repeated
terminal updates do not duplicate the same outcome. Outcome files are ordinary
user-scoped markdown documents, so writes are audited, parsed into sections, and
queued for RAG indexing through the existing markdown store behavior.

The scheduled memory quality review is also represented as ordinary
user-scoped task and markdown state. The worker maintains a recurring
`Memory quality review` task for each active user. Review findings are written
through the controlled agent tool path to monthly markdown notes at
`/assistant/memory-review/YYYY-MM.md`. These notes are additive curation
findings and cleanup proposals with evidence and uncertainty; the review task
must not silently delete source memory. Concrete list cleanup can use the
personal memory list tools only when host validation and clear evidence make
the mutation safe.

Owner corrections are durable training signals. The `record_owner_feedback`
tool appends structured entries under `/assistant/feedback/YYYY-MM.md` with
feedback type, owner correction text, original behavior/context summary,
affected memory/task/tool/message/app references when available, durability,
follow-up target, and rationale. Feedback files are ordinary user-scoped
markdown documents, so writes are audited, parsed into sections, and queued for
RAG indexing. A feedback entry does not itself rewrite communication
preferences, newsletter preferences, list memory, task policy, or capability
guidance; those mutations must happen through a separate controlled tool with
rationale.

Assistant decisions are durable host-written source notes. Meaningful
autonomous/tool paths append compact entries under
`/assistant/decisions/YYYY-MM.md` with a deterministic hidden
`assistant-decision` marker, timestamp, trigger/source, action chosen,
alternative/deferred action when known, context summary, rationale, linked
run/task/tool/message/outbox/approval/action ids, and owner-visible side effect
status. The ledger is generated from existing task, run, tool-call, message,
approval, and markdown records; it must not make a second model call just to
explain a decision. Decision files are ordinary user-scoped markdown documents,
so writes are audited, parsed into sections, and queued for RAG indexing through
the existing markdown store behavior.

Inbound owner messages that the agent associates with a task also record
`message.inbound.assigned` on that task. The inbox record stores the task id,
task event id, agent run id, outbound review id where applicable, and handling
action in `messages.auth_json` so the web UI can link from a message to the
task timeline without adding deployment-specific columns.

## Conversation Threads

Conversation threads are user-owned records in `conversation_threads`. They are
lighter than the older generic `conversations` table and exist specifically to
help owner follow-ups refer to prior work. Each thread stores a title, status
(`active`, `waiting`, `resolved`, or `archived`), the latest owner intent
summary, an unresolved question when applicable, linked task ids, linked message
ids, linked markdown memory paths, and created/updated timestamps.

Owner inbound handling creates a thread for new owner topics and may attach
short follow-ups such as "any update on that from yesterday?" to a recent active
or waiting thread before the model call. The current thread id is also written
into `messages.auth_json` as `conversation_thread_id` when the message is routed
to the agent. Existing unthreaded messages remain valid because this metadata is
optional.

Model-facing thread mutations go through controlled tools. The host resolves
user scope from the MCP session and validates linked tasks, messages, and
markdown paths before adding them to a thread. A missing or foreign linked
record is rejected rather than silently creating a cross-user reference.

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
Accepted newsletters create markdown knowledge records under
`/newsletters/YYYY-MM-DD/*.md`; they enqueue normal RAG indexing but do not
create immediate owner notifications. A separate scheduled newsletter interest
check may later decide to propose an approval-gated conversational owner message
or stay quiet and record rationale.

Sender trust rows are explicit user-owned classifications for known addresses.
They can be created, updated, listed, and deleted through the API and operations
UI. Deleting a sender row does not delete any historical message or audit data;
it only removes the explicit classification so future inbound messages from that
address are classified by the default policy again.

## Memory And Knowledge Documents

Long-term memory is moving from slug-only `memory_documents` into a server-owned
virtual markdown filesystem backed by Postgres rows. The source file rows live
in `markdown_documents`; parsed heading ranges live in `markdown_sections`; and
writes enqueue `rag_index_jobs` so derived vector state can be reconciled later.
No actual filesystem files are created.

Markdown paths are user-owned and scoped by `users.id`, for example
`/personal/profile.md`, `/preferences/newsletters.md`,
`/assistant/schedule.md`, `/assistant/notification-policy.md`,
`/tasks/schedule-rationale.md`, `/projects/<project>/decisions.md`, and
`/newsletters/YYYY-MM-DD/source.md`. Directory listing and tree APIs are virtual
views over those path strings. Deleted markdown rows are omitted from directory
and tree reads.

Personal offload lists are ordinary markdown documents with deterministic list
semantics. Canonical collection files live under `/personal/lists/`, including
`/personal/lists/movies.md`, `/personal/lists/project-ideas.md`,
`/personal/lists/books.md`, `/personal/lists/restaurants.md`, and
`/personal/lists/research.md`; arbitrary owner list names are normalized to a
slug in the same directory. Each list starts with a stable H1 plus a
`memory-list:v1` marker, and entries use checkbox markdown with a hidden
`memory-list-item` id plus simple metadata lines such as `added`, `source`,
`notes`, `archived`, and `archive_reason`. The format is intentionally human
editable while still parseable by deterministic host tools.

The model should use personal memory list tools, not free-form memory writes,
when the owner wants to save movies, books, project ideas, gift ideas,
restaurants, research topics, places, things to buy, or similar lightweight
collections for later recall. List tools resolve user scope from the MCP
session, reject paths outside `/personal/lists/`, audit mutations, enqueue the
normal markdown/RAG indexing path through `writeMarkdownDocument`, and archive
items by default instead of deleting history.

Markdown writes parse headings levels 1 through 6 into stable section IDs based
on heading path, such as `goals/mvp`; pre-heading content is `_preamble`.
Full-file and section writes use optimistic concurrency. A stale
`expectedVersion` returns a structured conflict instead of overwriting newer
state.

The legacy memory API remains available while the web UI is migrated. Legacy
memory writes dual-write to markdown paths, and the Phase 01 migration backfills
existing rows:

- `personal-profile` -> `/personal/profile.md`
- `newsletter-preferences` -> `/preferences/newsletters.md`
- `agent-schedule` -> `/assistant/schedule.md`
- `newsletters-YYYY-MM-DD-*` -> `/newsletters/YYYY-MM-DD/*.md`
- other slugs -> `/legacy/<slug>.md`

Owner messages can update durable memory only through controlled host-owned
workflows or MCP/tool calls. Trusted newsletter content is knowledge input, not
command input.
