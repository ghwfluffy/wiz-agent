# Observability And Safety

Phase 09 makes operational state visible through the API and owner console
without moving ownership of policy, credentials, or side effects to the model.

## Status Surfaces

Authenticated users can call `GET /api/v1/jobs` for their own operational
status. Administrators can call `GET /api/v1/admin/jobs` for the same shape
with admin-scoped audit, run, tool-call, and RAG visibility.

The response includes:

- API status and recent audit time.
- Worker tick, task-runner, inbound mailbox, outbox, approval, MCP/tool, RAG
  index, and Qdrant collection rows.
- Host-owned run budgets: max tool calls per run, max runtime seconds, repair
  attempts, outbound messages per worker tick, RAG search result cap, and
  browser MCP session TTL.
- Recent failed agent runs, rejected or failed tool calls, and failed/dead RAG
  index jobs.
- RAG user index health rows with expected document/chunk counts and Qdrant
  point count when the RAG worker has reconciled it.

The Workers tab consumes this endpoint and shows the same budget, queue,
failure, and Qdrant/RAG health information.

Approval execution status is visible on approval records and in audit logs.
Cross-app write execution records `approval.execution.running`,
`approval.execution.succeeded`, or `approval.execution.failed`; success details
include only redacted integration response data, and failures include a bounded
host error reason such as an unknown action, read action, missing token, expired
approval, or non-2xx integration response.

Scheduled assistant self-review runs are visible through the same task, run,
tool-call, and audit surfaces as other scheduled tasks. Successful reviews
record `agent.prompted`, accepted tool-call, and `scheduled_task.outcome`
events, and their markdown writes enqueue normal RAG indexing. Failed reviews
record `scheduled_task.failed` with the failure message, then the scheduler
still creates the next self-review task so a transient model or tool outage does
not permanently disable operational review.

## Manual Recovery

RAG indexing already retries transient failures and dead-letters exhausted
jobs. Administrators can manually retry a failed or dead job with:

```text
POST /api/v1/admin/rag-index-jobs/:id/retry
```

Retrying preserves the attempt count for auditability, clears the failure
message, moves the job back to `pending`, and records a
`rag.index_job.retry` audit event. Callers cannot provide user IDs, document
IDs, collection names, or retry timing.

## Safety Boundaries

Operational endpoints expose state that is already user-owned or admin-owned;
they do not expose connector passwords, raw credential references, MCP bearer
tokens, or secret file contents. Connector reads continue to redact IMAP/SMTP
passwords.

The model never supplies Qdrant collection names. Collection names are derived
by host code from the authenticated user and are surfaced only as operator
health metadata. Local Compose binds Qdrant to `127.0.0.1` by default; production
network exposure is owned by the root deployment repository and should not make
Qdrant publicly reachable.

MCP sessions remain short-lived, user/run scoped, and allowlisted. Browser MCP
sessions are limited to read-only memory/search tools. Agent-created MCP
sessions are tied to one run and the host-selected tool allowlist.

Approved cross-app writes are not MCP/model execution. They are host-owned
worker executions that revalidate the stored action id and access level against
the capability registry immediately before calling the integration gateway.
Directory-only apps and read actions fail closed in this executor.

Self-review prompts are treated as internal operational work. They may inspect
recent bot activity and write assistant memory, but they explicitly prohibit
owner contact solely because the review ran. Any owner-visible message still
uses the normal `propose_outbound_message` approval/outbox controls.
