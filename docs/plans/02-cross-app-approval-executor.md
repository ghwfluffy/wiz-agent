# Phase 02: Approved Cross-App Write Executor

## Goal

Make approved cross-app write approvals executable while preserving the existing
host-owned approval and capability boundaries.

Today cross-app write proposals are queued and audited as approvals. This phase
adds a deterministic executor for approvals that have been approved by the
owner/admin. The model must still never call registered apps directly for
high-risk writes.

## Sub-Agent Prompt

Implement Phase 02 from `docs/plans/02-cross-app-approval-executor.md`.
Read `docs/plans/README.md`, `docs/architecture/50-agent-runtime.md`,
`docs/architecture/60-connectors-and-side-effects.md`,
`docs/architecture/70-app-capability-registry.md`, and
`docs/architecture/80-observability-and-safety.md`.

Add approved cross-app write execution, tests, and docs. Commit with message:
`Execute approved cross-app write approvals`.

## Desired Behavior

When an approval with `actionType = cross_app_write_action` is approved:

- the approval should not execute inside model/MCP code;
- host code should rehydrate the stored proposal;
- host code should re-validate the action id against
  `api/src/integrations/capabilityRegistry.ts`;
- only registered write actions should execute from this path;
- host code should mint or fetch the integration token server-side;
- the app API call should be made through the existing integration gateway;
- responses should be redacted before persistence/audit/model visibility;
- success/failure should be persisted in an auditable way;
- retries should be explicit and bounded.

Execution can happen immediately after approval or via worker queue. Prefer a
worker-mediated approach if it fits existing patterns because it keeps side
effects in the background path and gives natural retry/visibility hooks.

## Data Model

Use existing approval fields when possible:

- `proposedPayload.action_id`
- `proposedPayload.path_params`
- `proposedPayload.query`
- `proposedPayload.body`
- `sourceRunId`
- `sourceRef`

If durable execution result needs a new table or approval columns, add a
migration and update `docs/architecture/30-domain-model.md`.

Suggested result fields if extending approvals:

- `execution_status`: `not_applicable`, `pending`, `running`, `succeeded`,
  `failed`
- `execution_result_json`
- `execution_error`
- `executed_at`

Do not store bearer tokens or secrets.

## Safety Rules

- Re-validate action id and access level at execution time.
- Reject directory-only apps such as Apartment Gate.
- Reject read actions from this executor; read actions should be performed by
  normal read tools, not approvals.
- Reject if integration token config is unavailable.
- Reject if approval is expired, rejected, already executed, or belongs to a
  different user.
- Preserve the original approval audit trail.
- Do not let request payloads override user id, app base URL, or auth headers.

## UI

The Approval inbox should show cross-app approval status:

- proposed action id;
- owner summary;
- approved/rejected state;
- execution pending/running/succeeded/failed;
- redacted result or failure reason when available.

If implementing manual retry, show retry only to admins or owner-authorized
sessions according to existing admin patterns.

## Acceptance Criteria

- Approving a cross-app write can execute the stored proposal through host code.
- Execution result is visible in audit/logs and the approval UI.
- Failed execution does not lose the approval record.
- Re-approval or duplicate worker ticks do not execute the same approval twice.
- Directory-only app capabilities cannot be executed.
- Existing outbound approval behavior remains unchanged.

## Tests

Add tests for:

- approved cross-app write executes with signed/scoped token and allowlisted
  endpoint;
- execution result is redacted before storage;
- directory-only app or unknown action fails closed;
- duplicate execution is prevented;
- expired/rejected approval does not execute;
- missing integration token records a visible failure;
- UI renders cross-app execution state if frontend is changed.

Run:

```bash
cd api && npm test -- approvals.test.ts agentRuntime.test.ts
cd web && npm test -- homeView.test.ts
./scripts/validate.sh
```
