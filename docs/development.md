# Development

Production images compile TypeScript in a Node.js 22 build stage and install
production dependencies only in the runtime stage. `npm run migrate` executes
the compiled migration runner; local source-mode migration work can use
`npm run migrate:dev`.

## Prerequisites

- Docker and Docker Compose.
- Node.js 20+ when running API or web checks outside containers.

## Local Mode

Early development uses standalone mode:

```bash
cp .env.example .env
docker compose up --build
```

The Vite web app runs at `http://localhost:18081` by default. The
production-style Nginx service runs at `http://localhost:18082`, the MCP service
runs at `http://localhost:18083`, Qdrant runs at `http://localhost:6333`, and
the API is available at `http://localhost:18080`. In standalone mode, the
sign-in button calls `POST /api/v1/auth/dev-login` and creates a session for the
configured development user.

The home screen is the operational dashboard. Its top-level IA is Chat,
Attention, Work, Knowledge, Integrations, Operations, and Settings. It supports
creating and updating tasks, talking directly to the agent through
`POST /api/v1/agent/prompts`, approving or cancelling outbound messages,
browsing markdown memory/knowledge, managing sender trust and connectors,
inspecting worker and index status, viewing agent run/tool-call/audit history,
and editing admin AI model configuration when the signed-in user is an
administrator. OAuth callback failures redirect back to the UI with an
`oauth_error` token; the web store converts that token into a friendly message
and removes it from the URL.

The authenticated workspace is conversation-first and route-backed. Chat is the
default focused surface. Top-level sections use `?tab=<section>`, while sections
with multiple tools add `&view=<surface>`. Only the selected surface is mounted;
switching to a tool does not leave unrelated tables, forms, or status panels in
the page below it. Legacy tab links such as `tab=overview`, `tab=inbox`,
`tab=approvals`, `tab=outbox`, and `tab=admin` continue to resolve to their
corresponding focused surfaces.

At mobile widths, desktop tab rows are replaced by a small collapsed control on
the left edge. It opens a modal off-canvas navigation drawer with expandable
second-level tool menus, traps keyboard focus while open, closes with Escape or
the backdrop, restores focus to the trigger, and locks background scrolling.
The mobile Chat surface removes the dashboard/card nesting, fills the viewport
below the shared banner, and keeps its compact composer at the bottom with safe
area spacing. Non-chat tools retain bounded horizontal scrolling for wide data
tables.

The Attention surface is backed in part by `GET /api/v1/dashboard`, a read-only
owner-scoped insight aggregate. It summarizes active tasks, pending approvals,
recent decision and feedback notes, recent memory changes, active threads,
contact cadence, personal list counts, guardrail trips, failed runs/tool calls,
failed outbound delivery, worker problems/recoveries, RAG indexing failures,
and failed cross-app approval executions. The endpoint derives those panels from
existing source records and does not return connector credentials, MCP tokens,
raw tool-call payloads, integration URLs, or outbound recipient addresses.

Markdown memory writes include audit-backed provenance metadata. The agent
should pass `sourceKind`, `confidence`, `evidence`, and `durability` when it
uses `write_file`; host-owned writers fill those fields for newsletters,
personal lists, owner feedback, task outcomes, assistant decisions, and manual
edits. Memory-change API and dashboard surfaces expose this compact provenance
so stale inferences and direct owner statements can be distinguished later.

Phase 08 approvals are visible in the Attention tab approval inbox. Autonomous
cross-app write proposals, self-review contact, and memory-review contact
create approval records instead of executing immediately. Direct owner commands
from web chat, mobile voice, or owner-classified inbound messages execute
through scoped app tokens without an extra approval hop. The daily conversational
check-in may research genuinely useful newsletter material and use only the
sanitized cited result as an icebreaker, preferring MMS with SMS/email fallback.
If research is unnecessary or fails safely, host code queues a fixed casual
"What's up?" fallback. This path does not create an approval. The owner can approve,
reject, edit outbound text, or bulk reject stale approvals from the UI.
Owner-classified SMS/email replies of `YES`, `NO`, `EDIT <text>`, `LATER`, or
`DETAILS` are parsed by host code against the most recent pending approval; the
model does not choose approval ids or recipients.

API and worker startup run the TypeScript migration runner before serving:

```bash
cd api
npm run migrate
```

Standalone mode is only for local development. It is not production auth.

## Services

- `db`: local Postgres.
- `qdrant`: local derived vector index for RAG search state.
- `api`: Hono API.
- `worker`: worker process stub.
- `rag-worker`: background RAG/index reconciliation entrypoint.
- `mcp`: server-side agent tool boundary for memory/RAG tools.
- `web`: Vite development server.
- `nginx`: production-style local static/proxy service.

## Validation

Run the full validation flow from the repository root:

```bash
./scripts/validate.sh
```

Run targeted checks while iterating:

```bash
./api/lint.sh
./api/test.sh
./web/test.sh
./web/build.sh
```

Agent runtime tests use `MockModelClient`; validation does not call the OpenAI
API. Real OpenAI wiring must remain behind `AgentModelClient`. To run real
model calls locally, set `AGENT_OPENAI_API_KEY` in your ignored local env file
or point `AGENT_OPENAI_API_KEY_FILE` at an ignored file. `AGENT_OPENAI_BASE_URL`
defaults to `https://api.openai.com/v1`.

Web-research tests inject `WebResearchClient` or a mocked fetch implementation.
They verify the isolated search/detector/sanitizer calls and must not contact the
live web or OpenAI. For a manual live check, explicitly set
`AGENT_WEB_RESEARCH_ENABLED=true`; the feature uses the auxiliary OpenAI key,
not the internal no-network model gateway key.

Authenticated owner prompts can be sent to the same decision loop used for
owner-classified SMS/MMS/email:

```text
POST /api/v1/agent/prompts
```

The JSON body is `prompt`, optional `contextTaskId`, and optional `mode`
(`normal`, `quick_reply`, or `planning`). The endpoint requires the normal web
session cookie, creates an agent run, and executes at most one selected
host-validated tool call through MCP. Tests should inject `MockModelClient`
through `buildApp` instead of relying on live OpenAI credentials.

The web console exposes this endpoint from Chat. The Chat tab remains a
conversational surface and folds only bounded recent browser chat turns into
follow-up prompt text; it does not expose prompt modes, task selectors, memory
selectors, run ids, selected tools, or other operator/debug controls. If the
model answers a web prompt without selecting a tool, the response includes
`responseText` for the UI to display directly. The production-style Nginx
service keeps API proxy reads open for 600 seconds so slow owner-command prompt
runs can return within the configured runtime budget. Do not add browser-side
access to write/action MCP tools for this workflow.

Mobile voice prompts use the same owner decision loop after server-side
transcription:

```text
POST /api/v1/agent/voice-prompts
```

The endpoint requires the normal web session cookie and accepts
`multipart/form-data` with an `audio` file plus optional `recent_context`. The
host transcribes bounded uploaded audio with `AGENT_OPENAI_TRANSCRIPTION_MODEL`
defaulting to `gpt-4o-transcribe`, rejects files over
`AGENT_VOICE_MAX_AUDIO_BYTES`, and then sends the transcript into the same
authenticated web prompt flow. Raw audio is not persisted by the app.

Owner corrections should be captured through `record_owner_feedback` when the
owner corrects behavior, wording, timing, memory categorization, task/tool/app
choice, or schedule. The tool writes structured markdown under
`/assistant/feedback/YYYY-MM.md`, audits the write, and queues normal RAG
indexing. Feedback is a training/review signal only; do not rewrite preference
files or capability guidance from it unless a separate controlled tool call
does so with clear rationale.

Owner-classified inbound SMS/MMS/email that reaches the agent includes a
deterministic intent envelope in the prompt. The host computes this with
conservative heuristics for memory/list offload, task creation/update,
question/answer, approval-style replies, preference corrections, app action
requests, casual conversation, clarification responses, and unknown messages.
The envelope includes confidence and generic evidence strings and is audited as
`message.owner_intent.classified` on the inbound message. It is guidance only:
approval replies and sender-review replies are handled before classification,
and the classifier must not create tasks, write memory, update trust, approve
messages, or call app integrations by itself.

Conversation threading is automatic for owner-command prompts that arrive
through inbound SMS/MMS/email. The host creates or reuses a user-owned
`conversation_threads` record before the model call, includes recent thread
summaries in the prompt, and stores the selected thread id in inbox metadata
when routed to the agent. The model can inspect and maintain this surface with
`list_conversation_threads`, `update_conversation_thread`, and
`link_conversation_thread`; link requests must point to records owned by the
same authenticated user.

Meaningful assistant decisions are captured by host code under
`/assistant/decisions/YYYY-MM-DD.md`. The daily shard bounds section parsing
and RAG reindex work on each append. The ledger is written from existing
run/task/tool/message/approval records after accepted tool calls and scheduled
worker outcomes, so it should explain why the assistant messaged, stayed quiet,
requested clarification, queued approval, changed a task schedule/status, or
recorded self-review/memory-review findings without an extra model call. Inspect
it through the Knowledge tab or:

```text
GET /api/v1/knowledge/files/%2Fassistant%2Fdecisions%2FYYYY-MM-DD.md
```

Runaway guardrails and operational recovery state are configured through host
settings and shown in the Operations tab / `GET /api/v1/jobs`. The jobs response
also reports safe optional integration status, connector completeness,
failed/dead RAG jobs, failed cross-app approval executions, worker connector
failures, recovery events, and stale claimed/running/sending state. Defaults are
intentionally capable loop protection rather than daily usage lockouts: 50 tool
calls per run, 500 runtime seconds per run, 60 agent runs per user per
600-second burst window, 10 scheduled agent runs per worker tick, 10
autonomous/proactive owner-visible outbound proposals per user per rolling day,
one outbound send per worker tick, five untrusted review notifications per
sender per day, and 25 newsletter documents per interest check. Local overrides
use:

```text
AGENT_MAX_TOOL_CALLS
AGENT_MAX_RUNTIME_SEC
AGENT_MAX_RUNS_PER_USER_PER_BURST_WINDOW
AGENT_RUN_BURST_WINDOW_SECONDS
AGENT_MAX_AUTONOMOUS_RUNS_PER_WORKER_TICK
AGENT_MAX_OWNER_VISIBLE_OUTBOUND_MESSAGES_PER_USER_PER_DAY
AGENT_OUTBOUND_MESSAGES_PER_WORKER_TICK
AGENT_MAX_NEWSLETTER_DOCUMENTS_PER_INTEREST_CHECK
INBOUND_MAX_UNTRUSTED_REVIEW_NOTIFICATIONS_PER_SENDER_PER_DAY
AGENT_MAX_PROMPT_EXCERPT_CHARS
AGENT_MAX_CONTEXT_EXCERPT_CHARS
```

`AGENT_MAX_RUNS_PER_USER_PER_HOUR` remains a compatibility alias for the burst
window limit, but new deployments should use the explicit burst-window names.

Guardrail trips record `guardrail.exceeded` audit events with counts, limits,
window seconds, and non-secret reasons. They should be treated as operational
safety events, not prompt-quality feedback.

Scheduled task intelligence is worker-owned. The worker maintains a daily
conversational check-in, an autonomous wake task that recurs roughly every
three hours, a twice-daily assistant self-review task, and a weekly memory
quality review task. Before each recurring run, host code refreshes the model
prompt with active tasks, `/assistant/schedule.md`,
`/tasks/schedule-rationale.md`, `/assistant/notification-policy.md`, recent
owner messages, and recent newsletter knowledge. Schedule-changing tools require
rationale and write task events; failed recurring wake runs still create the
next wake. At 17:00 in the owner's configured timezone (UTC fallback), the daily task
may run one isolated public-web research call with exact newsletter provenance
paths. The host appends a casual question and queues the sanitized result while
preferring MMS and falling back to SMS or email; otherwise it queues the fixed
casual fallback. One per-user/local-date dedupe key prevents replayed tasks from
creating another message or conversation thread. Proactive origin metadata makes
the outbound budget exclude ordinary owner replies. The host-owned daily row
remains proactively classified but its validated daily key bypasses the generic
rolling budget; unrelated proactive messages remain guarded. The daily check does not
create a web approval backlog.
Inbound task continuations are requeued as pending worker work after the owner
message run completes. Approval-gated autonomous actions send their approval
notice through the configured owner SMS/MMS or email connector, where owner
replies such as `YES` and `NO` are handled deterministically; signing into the
web UI is not required.

The memory quality review runs around Sunday 10:00 local/server time. Its
prompt includes bounded recent markdown writes under `/personal/`,
`/assistant/`, `/tasks/outcomes/`, `/newsletters/`, and
`/assistant/newsletter-interest/`, plus `/personal/lists/*.md` summaries,
recent task outcome memory, recent owner feedback signals, recent self-review
notes, and the current monthly review note. Findings are written through the
normal MCP-backed `write_file` tool to `/assistant/memory-review/YYYY-MM.md`.
The review should add compact evidence-backed findings and cleanup proposals,
not silently delete memory or message the owner just because the review ran.

Live connector config can be seeded from ignored files for initial bootstrap or
repair with:

```bash
cd api
AGENT_SEED_USER_EMAIL=person@example.test npm run seed:live-config -- --secret-dir ../secrets --dry-run
```

The dry run reports which settings are present without printing secret values.
The non-dry-run path requires an existing local agent user created by standalone
or OAuth sign-in.

The seed command reads legacy/bootstrap files:

- `contact.json` for owner email/SMS/MMS gateway addresses;
- `email.json` for IMAP/SMTP connector metadata;
- `openai.txt` when `AGENT_OPENAI_API_KEY_FILE` points at the mounted secret
  file.

Normal user connector setup happens through the web Integrations tab. Each user
owns their contact details, SMS/MMS gateway addresses, assistant mailbox
identity, IMAP settings, and SMTP settings. The webmaster-owned OpenAI API key
remains deployment configuration and AI model settings remain under Settings.

Connector and integration tests also avoid live networks. They use deterministic
sender classification, mock fetch implementations, and outbox records instead of
real IMAP, SMTP, SMS, MMS, or cross-app API calls.

Scenario-level agent tests use the test-only harness in
`api/tests/helpers/agentSimulation.ts`. Use it when a behavior depends on a
sequence such as newsletter ingestion followed by a scheduled worker tick, an
owner memory offload followed by recall, guardrail failure followed by
self-review, owner correction followed by review context, or conversation
thread follow-up continuity. The harness stages model tool calls
deterministically and uses the in-memory store; it must not call live OpenAI,
IMAP, SMTP, SMS/MMS, Qdrant, or cross-app APIs.

Run only those scenarios while iterating with:

```bash
cd api
npm test -- --run tests/agentSimulation.test.ts
```

## MCP Local Workflow

The local MCP service is the server-side memory/RAG tool boundary. It runs in
Docker on `http://localhost:18083` or directly from the API package:

```bash
cd api
npm run mcp
```

Host code creates a short-lived MCP bearer token for the current authenticated
user/run. Runtime-created sessions include an explicit allowlist of agent tool
names. The MCP service lists tools at `GET /mcp/v1/tools` and accepts structured
JSON calls at `POST /mcp/v1/tools/:tool/call` with
`Authorization: Bearer <token>` and, for run-bound sessions,
`X-Agent-Run-Id: <run id>`. The legacy `POST /mcp/v1/tools/:tool` endpoint is
kept for existing memory/RAG callers that expect `{ result }` responses.
The web API can mint browser-facing MCP sessions at
`POST /api/v1/agent/mcp-sessions`, but those sessions are intentionally limited
to read-only memory browsing and search tools.

Agents and tests should pass only tool arguments such as file paths, content,
task ids, and message bodies. They must not pass `userId`, tenant, Qdrant
collection, connector credential, or recipient fields. Owner-reply recipient
resolution uses verified host context passed into MCP, not model arguments.

The production runtime path uses `McpToolClient`. `LocalToolClient` remains a
deterministic compatibility wrapper for focused tests and fallback debugging.

Human/UI knowledge inspection uses:

```text
GET /api/v1/knowledge/tree
GET /api/v1/knowledge/files?path=/assistant
GET /api/v1/knowledge/files/:encodedPath
PUT /api/v1/knowledge/files/:encodedPath
GET /api/v1/knowledge/files/:encodedPath/sections
```

Encode full markdown paths for `:encodedPath`, for example
`%2Fpersonal%2Fprofile.md`.

The Knowledge tab uses these routes for the markdown knowledge browser. It shows
the standard knowledge roots, selected file index status, heading outline, exact
path/body search for loaded data, and raw markdown preview. Editing is limited
to assistant-authored markdown under `/assistant/`; other durable writes should
continue through host-owned ingestion or the validated agent runtime.

Recent memory writes are available from the Knowledge tab and:

```text
GET /api/v1/memory/changes/recent?pathPrefix=/personal&action=markdown.write&limit=50
```

The response is user-scoped and read-only. It includes the markdown path, audit
action, actor type, version movement, linked ids when audit details have them,
and a bounded redacted unified diff. The endpoint is for inspection; it does not
revert, delete, or mutate memory.

## RAG Indexing

Markdown documents in Postgres are the source of truth. Writes enqueue
`rag_index_jobs`; the `rag-worker` derives chunks and Qdrant vectors from those
rows. Qdrant is rebuildable and uses one host-chosen collection per user, so MCP
tools and model calls must never provide collection names.

Migration `0013_rag_job_coalescing` removes obsolete active jobs, restores one
current job for each document that still needs indexing, and installs an
active-request uniqueness guard. Queue writers use conflict-safe inserts so a
reconciliation loop cannot create an unbounded duplicate backlog.

Local RAG services:

```bash
docker compose up qdrant db
cd api
npm run rag-worker
```

The worker uses `RAG_EMBEDDING_MODEL`, `RAG_EMBEDDING_DIMENSIONS`, and the same
OpenAI key settings as the agent runtime: `AGENT_OPENAI_API_KEY` or
`AGENT_OPENAI_API_KEY_FILE`. Tests use mock embedding and Qdrant clients and
must not call live OpenAI or Qdrant.

Indexing uses conservative fixed limits for the production worker's small
resource envelope. One source may contain at most 250,000 UTF-16 characters,
400 parsed markdown sections, and 256 derived chunks. Oversize sources are
deterministic failures and are dead-lettered before collection lookup, Qdrant
deletion, or embedding. Accepted sources are processed sequentially in batches
of no more than 16 embedding inputs and eight Qdrant points, so a document never
holds every vector or one all-document upsert body in memory.

Every provider request, including complete response-body consumption, has a
20-second deadline and a 4 MiB response ceiling. Declared oversize bodies are
rejected before reading; streamed bodies are counted and cancelled on overflow.
Each job has a 90-second processing deadline checked between phases and batches.
Network failures, deadlines, HTTP 408/409/425/429, and 5xx responses are
retryable; other 4xx responses, oversize or malformed provider data, missing
embedding credentials, invalid vectors, and source-limit failures are
dead-lettered on the first attempt. A claimed job is tried at most three times.
If process termination prevents the catch path from recording a result, the
next stale claim that raises the attempt count above three is dead-lettered
before source or provider work. Exact Qdrant point counting remains best-effort
telemetry and cannot replay an otherwise completed index.

The worker writes metadata-only JSON progress events for job phases and batches,
including job id, attempt, elapsed time, bounded counts, and process/cgroup CPU
and memory snapshots. It never logs the user, markdown path/title/content,
query, or vector. Startup, non-overlapping tick transitions, and job progress
also atomically refresh `/tmp/rag-worker-health.json`; its top-level
`updated_at` timestamp becomes stale after two minutes and is used by container
health monitoring to detect a blocked event loop or killed worker. A skipped
interval logs a resource sample but deliberately does not refresh the file, so
repeated overlap cannot disguise a permanently stuck tick.

Useful MCP RAG tools:

```text
search_exact({ query, pathPrefix?, limit? })
search_semantic({ query, pathPrefix?, limit? })
find_backlinks({ path })
get_index_status({ path? })
reindex_path({ path })
```

`get_index_status` reports source-row indexing state and pending jobs.
`reindex_path` enqueues repair jobs for the authenticated user's matching
markdown path tree. If the worker stops mid-job, stale claimed jobs become
claimable again after the restart grace window.

Useful MCP personal memory list tools:

```text
add_memory_list_item({ listName, item, notes?, sourceMessageId?, rationale })
list_memory_items({ listName? | path?, status?, limit? })
search_memory_lists({ query, limit? })
update_memory_list_item({ listName? | path?, itemId? | item?, newItem?, notes?, status?, archiveReason?, rationale })
remove_memory_list_item({ listName? | path?, itemId? | item?, reason?, rationale })
```

List files are stored as user-scoped markdown under `/personal/lists/*.md`.
The tools normalize common owner phrases such as "movie night" to canonical
lists, reject paths outside `/personal/lists/`, avoid duplicate active entries,
and archive by default when removing an item.

Useful MCP task/schedule tools:

```text
update_task_schedule({ taskId, dueAt, rationale, confidence, nextReviewAt? })
update_task_status({ taskId, status, rationale, waitingOn?, blockedReason? })
split_task({ taskId, newTasks, rationale })
create_followup_task({ sourceTaskId?, title, prompt, dueAt?, rationale })
mark_waiting_on({ taskId, waitingOn, rationale, nextReviewAt? })
request_clarification({ question, relatedTaskId?, urgency, rationale })
record_schedule_rationale({ taskId, rationale, sourceMemoryPath?, recurrencePolicy? })
schedule_owner_message({ body, subject?, dueAt, rationale })
```

These tools resolve user scope from the MCP session. Do not pass user ids,
tenant ids, recipients, connector secrets, or deployment hostnames in arguments.
