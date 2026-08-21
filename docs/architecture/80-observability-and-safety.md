# Observability And Safety

Phase 09 makes operational state visible through the API and owner console
without moving ownership of policy, credentials, or side effects to the model.

## Status Surfaces

`GET /api/v1/status` is an unauthenticated configuration-status surface; it is
not a process or database health probe. It returns the app/version plus safe
configuration status labels only: environment,
auth mode, whether an app base path is configured, whether the session cookie is
scoped when a base path exists, outbound delivery enabled/disabled state,
optional integration status, and production-safety issue codes. It must not
return configured public URLs, app base-path values, integration base URLs,
connector hosts, or secret paths. Missing optional integrations are reported as
`missing_optional`; configured cross-app integration URLs without token signing
are reported as misconfigured so operators can distinguish absent optional apps
from unsafe or nonfunctional production wiring.

`GET /healthz` is the minimal process-liveness surface and does not touch
Postgres. `GET /readyz` performs a read-only `SELECT 1` with bounded pool
acquisition and query time, returning only `ready` or `not_ready`. It does not
return database errors, addresses, credentials, or connection details.

Authenticated users can call `GET /api/v1/jobs` for their own operational
status. Administrators can call `GET /api/v1/admin/jobs` for the same shape
with admin-scoped task, connector, outbox, approval, audit, run, tool-call, and
RAG visibility. Admin aggregation still returns bounded counts and redacted
summaries rather than connector secrets, recipient addresses, raw tool
arguments/results, or integration URLs.

Authenticated users can also call `GET /api/v1/dashboard` for the owner
command-center summary used by the Attention tab. The endpoint is read-only,
user-scoped, and derived from source records rather than cached state. It
returns compact sections for active tasks and schedule rationale, pending
approvals, recent assistant decision ledger files, recent memory changes,
recent owner feedback files, active/waiting conversation threads, owner-visible
contact cadence, personal list counts, guardrail trips, failed runs, failed
tool calls, and failed outbound delivery.

The dashboard surface intentionally does not return connector configuration,
connector passwords, MCP bearer tokens, raw tool-call arguments/results, or
deployment-owned host/secret values. Outbound summaries omit recipient
addresses; memory snippets skip credential-like lines before display.

The jobs response includes:

- API status and recent audit time.
- Worker tick, task-runner, inbound mailbox, outbox, approval, MCP/tool, RAG
  index, and Qdrant collection rows.
- Safe configuration and connector-health summaries, including incomplete
  enabled IMAP/SMTP/owner-contact connectors without returning hostnames,
  usernames, passwords, base URLs, or secret refs.
- Stale-state counts for claimed/running tasks, running agent runs, sending
  outbox messages, expired pending approvals, and running cross-app approval
  executions. These counts correspond to worker recovery behavior and let
  operators see stuck state before or after recovery.
- Host-owned run budgets: max agent runs per user per short burst window,
  autonomous runs per worker tick, max tool calls per run, max runtime seconds,
  repair attempts, autonomous/proactive owner-visible outbound messages per
  user per rolling day, outbound messages per worker tick, untrusted review
  notifications per sender per day, newsletter documents per interest check,
  prompt/context excerpt caps, RAG search result cap, and browser MCP session
  TTL.
- Recent failed agent runs, rejected or failed tool calls, and failed/dead RAG
  index jobs.
- Recent worker connector failures, approval execution failures, and worker
  recovery events.
- Recent `guardrail.exceeded` audit events and a `runaway-guardrails` job row.
- RAG user index health rows with expected document/chunk counts and Qdrant
  point count when the RAG worker has reconciled it.

The Operations tab consumes this endpoint and shows the same budget, queue,
failure, and Qdrant/RAG health information.

Approval execution status is visible on approval records and in audit logs.
Cross-app write execution records `approval.execution.running`,
`approval.execution.succeeded`, or `approval.execution.failed`; success details
include only redacted integration response data, and failures include a bounded
host error reason such as an unknown action, read action, missing token, expired
approval, or non-2xx integration response. Raw provider/client exception text
is scrubbed for bearer tokens, credential-like values, cookies, session values,
and URLs before it is stored as an approval execution error.

Scheduled assistant self-review runs are visible through the same task, run,
tool-call, and audit surfaces as other scheduled tasks. Successful reviews
record `agent.prompted`, accepted tool-call, and `scheduled_task.outcome`
events, and their markdown writes enqueue normal RAG indexing. Failed reviews
record `scheduled_task.failed` with the failure message, then the scheduler
still creates the next self-review task so a transient model or tool outage does
not permanently disable operational review.

Scheduled memory quality reviews use the same visibility and failure behavior.
Successful runs show the recurring task, agent run, accepted `write_file` or
memory-list tool call, task outcome event, markdown write audit, and RAG index
job for `/assistant/memory-review/YYYY-MM.md`. Failed runs record
`scheduled_task.failed`, and the scheduler still creates the next weekly memory
review so curation does not stop after a transient model or MCP outage.

Assistant decision-ledger entries are visible through the markdown knowledge
browser under `/assistant/decisions/YYYY-MM-DD.md`, normal markdown write audit
events, and RAG index jobs. They provide owner-facing explanations for
meaningful autonomous decisions without adding a new privilege surface: entries
are generated by host code from already persisted records, use user-scoped
markdown writes, and contain ids/rationale/status metadata instead of secrets,
tokens, raw connector credentials, or deployment hostnames.

Worker stale-state recovery is visible through existing source records and
audit logs. Stale claimed tasks become failed tasks with
`scheduled_task.failed`, task outcome memory, a decision-ledger entry, and
`worker.recovered_task_claim` audit. Stale `sending` outbox records become
failed delivery records with `worker.recovered_outbound_send`. Stale running
cross-app approvals become failed approval executions with
`worker.recovered_approval_execution`. Expired pending approvals become
`expired` records with linked approval outbox entries cancelled.
SMTP transport failure messages follow the same operator boundary: they are
visible on failed outbox records, but persisted text is bounded and scrubbed for
credential-like values and URLs.

Recent memory mutations are visible through the Knowledge tab and
`GET /api/v1/memory/changes/recent`. The surface is derived from user-scoped
markdown audit events and shows path, source action, actor type, version
movement, linked ids, provenance/confidence, and a bounded unified diff. Diff
snapshots and provenance evidence are redacted at write-audit time for common
credential-bearing lines and capped before storage and display. The surface is
read-only; rollback or destructive memory controls require a separate
host-validated design.

## Manual Recovery

RAG indexing already retries transient failures and dead-letters exhausted
jobs. Administrators can manually retry a failed or dead job with:

```text
POST /api/v1/admin/rag-index-jobs/:id/retry
```

Retrying resets the active attempt count to zero so the operator action grants
a fresh bounded retry budget, clears the failure message, and moves the job
back to `pending`. The `rag.index_job.retry` audit event preserves the prior
attempt count. Callers cannot provide user IDs, document IDs, collection names,
or retry timing.

The indexer distinguishes retryable infrastructure failures from deterministic
input/configuration failures. Network errors, provider/body deadlines,
HTTP 408/409/425/429, and 5xx responses may retry up to three attempts. Other
4xx responses, missing embedding credentials, malformed responses or vectors,
and hard source-limit failures dead-letter immediately. If the operating system
kills the worker before its catch path runs, stale claiming increments the
persisted attempt count; a claim above the limit is dead-lettered before reading
the document or contacting a provider. This closes the crash-loop case that
ordinary exception retry handling cannot observe.

Source validation happens before provider or destructive derived-index work.
The fixed ceilings are 250,000 source characters, 400 markdown sections, and
256 chunks. Valid documents use sequential batches of 16 embedding inputs and
eight Qdrant points, a 20-second full-request provider deadline, a 4 MiB
declared-and-streamed response limit, and a 90-second overall job deadline with
checks between phases and batches. Response overflow aborts/cancels the body and
is a deterministic non-retryable provider failure. Exact point counts are
best-effort telemetry after durable chunk persistence and cannot cause a
whole-document replay.

The main agent worker and RAG worker use a five-second Postgres connection
deadline plus 20-second client-query and server-statement deadlines. These
limits keep one unavailable or stalled database operation below the RAG
worker's 90-second whole-job deadline and prevent a live worker tick from
waiting indefinitely on Postgres.

## Safety Boundaries

Operational endpoints expose state that is already user-owned or admin-owned;
they do not expose connector passwords, raw credential references, MCP bearer
tokens, or secret file contents. Connector reads continue to redact IMAP/SMTP
passwords. Audit/log endpoints return sanitized details: secret-like keys are
redacted, bearer tokens and credential assignments are scrubbed, URLs are
replaced with `[url]`, arrays and nested objects are bounded, and long strings
are capped before display. Worker and RAG-worker JSON logs use the same
operator boundary for provider exception text.

RAG job progress logs are a stricter metadata-only surface. Per-job entries
contain only job id, attempt, phase, elapsed time, bounded batch/chunk counts,
retry classification/error code, and process/cgroup resource counters. They do
not contain a user id, markdown path, title, content, query, or vector. Startup
and every worker tick carry the same resource snapshot. Startup,
non-overlapping tick transitions, and job stage transitions atomically replace
`/tmp/rag-worker-health.json`; the file uses a top-level ISO `updated_at` value
and a two-minute freshness threshold so a CPU-bound event loop or terminated
worker becomes unhealthy without writing source data to the probe surface.
Skipped overlapping ticks log their resource sample without refreshing the
file, preventing a permanently stuck prior tick from looking healthy.
The heartbeat also preserves `last_success_at` and `last_failure_at`. Startup
and job progress cannot clear an earlier failure; only completion of a tick
whose Qdrant gate succeeded advances success. Degraded or failed outcomes
advance failure, so a repeatedly failing worker remains unhealthy while its
next attempt is merely running.
A 150-second unrefed watchdog surrounds each whole RAG-worker tick. If bounded
provider and database deadlines still fail to settle the tick, the watchdog
emits a metadata-only `rag_worker_tick_watchdog_expired` event and exits
nonzero; the container restart policy then starts a clean worker process. The
watchdog is cleared after every completed or handled-failure tick.

The main worker separately atomically replaces
`/tmp/agent-worker-health.json` at tick start, success, or failure. It stores
only the tick timestamps and state. Skipped overlapping ticks do not refresh
the file. Its ten-minute freshness threshold exceeds the permitted 500-second
agent-run duration while still exposing a stuck scheduler, outbox, or IMAP tick
without persisting user or exception content.
Successful task and IMAP-UID boundaries refresh the running timestamp so a
multi-item catch-up tick remains fresh. Those progress writes preserve the
prior outcome timestamps, and a new running attempt remains unhealthy after a
failure until the full tick records a later success.

Memory change diffs follow the same boundary. They may show owner-visible
markdown content, but credential-like assignments on lines containing password,
secret, token, API key, credential, authorization, or bearer terms are replaced
with `[redacted]` before the diff is persisted in audit details. Memory
provenance carried on those audit records is scrubbed by the same safety
boundary so evidence, source labels, or future provenance fields cannot carry
token-like or credential-like text into the memory-change API.

The model never supplies Qdrant collection names. Collection names are derived
by host code from the authenticated user with a readable prefix plus a hash of
the full user id, and are surfaced only as operator health metadata. Local
Compose binds Qdrant to `127.0.0.1` by default; production network exposure is
owned by the root deployment repository and should not make Qdrant publicly
reachable.

Semantic-search excerpts are whitespace-normalized, repaired to replace lone
UTF-16 surrogates, and capped at 320 Unicode code points in both the PostgreSQL
and in-memory stores. This prevents an excerpt boundary from producing invalid
JSON while preserving a complete final emoji or other supplementary character.

RAG indexing is derived from the current markdown document version and content
hash. If a worker finishes an older indexing attempt after a newer markdown
write, the store does not replace current chunk rows or mark the newer document
indexed from that stale result. The newer queued job remains responsible for
the current index state. Active index requests are unique per user, document,
job type, requested version, and content hash; deployment migration
`0013_rag_job_coalescing` prunes historical active duplicates and obsolete
versions before enabling the production worker. Retrying a failed or dead job
does not revive it when an equivalent request is already pending or claimed;
the retry operation returns and audits that active request instead, preserving
the uniqueness guard under concurrent reconciliation.

MCP sessions remain short-lived, user/run scoped, and allowlisted. Stored
allowlists must be JSON arrays of non-empty tool names; malformed stored
allowlists fail closed instead of becoming unrestricted. Browser MCP sessions
are limited to read-only memory/search tools and cannot be bound to caller
supplied run ids. Agent-created MCP sessions are tied to one user-owned run and
the host-selected tool allowlist. MCP execution/audit uses the run id resolved
from the session, validates memory/RAG and migrated agent-tool arguments at the
boundary, and rejects caller-supplied user, tenant, collection, credential,
token, password, or raw recipient selectors.

Approved cross-app writes are not MCP/model execution. They are host-owned
worker executions that revalidate the stored action id and access level against
the capability registry immediately before calling the integration gateway.
Directory-only apps, read actions, and direct-owner-only actions fail closed in
this executor.
The integration gateway bounds the whole fetch and response-body exchange to 20
seconds. It also rejects a declared or streamed body above 1 MiB and cancels the
body before JSON parsing, preventing a stalled or oversized internal response
from permanently occupying the serial worker tick. Persisted timeout and size
reasons are deterministic and contain no target URL, token, response content,
or other credential-bearing detail.
Stale running executions also fail closed instead of retrying automatically,
because the worker cannot prove whether the external write happened before a
local crash.

Self-review prompts are treated as internal operational work. They may inspect
recent bot activity and write assistant memory, but they explicitly prohibit
owner contact solely because the review ran. Any owner-visible message still
uses the normal `propose_outbound_message` approval/outbox controls.
Owner-requested delayed messages are represented separately with
`schedule_owner_message`. Host code accepts that tool only from a current owner
command surface; autonomous and scheduled runs fail closed without creating a
future message task. Due owner-requested scheduled-message tasks are queued for
delivery by worker host code without another model decision.

Memory-review prompts are also internal operational work. They receive bounded
user-scoped memory/list/outcome/self-review context and may write curation
findings or perform safe list cleanup through validated tools, but they must not
silently delete memory or contact the owner solely because the review ran.

Web research records `web_research.completed` and `web_research.linked` audit
events with non-secret counts, risk/status, taint, expiry, and linkage ids. Raw
page text, provider answers, private queries before filtering, API keys, and
prompt-injection excerpts must not enter audit details, tool arguments, task
events, logs, or decision memory. Failed privacy/network/schema/source checks
record only bounded host-owned failure reasons.

A successful trusted-context recovery records
`agent_context.trusted_handoff` against the resumed agent run. Audit details
contain only source/resumed run ids, the host trigger category, whether the
source turn carried research, and fixed copied/excluded context labels. They do
not contain the owner command, prior model response, external evidence, or any
other prompt body. The absence of this event alongside a restriction response
means the owner text did not pass the host action check, a tool had already been
attempted, or the run was not eligible for the one-shot recovery.

When a direct Omni Dev instruction needs the deterministic no-tool fallback,
the host also records `agent_context.owner_delegation_fallback`. It contains the
source, trusted-retry, and forced-run ids; the fixed tool name; fixed copied
context labels; and the `omni_dev_preflight_required` confidence boundary. It
does not store the owner command or attachment contents.

Runaway guardrails are safety limits for accidental loops and provider abuse.
They fail closed before side effects, record non-secret counts and limits in
audit details, and show up in the Jobs/Workers status surface. They are not
intended to tune assistant personality or newsletter quality. Guardrail audit
helpers scrub secret-like keys and strings before persistence and preserve the
host-selected guardrail name even if caller details contain conflicting fields.
The owner-visible outbound rolling-day cap applies to autonomous/proactive
owner contact, not to direct owner-command replies or due owner-requested
scheduled messages.
