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

## Tool Contracts

Tool contracts are Zod schemas in code. Model outputs are validated before tool
execution. Invalid tool arguments may go through a bounded repair call that gets
the malformed payload, expected contract shape, and validation errors.

Current tool contracts:

- `create_task`
- `list_ongoing_tasks`
- `append_task_prompt`
- `propose_outbound_message`
- `record_observation`
- `integration_action`

Cross-app API access is intentionally outside direct model control. The model
may request an integration action, but deterministic host code must enforce
sender trust, user scope, allowed app/action, and token availability before any
API call.

The runtime includes the app capability registry in the model prompt so the
model knows what Goals and Fluffynomics are for and which actions are available.
Accepted local tool calls now execute through deterministic host code:

- `create_task` creates a user-scoped task.
- `list_ongoing_tasks` returns active user-scoped tasks without side effects.
- `append_task_prompt` appends owner follow-up context to an existing task,
  returns it to active work, and writes a task event.
- `propose_outbound_message` queues an outbound message rather than sending it.
- `record_observation` records the accepted observation in the tool-call result.

`integration_action` resolves through the registered app capability allowlist
and then through the scoped integration gateway. It fails closed unless settings
and signed agent-token configuration are supplied by host code.

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

Owner inbound SMS/MMS/email handling uses the same runtime boundary. After
sender policy classifies a message as `owner`, host code builds an inbound
prompt that includes a bounded list of active tasks. The model can then choose
to append the message to an existing task, create/schedule a new task, queue a
reply, call a registered app integration, or record an observation. The inbox
record is updated with the agent run id and any linked task/task-event ids so
the UI can show what the message triggered.

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
