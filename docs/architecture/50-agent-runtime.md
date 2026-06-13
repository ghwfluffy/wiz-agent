# Agent Runtime

The agent runtime is intentionally bounded. Models can interpret language and
propose actions, but deterministic host code owns state and side effects.

## Model Tiers

Model names are configuration, not business logic. The app uses these logical
tiers:

- `fast`: default simple tasks.
- `smart`: stronger reasoning or synthesis.
- `orchestrator`: short planning runs for complex work.
- `repair`: JSON/tool argument repair.

Admin configuration will eventually choose concrete OpenAI model IDs for each
tier.

The current configuration sources are:

- environment variables for deploy-time defaults;
- `admin_ai_config` for admin-managed runtime defaults.

Administrators can inspect and update `admin_ai_config` from the operations UI.
The API keeps the admin route separate from normal user routes, so non-admin
sessions cannot change model tier defaults.

The deterministic host chooses the tier before the model call. The first policy
uses `fast` by default, `smart` for ambiguous/large/retry-prone work,
`orchestrator` for bounded planning, and `repair` only for schema repair.

## Model Client Boundary

Application code depends on `AgentModelClient`, not direct SDK calls.

Implemented clients:

- `MockModelClient`: deterministic tests and local runtime development.
- `OpenAIModelClient`: OpenAI Responses API adapter for structured output,
  function/tool-call proposals, and repair calls.

This keeps real network calls out of tests and keeps OpenAI API details behind a
small adapter.

OpenAI API credentials are secret config. Use `AGENT_OPENAI_API_KEY` in ignored
secret env files or `AGENT_OPENAI_API_KEY_FILE` to read a mounted ignored secret
file. `AGENT_OPENAI_BASE_URL` is non-secret configuration and defaults to
`https://api.openai.com/v1`.

## Tool Contracts And MCP Runtime

Tool contracts are Zod schemas in a shared tool registry. The registry produces
model-facing descriptors, MCP descriptors, validation schemas, risk metadata,
side-effect classifications, and host execution handlers.

Model outputs are validated before tool execution. Invalid tool arguments may go
through a bounded repair call that gets the malformed payload, expected contract
shape, and validation errors. The MCP boundary validates the same schemas again
after resolving the authenticated session so production execution does not
depend on model-side or runtime-side validation alone.

Current tool contracts:

- `create_task`
- `list_ongoing_tasks`
- `list_recent_context`
- `list_recent_owner_conversations`
- `list_conversation_threads`
- `update_conversation_thread`
- `link_conversation_thread`
- `get_recent_bot_activity`
- `list_app_capabilities`
- `list_goals`
- `create_goal`
- `update_goal`
- `complete_goal_checklist_item`
- `list_goal_metrics`
- `record_goal_metric_entry`
- `list_goal_notifications`
- `complete_goal_notification`
- `list_budget_accounts`
- `get_budget_account`
- `record_budget_account_value`
- `get_net_worth_history`
- `get_net_worth_forecast`
- `list_budget_transfers`
- `list_budget_contracts`
- `create_budget_contract`
- `update_budget_contract`
- `delete_budget_contract`
- `list_budget_expenses`
- `create_budget_expense`
- `update_budget_expense`
- `delete_budget_expense`
- `list_budget_investments`
- `list_budget_audit_logs`
- `write_memory`
- `write_file`
- `record_owner_feedback`
- `add_memory_list_item`
- `list_memory_items`
- `search_memory_lists`
- `update_memory_list_item`
- `remove_memory_list_item`
- `append_task_prompt`
- `update_task_schedule`
- `update_task_status`
- `split_task`
- `create_followup_task`
- `mark_waiting_on`
- `request_clarification`
- `record_schedule_rationale`
- `propose_outbound_message`
- `ask_owner_clarification`
- `record_observation`
- `integration_action`

Cross-app API access is intentionally outside direct model control. The model
may request an integration action, but deterministic host code must enforce
sender trust, user scope, allowed app/action, and token availability before any
API call.

The runtime includes the app capability registry in the model prompt so the
model knows what Goals, Fluffynomics, and Apartment Gate are for and which
actions are available.

Owner inbound prompts include a deterministic host-detected intent envelope for
the current owner message. The envelope has one conservative label, numeric
confidence, short non-secret evidence strings, and guidance such as "host
detected likely memory/list offload; verify before using list tools." It is
computed by host code with simple heuristics, audited on the inbound message
when the message reaches the agent, and passed as context only. It never creates
tasks, writes memory, approves messages, updates sender trust, calls apps, or
selects tools by itself; the model still decides and all side effects continue
through validated MCP/tool contracts.
Accepted tool calls execute through the server-owned MCP boundary by default:

1. host code creates an agent run;
2. the MCP tool client creates a short-lived session for that user/run with an
   explicit allowlist of agent tool names;
3. the runtime sends the validated call to `POST /mcp/v1/tools/:tool/call`;
4. MCP resolves the bearer token server-side, rejects expired, mismatched-run,
   or disallowed-tool sessions, validates arguments, executes host-owned logic,
   and writes MCP audit events;
5. the runtime records the accepted or rejected tool-call result on the agent
   run.

The local in-process executor remains only as `LocalToolClient`, a
compatibility wrapper for deterministic tests and emergency fallback. It is not
the default runtime path.

Authenticated browser sessions can request MCP tokens for operator-console
memory browsing, but those sessions are restricted to read-only memory and
search tools. Decision tools such as `create_task`, `write_memory`,
`propose_outbound_message`, and `integration_action` are only minted through
run-bound agent sessions.

Current migrated agent tools:

- `create_task` creates a user-scoped task.
- `list_ongoing_tasks` returns active user-scoped tasks without side effects.
- `list_recent_context` returns bounded owner-scoped recent task/message context
  without side effects.
- `list_recent_owner_conversations` returns recent owner inbound/outbound
  conversation excerpts so the agent can resolve short follow-up messages.
- `list_conversation_threads` returns bounded user-scoped thread summaries for
  active, waiting, resolved, or archived conversation threads.
- `update_conversation_thread` refreshes a thread title, status, owner intent
  summary, or unresolved question under the authenticated user's scope.
- `link_conversation_thread` links a thread to existing user-owned tasks,
  inbound/outbound messages, and markdown memory paths. Host code verifies each
  referenced record before updating the thread and rejects missing or foreign
  ids.
- `get_recent_bot_activity` returns bounded operational activity insight,
  including owner-visible outbound counts, pending approvals, failures, recent
  outbound excerpts, and a host-computed contact-cadence assessment. The
  assessment helps the agent reason about whether it has been contacting the
  owner too much or too little, but it is context only; outbound contact still
  requires the normal owner-message approval path and task urgency judgment.
- `list_app_capabilities` returns the app capability registry through MCP so the
  agent can query available apps, safe action ids, and directory-only app
  boundaries at runtime.
- Goals wrappers expose common goal, metric, checklist, and notification
  workflows without requiring the model to build generic app API requests.
- Fluffynomics wrappers expose account lookup, forecasts, transfers, contracts,
  projected expenses, investments, audit logs, and account-value updates.
  Contract and expense write wrappers are intended for owner statements such as
  recurring bills or observed spending patterns, but they still queue approval
  before changing projection data.
- `write_memory` appends model-selected durable markdown memory under host-owned
  user scope.
- `write_file` writes a complete markdown file under host-owned user scope. It
  is intended for structured markdown memory paths such as scheduled
  self-review notes, while MCP session scoping, path normalization, audit
  events, and RAG indexing remain deterministic host responsibilities.
- `record_owner_feedback` appends structured owner corrections to
  `/assistant/feedback/YYYY-MM.md`. It captures correction text, original
  behavior/context, affected ids or paths, durability, follow-up target, and
  rationale. It is additive training/review evidence and must not automatically
  rewrite preference files or capability guidance.
- Personal memory list tools manage lightweight owner collections under
  `/personal/lists/*.md`. `add_memory_list_item` normalizes loose owner list
  names such as "movie night" to canonical list files, avoids duplicates with
  punctuation-insensitive matching, preserves notes/source context, and creates
  the markdown file when needed. `list_memory_items` and `search_memory_lists`
  expose bounded read/recall behavior; `update_memory_list_item` and
  `remove_memory_list_item` update or archive entries while preserving history
  through the model-facing tool path. Generic `write_memory` should not be used
  for simple list add/read/update/remove operations when these tools fit.
- `append_task_prompt` appends owner follow-up context to an existing task,
  returns it to active work, and writes a task event.
- `update_task_schedule` changes a user-scoped task due date, including null
  due dates, and records the model-provided rationale and confidence as a task
  event.
- `update_task_status` changes task lifecycle state and waiting/blocked
  context with required rationale.
- `split_task` creates bounded child tasks from an existing task and links the
  split rationale back to the source task timeline.
- `create_followup_task` creates a user-scoped follow-up task with source task
  and schedule rationale when applicable.
- `mark_waiting_on` moves a task into waiting state with a waiting-on value,
  optional next review time, and required rationale.
- `request_clarification` is the rationale-required schedule-intelligence
  variant of owner clarification. It queues immediate owner clarification
  through host-resolved destinations or creates a local clarification task for
  lower urgency.
- `record_schedule_rationale` stores durable schedule rationale and optional
  source/recurrence/review metadata on the task.
- `propose_outbound_message` queues an outbound message rather than sending it.
- `ask_owner_clarification` records that the agent needs more owner input. For
  `urgency = now`, it queues an owner message through host-resolved owner
  contact or verified inbound reply context. For lower urgency, it creates a
  local clarification task for later owner-facing handling.
- `record_observation` records the accepted observation in the tool-call result.

High-risk tools return a host-owned approval state instead of executing the
side effect. `propose_outbound_message` now creates an approval plus a linked
`requires_approval` outbox record. `integration_action` creates a
`cross_app_write_action` approval for write-style proposals and does not call
registered apps directly from the model tool path. Approval records preserve
the source run, source reference, proposed payload, risk level, summary,
expiration, execution status, redacted execution result or failure, and audit
trail.

Approved cross-app write approvals execute only from deterministic host code.
The worker revalidates the stored action id against the capability registry at
execution time, rejects read actions and directory-only apps, mints the scoped
integration token server-side, calls through the integration gateway, and stores
only redacted response data. The model never receives bearer tokens and cannot
execute a high-risk registered app write directly.

Reply tools receive any inbound owner-message context from host code, not from
model arguments, so the model still cannot select recipients. Owner SMS/email
commands such as `YES`, `NO`, `EDIT <text>`, `LATER`, and `DETAILS` are parsed
by host code against the most recent pending owner approval. `YES` approves
only that current approval, `NO` rejects it, and `EDIT` updates the proposed
outbound payload and audit trail.

## Repair Flow

Malformed tool arguments follow this flow:

1. validate against the Zod tool schema;
2. call the repair tier with only malformed arguments, contract shape, and
   validation errors;
3. validate the repaired output with the same schema;
4. accept only valid repaired output;
5. reject and audit the tool call after the repair budget is exhausted.

The repair payload must not include secrets or raw credential references.

## Runaway Guardrails

Runtime safety limits are host-owned loop protection, not model-tuning prompts.
The named defaults live in `api/src/security/safetyPolicy.ts`, with local-mode
environment overrides for operational caps such as runs per user per hour,
autonomous runs per worker tick, owner-visible outbound messages per day,
outbound sends per worker tick, untrusted sender-review notifications per day,
newsletter documents considered per interest check, and prompt/context excerpt
sizes. `admin_ai_config` still owns model ids, max tool calls per run, max
runtime seconds, and repair attempts; the safety policy reads those values into
the same budget surface.

When a guardrail trips, host code fails closed before creating the side effect,
records `guardrail.exceeded` with a non-secret reason, and returns a structured
`guardrail_exceeded` result where the caller has a run/tool context. The model
does not get to raise, lower, or bypass these caps.

## Traceability

Every agent run records:

- user;
- model tier and concrete model id;
- prompt version;
- status and failure reason.

Every proposed tool call records:

- user;
- run id;
- tool name;
- validated or rejected arguments;
- validation error when rejected.

Audit events are written for run creation, run completion/failure, and tool-call
acceptance/rejection.

Task events are also written for user-facing traceability when a task is tied to
the run. The task timeline should show when the agent was prompted, a bounded
summary of the model response, run completion or failure, and accepted or
rejected tool-call outcomes. These task events are for the owner-facing task
modal; audit logs remain the broader operational record.

Accepted meaningful tool calls also write deterministic decision-ledger entries
under `/assistant/decisions/YYYY-MM.md` after the host records the tool-call
row. The ledger covers owner-visible outbound proposals, owner clarification
requests, cross-app approval requests, task schedule/status changes, task
splits/follow-ups/waiting state, assistant self-review and memory-review note
writes, owner feedback capture, list mutations, new tasks, and explicit
observations/no-action choices. Entries link the run id, tool-call id, task or
task-event ids, markdown path, outbound message id, approval id, and registered
app action id when those records exist.

Scheduled worker outcomes write a separate decision entry after
`scheduled_task.outcome` or `scheduled_task.failed` is recorded. This lets the
owner ask why a newsletter check stayed quiet, why a three-hour wake acted or
observed, or why a self-review/memory-review task failed. These entries are
derived from persisted task, event, run, and tool state; the runtime does not
call the model again solely to create ledger prose.

Owner inbound SMS/MMS/email handling uses the same runtime boundary. After
sender policy classifies a message as `owner`, host code creates or reuses a
lightweight conversation thread, then builds an inbound prompt that includes
bounded active task, recent conversation, recent thread, and saved memory
context. The model then decides what to do: write memory, append to an existing
task, create/schedule a new task, update/link a conversation thread, queue a
reply, call a registered app integration, request recent owner conversation
context, ask for clarification, or record an observation. The inbox record is
updated with the agent run id, optional conversation thread id, and any linked
task/task-event ids so the UI can show what the message triggered.

Authenticated direct web prompts use the same owner-command decision loop via
`POST /api/v1/agent/prompts`. The request body includes `prompt`, optional
`contextTaskId`, and optional mode `normal`, `quick_reply`, or `planning`.
Because the request comes from an authenticated web session, it is owner input,
but the model still receives only bounded context and can act only through the
same validated tool/MCP path. If a context task is supplied, the agent run links
to that task and task events record the prompt/tool outcomes. The endpoint
returns the run id, selected action, tool status/result, and host-derived links
to created or updated task, outbox, memory, or clarification records. Controlled
agent failures, such as guardrail failures, still return this prompt result
envelope with `status: failed` so chat clients can display `failureMessage`
instead of treating the response as a transport failure. When the model answers
without selecting a tool, the endpoint returns the plain answer as `responseText`
so conversational UI can show the answer instead of a generic completion status.
When a selected read-only tool succeeds, the runtime performs a text-only
synthesis pass on the selected model tier over the owner prompt and tool result
and returns that interpreted answer as `responseText`; the raw tool result
remains available for audit/debug views but is not the primary chat reply.

The dedicated Chat tab sends prompts with `normal` mode and includes recent
browser chat turns inside the prompt body. The production-style Nginx API proxy
keeps reads open longer than the admin runtime budget so interactive chat can
wait for slow but valid owner-command runs instead of forcing the agent onto a
quick-reply path.

Owner messages must not be pre-written to long-term memory by regex or other
host heuristics. Durable owner facts, preferences, and schedule rationale should
be persisted through the same controlled tool/MCP path the model uses for other
decisions, with deterministic validation and audit records.

## Scheduled Self-Review

The worker maintains an `Assistant self-review` recurring task for each active
user it reconciles. The task is separate from the three-hour autonomous wake so
operators can distinguish general task review from operational self-inspection.
The default cadence is twice daily around 09:00 and 21:00 local/server time.

The self-review prompt is explicitly internal. It tells the agent to use
`get_recent_bot_activity`, inspect pending approvals, failed outbound delivery,
failed runs, owner replies, and recent outbound attempts, then write compact
findings to `/assistant/self-review/YYYY-MM-DD.md`. It also includes current
excerpts from durable preference files so the model can reason about whether it
has been noisy, quiet, blocked, or failing to deliver without contacting the
owner just because the review ran.

Preference memory paths seeded by host reconciliation:

- `/assistant/preferences/communication.md`
- `/assistant/preferences/newsletters.md`

The agent may update those files only when the owner directly stated a durable
preference or when evidence is strong enough to label as a tentative
observation. Self-review runs must not queue owner messages unless a separate
task or owner instruction independently justifies that contact through the
normal approval/outbox path.

## Scheduled Memory Quality Review

The worker maintains a `Memory quality review` recurring task for each active
user it reconciles. The default cadence is weekly around Sunday 10:00
local/server time. The task is separate from autonomous wake and self-review so
operators can distinguish task/schedule work, operational behavior review, and
long-term memory curation.

Before a memory-review run, host code assembles bounded user-scoped context
from recent markdown writes under `/personal/`, `/assistant/`,
`/tasks/outcomes/`, `/newsletters/`, and
`/assistant/newsletter-interest/`; personal list summaries under
`/personal/lists/*.md`; recent task outcome memory; recent self-review memory;
and the current monthly review note. The prompt asks the agent to identify
duplicate or near-duplicate list entries, stale assumptions, contradictions,
noisy low-value memory, promotion candidates for preference files, and cleanup
items that require owner confirmation.

Findings are written through the normal MCP-backed `write_file` tool to
`/assistant/memory-review/YYYY-MM.md`. If the monthly file already exists, the
prompt tells the agent to preserve prior content and add a dated section or
bullets. The review prefers additive findings and cleanup proposals; it must
not silently delete memory. Personal memory list tools may be used only for
concrete safe mutations such as archiving an exact duplicate with clear
evidence. A memory-review run is not itself a reason to contact the owner.

## MCP Memory Filesystem

The Phase 01 MCP boundary exposes long-term memory as a virtual markdown
filesystem. API or worker host code creates a short-lived `agent_mcp_sessions`
row for a specific user and optional agent run. The MCP service receives only
the opaque bearer token, resolves user/run scope server-side, and rejects
missing, expired, revoked, or mismatched-run sessions. Tool arguments must not
include user IDs, tenant IDs, collection names, connector credentials, or raw
recipient information.

Initial MCP memory/RAG tools are:

- `list_dir`, `tree`, `stat_path`
- `read_file`, `write_file`, `delete_path`, `move_path`
- `read_section`, `replace_section`, `append_to_section`
- `search_headings`, `grep`
- `get_index_status`, `reindex_path`

The MCP surface also exposes the migrated agent tools listed above. Every MCP
tool call records an audit event with the resolved user, tool name, optional run
id, path when supplied, side-effect classification, and outcome. Markdown writes
update source rows, parse sections, and enqueue RAG index jobs. RAG indexing
remains a deterministic host concern; the model never receives or supplies
Qdrant collection names.

## Host-Owned Controls

The host owns:

- user scope;
- credentials;
- persistence;
- task scheduling;
- tool permissions;
- approval checks;
- idempotency;
- retries and budgets;
- audit logging.

The model must not receive secrets or raw credential references.

Untrusted inbound messages and newsletters must be treated as data, not
instructions. Only owner-classified inbound messages can drive agent actions.
Trusted newsletter and trusted third-party messages may be ingested into
long-term knowledge, but they must not directly trigger replies, goal updates,
or cross-app actions.

The worker maintains recurring agent wake tasks. A newsletter interest check
reviews ingested newsletter knowledge, newsletter preferences, communication
preferences, recent owner response timing, pending approvals, and recent bot
activity evidence before deciding whether now is a good time to mention one or
two genuinely interesting discoveries. This is not a rigid digest; staying
quiet and recording the rationale is a successful outcome. A three-hour
autonomous wake task reviews memory, active tasks, and schedule rationale so the
agent can decide whether to act or adjust future work timing through controlled
tools. A weekly memory quality review inspects durable memory and writes
curation findings under `/assistant/memory-review/YYYY-MM.md`. Before each
recurring scheduled run, host code composes a fresh prompt
from active tasks, `/assistant/schedule.md`, `/tasks/schedule-rationale.md`,
`/assistant/notification-policy.md`, `/assistant/preferences/communication.md`,
`/assistant/preferences/newsletters.md`, the current monthly task outcome memory
under `/tasks/outcomes/YYYY-MM.md`, recent owner messages, recent bot activity
evidence, and recent newsletter knowledge. This gives the model current
schedule context without letting newsletter content become instructions or
loading full task logs into prompts. Newsletter timing rationale may also be
stored under `/assistant/newsletter-interest/YYYY-MM.md`; memory review
rationale is stored under `/assistant/memory-review/YYYY-MM.md`.
The next recurring wake is created in a `finally` path, so failed wake runs
still schedule the next roughly-three-hour review. Newsletter interest,
self-review, and memory-review tasks use the same failure-rescheduling pattern.

## Task Outcome Memory

Task outcome memory is host-created long-term markdown memory. Scheduled task
completion/failure paths and the `update_task_status` tool write compact
terminal summaries under `/tasks/outcomes/YYYY-MM.md` when a task reaches
`completed`, `failed`, or `cancelled`. Entries include the task id/title/status,
timestamps, source memory/message/task links, recent task event summaries,
failure reason when available, owner correction/preference details if a task
event recorded them, whether the lesson appears durable or one-off, and a short
future-use note.

The model is not called just to create these notes. The writer uses existing
task records/events and existing markdown APIs, so user scope, audit events,
markdown section parsing, and RAG indexing remain deterministic host behavior.
Each entry has a deterministic task/status marker to avoid duplicates when a
worker tick or status update is retried.
