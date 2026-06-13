# Phase 05: Runaway Loop Guardrails

## Goal

Add host-owned hard limits that prevent accidental loops from burning tokens,
spamming SMTP/SMS/MMS, or repeatedly invoking MCP/tools.

These limits are safety rails, not product-tuning knobs. Exact default values
are less important than bounded behavior, clear failure modes, and operator
visibility.

## Sub-Agent Prompt

Implement Phase 05 from `docs/plans/05-runaway-loop-guardrails.md`.
Read `docs/plans/README.md`, `docs/architecture/50-agent-runtime.md`,
`docs/architecture/60-connectors-and-side-effects.md`,
`docs/architecture/80-observability-and-safety.md`, and
`docs/architecture/90-testing-and-quality.md`.

Add runaway loop guardrails, tests, UI/status visibility where appropriate, and
docs. Commit with message: `Add runaway loop guardrails`.

## Guardrail Categories

Implement hard caps for at least:

- agent runs per user per hour;
- autonomous scheduled runs per worker tick;
- MCP/tool calls per run;
- outbound owner-visible messages per user per day;
- outbound sends per worker tick;
- untrusted owner-review notifications per sender/window;
- newsletter documents considered per newsletter-interest check;
- repair attempts per run;
- maximum prompt/context excerpt sizes where not already bounded.

Some of these already exist partially. This phase should consolidate them into
named policy and make them visible.

## Desired Behavior

When a guardrail trips:

- fail closed;
- do not execute the side effect;
- record an audit event with a non-secret reason;
- return a structured failure to the caller or task event;
- avoid creating an infinite retry loop;
- expose status in `/api/v1/jobs` or the operator console when useful.

Examples:

- If the agent tries to send too many owner-visible messages in a day, further
  `propose_outbound_message` calls should return a controlled guardrail result
  instead of queuing more approvals/outbox records.
- If a scheduled task loop keeps failing and immediately rescheduling itself,
  host code should defer or disable the loop after a bounded number of failures.
- If MCP calls exceed the per-run cap, the run should fail with a clear
  `guardrail_exceeded` style reason.

## Configuration

Prefer a small, explicit config object over scattering constants. Reasonable
places:

- existing `admin_ai_config` if extending it is simple;
- a new admin/runtime safety config table if cleaner;
- environment defaults loaded into settings for local mode.

Do not overbuild a complex settings UI. A read-only display in Jobs/Workers is
acceptable for the first implementation. Admin editing can be minimal if it fits
existing patterns.

Suggested defaults are intentionally conservative but not sacred:

- 20 agent runs per user per hour;
- 10 autonomous actions per worker tick;
- existing max MCP/tool calls per run from AI config;
- 10 owner-visible outbound proposals per day;
- 1-3 outbound deliveries per worker tick;
- 5 untrusted review notifications per sender per day;
- 25 newsletter docs per interest check.

## Acceptance Criteria

- At least the major runaway paths have host-owned caps.
- Guardrail trips are audited and visible.
- Guardrail failures do not create additional unbounded work.
- Existing happy paths still pass.
- Docs explain that limits are loop protection, not precise behavioral tuning.

## Tests

Add tests for:

- agent run hourly cap blocks additional runs;
- outbound proposal daily cap blocks additional owner-visible proposals;
- MCP/tool call cap fails a run cleanly;
- scheduled task failure does not immediately loop forever;
- guardrail audit events omit secrets and include enough debugging detail;
- Jobs/Workers status includes relevant limit state if UI/API changed.

Run:

```bash
cd api && npm test -- agentRuntime.test.ts worker.test.ts approvals.test.ts domain.test.ts
cd web && npm test -- homeView.test.ts
./scripts/validate.sh
```
