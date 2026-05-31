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

The deterministic host chooses the tier before the model call. The first policy
uses `fast` by default, `smart` for ambiguous/large/retry-prone work,
`orchestrator` for bounded planning, and `repair` only for schema repair.

## Model Client Boundary

Application code depends on `AgentModelClient`, not direct SDK calls.

Implemented clients:

- `MockModelClient`: deterministic tests and local runtime development.
- `OpenAIModelClient`: explicit placeholder that fails clearly until real
  OpenAI API wiring is implemented.

This keeps real network calls out of tests and keeps OpenAI API details behind a
small adapter.

## Tool Contracts

Tool contracts are Zod schemas in code. Model outputs are validated before tool
execution. Invalid tool arguments may go through a bounded repair call that gets
the malformed payload, expected contract shape, and validation errors.

Current tool contracts:

- `create_task`
- `propose_outbound_message`
- `record_observation`

Cross-app API access is intentionally outside direct model control. The model
may request an integration action, but deterministic host code must enforce
sender trust, tenant/user scope, allowed app/action, and token availability
before any API call.

The Phase 4 runtime records accepted/rejected tool calls but does not execute
external side effects. Accepted tool calls store a result that explicitly says no
side effect was executed.

## Repair Flow

Malformed tool arguments follow this flow:

1. validate against the Zod tool schema;
2. call the repair tier with only malformed arguments, contract shape, and
   validation errors;
3. validate the repaired output with the same schema;
4. accept only valid repaired output;
5. reject and audit the tool call after the repair budget is exhausted.

The repair payload must not include secrets or raw credential references.

## Traceability

Every agent run records:

- tenant and user;
- model tier and concrete model id;
- prompt version;
- status and failure reason.

Every proposed tool call records:

- tenant and user;
- run id;
- tool name;
- validated or rejected arguments;
- validation error when rejected.

Audit events are written for run creation, run completion/failure, and tool-call
acceptance/rejection.

## Host-Owned Controls

The host owns:

- tenant and user scope;
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
