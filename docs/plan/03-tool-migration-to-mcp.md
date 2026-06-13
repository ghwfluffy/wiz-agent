# Phase 03: Migrate Local Tool Calls To MCP

## Goal

Move the model-facing tool surface from direct local function execution to the
server-owned MCP boundary. The model should call MCP tools; MCP should resolve
the authenticated agent run to the correct user, validate arguments, execute
host-owned behavior, and return audited results.

## Current Starting Point

Today, tools are not MCP-driven. The current flow is:

1. `api/src/agent/promptContext.ts` exposes tool descriptors from
   `api/src/tools/contracts.ts`.
2. The model returns a tool proposal.
3. `api/src/tools/validator.ts` validates arguments with Zod and may repair
   malformed arguments.
4. `api/src/tools/toolExecutor.ts` executes the action directly in process.

Current local tools:

- `create_task`
- `list_ongoing_tasks`
- `list_recent_context`
- `list_recent_owner_conversations`
- `write_memory`
- `append_task_prompt`
- `propose_outbound_message`
- `record_observation`
- `integration_action`

The MCP server currently exists as a scaffold in `api/src/mcp/server.ts`.

## Target Architecture

Agent runtime:

1. Host creates an agent run.
2. Host creates a short-lived MCP session bound to:
   - user id
   - run id
   - actor type
   - allowed tool names
   - expiration
3. Prompt tells the model about MCP tools.
4. Model requests a tool call.
5. Runtime sends the call to MCP.
6. MCP resolves session to user/run context.
7. MCP validates arguments.
8. MCP executes host-owned domain logic.
9. MCP records tool call/audit data.
10. Runtime records the model/run result.

The model must never supply user id, tenant id, collection name, credentials,
or outbound recipient.

## Migration Strategy

Use a staged migration so behavior remains testable:

### Step 1: Shared Tool Registry

Create a shared registry module that can produce:

- model-facing descriptors
- MCP tool descriptors
- Zod validation schemas
- host execution handler mapping
- risk metadata
- side-effect classification

Do not duplicate schemas in separate local and MCP layers.

Recommended shape:

```ts
type ToolDefinition = {
  name: string;
  schema: z.ZodType;
  access: "read" | "write";
  risk: "low" | "medium" | "high";
  sideEffect: "none" | "local_persistence" | "cross_app_api";
  execute(context, args): Promise<ToolExecutionResult>;
};
```

### Step 2: MCP Session Auth

Implement MCP session creation:

- `createMcpSession(context, runId, allowedTools, expiresAt)`
- signed token or opaque token stored server-side
- one user/run per session
- short expiration
- revoke/expire on run completion when practical

MCP request handling must reject:

- missing token
- expired token
- token for another run when run binding is required
- tool not in allowed list
- malformed arguments

### Step 3: MCP Tool Endpoints

Implement tool list and call endpoints. If using a full MCP protocol library,
adapt these semantics to that library. If starting with an internal HTTP MCP
facade, use:

- `GET /mcp/v1/tools`
- `POST /mcp/v1/tools/:name/call`

Every call should return a structured payload:

```json
{
  "ok": true,
  "tool": "write_memory",
  "sideEffect": "local_persistence",
  "result": {}
}
```

Errors should be structured and should not leak secrets.

### Step 4: Runtime Adapter

Add an `AgentToolClient` boundary:

- `LocalToolClient` uses current in-process executor for tests/fallback.
- `McpToolClient` calls MCP.

Change `runAgentTask` so it depends on `AgentToolClient`, not directly on
`executeToolCall`.

During migration, tests can use `LocalToolClient`, while integration tests cover
`McpToolClient`.

### Step 5: Move Existing Tools

Migrate each current local tool one by one:

- `list_ongoing_tasks`: read-only, low risk.
- `list_recent_context`: read-only, low risk.
- `list_recent_owner_conversations`: read-only, low risk.
- `record_observation`: local persistence or run result only, low risk.
- `write_memory`: local persistence, medium risk.
- `append_task_prompt`: local persistence, medium risk.
- `create_task`: local persistence, medium risk.
- `propose_outbound_message`: outbox side effect, medium/high depending on
  approval policy.
- `integration_action`: cross-app API, medium/high, allowlist required.

Each migration should preserve existing tool-call records and audit semantics.

### Step 6: Deprecate Direct Execution

After all tools have MCP coverage:

- keep `LocalToolClient` only for deterministic unit tests.
- stop exposing local executor as the production runtime path.
- update docs to say current tools are MCP-driven.
- remove direct imports from runtime to `toolExecutor` where possible.

## Tool-Specific Requirements

### Read-Only Context Tools

Must enforce user scope and result limits:

- `list_ongoing_tasks`
- `list_recent_context`
- `list_recent_owner_conversations`

Do not return raw secrets, connector passwords, or unrelated users' data.

### Memory Tool

`write_memory` should eventually write to the markdown filesystem, not legacy
`memory_documents` directly. Until phase 01 is fully complete, it can call the
compatibility layer.

Arguments:

```ts
{
  slugOrPath: string,
  title?: string,
  appendMarkdown: string,
  rationale: string
}
```

Prefer path-based arguments once the markdown filesystem exists.

### Task Tools

Task tools should record task events:

- task created
- prompt appended
- schedule changed
- status changed
- split/follow-up created

Schedule-changing tools must require rationale.

### Outbound Tool

`propose_outbound_message` must keep the current safety rule:

- model supplies intent/body/optional subject/approval preference only.
- host resolves recipient from verified owner context or owner-contact config.
- no model-selected recipient.

### Integration Tool

`integration_action` must enforce:

- capability registry allowlist.
- current user scope.
- token availability.
- approval policy for write/high-risk actions.
- redacted response summaries.

## Tests

Backend unit tests:

- MCP rejects unauthenticated calls.
- MCP rejects expired sessions.
- MCP rejects tools outside allowed set.
- MCP validates malformed arguments.
- MCP read tools are user-scoped.
- MCP write tools create audit/tool-call records.
- `McpToolClient` returns same result shape as `LocalToolClient`.

Runtime tests:

- `runAgentTask` can execute via `LocalToolClient`.
- `runAgentTask` can execute via `McpToolClient` with mock fetch/MCP server.
- rejected MCP validation marks tool call rejected.
- MCP tool failure marks agent run failed or records a controlled tool failure,
  according to existing runtime semantics.

Regression tests:

- existing local tool behavior remains covered during migration.
- no live network calls in tests.

## Docs

Update:

- `docs/architecture/50-agent-runtime.md`
- `docs/architecture/60-connectors-and-side-effects.md`
- `docs/architecture/90-testing-and-quality.md`
- `docs/development.md`

Docs must clearly distinguish:

- local test fallback
- production MCP runtime path
- MCP server's authorization boundary

## Completion Criteria

- Every current local tool has an MCP equivalent.
- Agent runtime can use MCP for tool execution.
- Local executor is no longer the production runtime path.
- MCP sessions are user/run scoped and tested.
- Existing behavior tests still pass.
- `./scripts/validate.sh` passes.
