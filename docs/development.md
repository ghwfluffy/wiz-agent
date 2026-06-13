# Development

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

The home screen is the operational dashboard. It supports creating and updating
tasks, talking directly to the agent through `POST /api/v1/agent/prompts`,
approving or cancelling outbound messages, browsing markdown memory/knowledge,
managing sender trust, inspecting worker and index status, viewing agent
run/tool-call/audit history, and editing admin AI model configuration when the
signed-in user is an administrator. OAuth callback failures redirect back to the
UI with an `oauth_error` token; the web store converts that token into a
friendly message and removes it from the URL.

Phase 08 approvals are visible in the Approval inbox. High-risk outbound owner
messages and cross-app write proposals create approval records instead of
executing immediately. The owner can approve, reject, edit outbound text, or
bulk reject stale approvals from the UI. Owner-classified SMS/email replies of
`YES`, `NO`, `EDIT <text>`, `LATER`, or `DETAILS` are parsed by host code
against the most recent pending approval; the model does not choose approval ids
or recipients.

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

The web console exposes this endpoint from Overview and Chat. Task context is
sent as `contextTaskId`; selected memory paths and recent assistant-mailbox
messages are folded into the prompt text as operator-selected context. Do not
add browser-side access to write/action MCP tools for this workflow.

Owner corrections should be captured through `record_owner_feedback` when the
owner corrects behavior, wording, timing, memory categorization, task/tool/app
choice, or schedule. The tool writes structured markdown under
`/assistant/feedback/YYYY-MM.md`, audits the write, and queues normal RAG
indexing. Feedback is a training/review signal only; do not rewrite preference
files or capability guidance from it unless a separate controlled tool call
does so with clear rationale.

Meaningful assistant decisions are captured by host code under
`/assistant/decisions/YYYY-MM.md`. The ledger is written from existing
run/task/tool/message/approval records after accepted tool calls and scheduled
worker outcomes, so it should explain why the assistant messaged, stayed quiet,
requested clarification, queued approval, changed a task schedule/status, or
recorded self-review/memory-review findings without an extra model call. Inspect
it through the Memory tab or:

```text
GET /api/v1/knowledge/files/%2Fassistant%2Fdecisions%2FYYYY-MM.md
```

Runaway guardrails are configured through host settings and shown in the
Workers tab / `GET /api/v1/jobs`. Defaults are intentionally conservative loop
protection: 20 agent runs per user per hour, 10 scheduled agent runs per worker
tick, 10 owner-visible outbound proposals per user per day, one outbound send
per worker tick, five untrusted review notifications per sender per day, and 25
newsletter documents per interest check. Local overrides use:

```text
AGENT_MAX_RUNS_PER_USER_PER_HOUR
AGENT_MAX_AUTONOMOUS_RUNS_PER_WORKER_TICK
AGENT_MAX_OWNER_VISIBLE_OUTBOUND_MESSAGES_PER_USER_PER_DAY
AGENT_OUTBOUND_MESSAGES_PER_WORKER_TICK
AGENT_MAX_NEWSLETTER_DOCUMENTS_PER_INTEREST_CHECK
INBOUND_MAX_UNTRUSTED_REVIEW_NOTIFICATIONS_PER_SENDER_PER_DAY
AGENT_MAX_PROMPT_EXCERPT_CHARS
AGENT_MAX_CONTEXT_EXCERPT_CHARS
```

Guardrail trips record `guardrail.exceeded` audit events with counts, limits,
and non-secret reasons. They should be treated as operational safety events,
not prompt-quality feedback.

Scheduled task intelligence is worker-owned. The worker maintains a daily
newsletter interest check, an autonomous wake task that recurs roughly every
three hours, a twice-daily assistant self-review task, and a weekly memory
quality review task. Before each recurring run, host code refreshes the model
prompt with active tasks, `/assistant/schedule.md`,
`/tasks/schedule-rationale.md`, `/assistant/notification-policy.md`, recent
owner messages, and recent newsletter knowledge. Schedule-changing tools require
rationale and write task events; failed recurring wake runs still create the
next wake.

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

Normal user setup happens through the web Settings tab. Each user owns their
contact details, SMS/MMS gateway addresses, assistant mailbox identity, IMAP
settings, and SMTP settings. The webmaster-owned OpenAI API key remains
deployment configuration.

Connector and integration tests also avoid live networks. They use deterministic
sender classification, mock fetch implementations, and outbox records instead of
real IMAP, SMTP, SMS, MMS, or cross-app API calls.

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

The Memory tab uses these routes for the markdown knowledge browser. It shows
the standard knowledge roots, selected file index status, heading outline, exact
path/body search for loaded data, and raw markdown preview. Editing is limited
to assistant-authored markdown under `/assistant/`; other durable writes should
continue through host-owned ingestion or the validated agent runtime.

## RAG Indexing

Markdown documents in Postgres are the source of truth. Writes enqueue
`rag_index_jobs`; the `rag-worker` derives chunks and Qdrant vectors from those
rows. Qdrant is rebuildable and uses one host-chosen collection per user, so MCP
tools and model calls must never provide collection names.

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
```

These tools resolve user scope from the MCP session. Do not pass user ids,
tenant ids, recipients, connector secrets, or deployment hostnames in arguments.
