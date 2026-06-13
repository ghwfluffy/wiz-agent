# Phase 09: Observability, Safety, And Hardening

## Goal

Make the assistant debuggable, recoverable, and safe enough for real personal
use. Every important agent decision should be traceable and every background
service should expose health.

## Observability

Add structured status for:

- API health
- worker tick health
- IMAP poll health
- outbox delivery health
- MCP health
- RAG worker health
- Qdrant collection health
- pending/failed RAG jobs
- pending approvals
- failed tool calls
- failed agent runs

Expose this in:

- `GET /api/v1/jobs`
- admin/worker UI
- audit logs
- structured JSON process logs

## Run Tracing

For each agent run, persist:

- run type: owner_message, web_prompt, scheduled_task, newsletter_synthesis,
  autonomous_wake
- source id
- prompt version
- model tier/id
- context handles used
- MCP/tools offered
- selected tool
- validation result
- execution result
- linked side effects

Avoid storing secrets or raw connector credentials.

## Safety Reviews

Add explicit policy checks for:

- newsletter/trusted content cannot trigger owner-command actions.
- untrusted content cannot receive memory/search/tool context.
- web prompt requires authenticated session.
- MCP token is scoped to one user/run.
- cross-app writes require allowed capability and approval when configured.
- outbound delivery resolves owner recipient through host code.

## Recovery

Implement:

- RAG job retry/dead-letter.
- worker resumes after restart.
- failed scheduled autonomous task still schedules next wake.
- failed MCP call records tool failure.
- failed outbound keeps failure reason.
- manual retry controls in admin UI.

## Rate Limits And Budgets

Add host-owned limits:

- max agent runs per hour.
- max autonomous actions per wake.
- max outbound notifications per day.
- max newsletter docs processed per synthesis.
- max MCP calls per run.
- max RAG search results per call.

Expose admin settings where appropriate.

## Security

Review:

- cookie/session settings.
- OAuth callback state.
- MCP token signing/expiration.
- Qdrant network exposure.
- connector password redaction.
- logs and audit details for secret leakage.

Qdrant should not be publicly exposed in production. Local compose may bind it
to localhost.

## Tests

Add tests for:

- MCP auth rejection.
- no cross-user memory/RAG access.
- Qdrant collection name cannot be supplied by model.
- failed RAG job retry/dead behavior.
- logs/audit omit connector passwords.
- scheduled task recovery after failure.
- rate limit enforcement.

Consider Playwright smoke tests once the web console stabilizes:

- sign in.
- open memory browser.
- send direct prompt.
- view resulting run/tool call.
- approve or reject an action.

## Completion Criteria

- Operators can see what the agent is doing and why.
- Failed jobs are visible and retryable.
- Safety boundaries are covered by tests.
- Production-exposed services are documented and locked down.
- `./scripts/validate.sh` passes.

## Implemented Slice

The Phase 09 implementation adds authenticated `GET /api/v1/jobs`,
administrator `GET /api/v1/admin/jobs`, and administrator
`POST /api/v1/admin/rag-index-jobs/:id/retry`. The jobs payload aggregates API,
worker, outbox, inbound-mailbox, approvals, MCP/tool-call, RAG index, Qdrant
collection, run-budget, and recent failure state. The web Workers tab exposes
those fields and provides manual retry for failed/dead RAG jobs.

RAG retry preserves attempt history, clears the current failure, requeues the
job as pending, and writes `rag.index_job.retry` audit events. Qdrant collection
names remain host-derived; callers cannot provide collection names, user IDs, or
document IDs to retry jobs.
