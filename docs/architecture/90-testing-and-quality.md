# Testing And Quality

Validation is part of the baseline scaffold.

## Commands

Run the full validation flow:

```bash
./scripts/validate.sh
```

Targeted commands:

```bash
./api/lint.sh
./api/test.sh
./web/test.sh
./web/build.sh
```

## Baseline Coverage

Current tests cover:

- deterministic scenario-level agent simulations with a test-only harness for
  multi-step assistant days, including owner messages, trusted newsletter
  ingestion, time advancement, worker ticks, staged model tool calls, and
  memory/task/outbox/approval/decision/thread assertions.
- API config loading.
- status route.
- standalone development auto-login.
- core schema table coverage.
- API error envelope.
- task user ownership.
- admin audit and AI config authorization.
- model tier selection.
- structured tool-call validation and repair.
- failed repair rejection.
- mock model agent runs.
- OpenAI Responses API adapter request/response parsing.
- deterministic local tool execution.
- run/tool-call audit traceability.
- sender classification and untrusted-message handling.
- untrusted sender rate limiting.
- due task claiming.
- task event listing and follow-up prompt handoff.
- safe URL rejection.
- MMS image sanitization policy.
- cross-app integration token enforcement.
- app capability registry coverage for Goals, Fluffynomics, and Apartment Gate.
- read-only MCP capability lookup for app registry data.
- simplified MCP wrappers for Goals and Fluffynomics reads and write-approval
  proposals.
- allowlisted integration-action request resolution.
- MCP-backed agent tool execution through the default runtime client.
- MCP session expiration, tool allowlist rejection, and agent-tool argument
  validation.
- local tool executor compatibility through `LocalToolClient`.
- frontend base-path helpers.
- sign-in button behavior.
- OAuth login redirect, callback failure handling, and callback session
  creation.
- live config seeding from ignored connector files.
- user-managed connector configuration with API-redacted credentials.
- IMAP settings tests with redacted provider errors.
- incremental IMAP search criteria from stored mailbox progress.
- worker IMAP failure audit visibility.
- sender-table owner classification.
- owner-contact backed untrusted sender review notification queueing.
- owner SMS sender-review replies for newsletter trust, one-time review, and
  blocking.
- trusted newsletter knowledge ingestion without immediate owner messaging.
- trusted non-owner sender memory integration without owner-command tool
  routing.
- owner-message memory writes through the controlled agent tool path.
- owner feedback tool validation, MCP execution, monthly markdown writes under
  `/assistant/feedback/`, audit/RAG enqueueing, prompt guidance for inconsistent
  corrections, and no automatic preference rewrite from feedback capture.
- assistant decision-ledger writes under `/assistant/decisions/YYYY-MM.md` for
  outbound proposals, cross-app approvals, scheduled quiet/acted/failure
  outcomes, linked ids, duplicate-safe markers, user scoping, audit, and RAG
  enqueueing.
- recurring newsletter interest check and three-hour autonomous wake task
  scheduling with durable schedule rationale.
- scheduled memory quality review task scheduling, bounded prompt context from
  recent memory/list/outcome/self-review notes, monthly review-note writes
  through the controlled tool path, no owner messages from review alone, and
  next-review scheduling after failed runs.
- compact task outcome markdown memory for completed/failed work, duplicate
  prevention, source-task links, user scoping, RAG job enqueueing, and scheduled
  prompt inclusion.
- newsletter preference memory writes from explicit owner messages.
- personal-profile memory injection into future owner prompts.
- deterministic owner-message intent classification for memory/list offload,
  task creation/update, question/answer, approval-style replies, preference
  corrections, app action requests, casual conversation, clarification
  responses, unknown messages, prompt injection, user-scoped audit, and
  approval/trust reply precedence.
- memory document API, Memory tab rendering, and trusted-contact management.
- memory change API and Memory tab diff rendering, including user scoping,
  path filtering, read-file links, and redaction of credential-like markdown
  lines in audit-backed diffs.
- owner reply tool contract without model-selected recipients.
- conversation thread schema coverage, in-memory store round trips, bounded
  prompt context, owner follow-up thread reuse, MCP list/update/link tools, and
  rejection of missing or foreign linked records.
- outbound fail-closed recipient checks and raw owner mobile gateway mapping.
- outbox listing, status updates, SMTP queue delivery, and fail-closed outbound
  delivery.
- operations dashboard rendering.
- operational jobs visibility, budget exposure, RAG failure listing, and manual
  RAG retry audit.
- runaway guardrails for hourly agent runs, per-run MCP/tool calls,
  owner-visible outbound proposal caps, bounded scheduled worker claims,
  non-secret guardrail audit details, and Jobs/Workers budget visibility.
- tabbed Carbon dashboard rendering, URL-backed active tabs, and focused tab
  polling.
- markdown RAG chunking determinism, section metadata preservation, and
  deterministic point IDs.
- RAG job claiming, stale-claim recovery, indexing, transient retry,
  dead-letter behavior, and delete-job point removal with mock Qdrant and mock
  embeddings.
- MCP semantic search source-handle resolution under authenticated user scope.

## Agent Simulation Harness

Scenario tests that need multiple assistant steps should use
`api/tests/helpers/agentSimulation.ts`. The helper creates an in-memory
single-user store, owner/system contexts, deterministic staged model responses,
trusted newsletter and owner-message entry points, clock advancement, scheduled
worker ticks, direct owner prompts, scheduled prompt builders, and common state
snapshots.

Keep the helper test-only. Do not add production flags or network-backed
services for scenario tests. Stage model tool calls explicitly and assert
persisted host state such as markdown memory, tasks, inbound handling,
outbox/approvals, tool calls, audit records, and conversation threads.

RAG tests must not call live OpenAI or Qdrant. Use `MockEmbeddingClient` and a
mock/fake `QdrantClient`; live vector and embedding clients are reserved for
local manual runs and deployment.

Future phases should add migration, user ownership, authorization, worker,
tool-call, connector, and admin UI tests alongside the feature work. Tenant
removal migrations and no-tenant API responses need explicit coverage so the
collapsed ownership model does not regress.
