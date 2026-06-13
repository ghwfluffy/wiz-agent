import type { Hono } from "hono";
import type { Settings } from "../config/settings.js";
import type { AgentStore, InboundMessageRecord, RequestContext } from "../domain/types.js";
import { buildMcpApp } from "../mcp/server.js";
import type { ToolName } from "../tools/contracts.js";
import type { IntegrationTokenProvider } from "../tools/integrationGateway.js";
import { executeToolCall, type ToolExecutionResult } from "../tools/toolExecutor.js";
import { agentToolNames } from "../tools/registry.js";

export type AgentToolClientExecuteInput = {
  context: RequestContext;
  store: AgentStore;
  runId: string;
  toolName: ToolName;
  args: Record<string, unknown>;
  settings?: Settings;
  integrationTokenProvider?: IntegrationTokenProvider;
  fetchImpl?: typeof fetch;
  replyToMessage?: Pick<InboundMessageRecord, "fromAddr" | "source" | "subject">;
};

export type AgentToolClient = {
  execute(input: AgentToolClientExecuteInput): Promise<ToolExecutionResult>;
};

export class LocalToolClient implements AgentToolClient {
  async execute(input: AgentToolClientExecuteInput): Promise<ToolExecutionResult> {
    return executeToolCall({
      context: input.context,
      store: input.store,
      toolName: input.toolName,
      args: input.args,
      settings: input.settings,
      integrationTokenProvider: input.integrationTokenProvider,
      fetchImpl: input.fetchImpl,
      replyToMessage: input.replyToMessage
    });
  }
}

export class McpToolClient implements AgentToolClient {
  private readonly app?: Hono;

  constructor(options: { app?: Hono } = {}) {
    this.app = options.app;
  }

  async execute(input: AgentToolClientExecuteInput): Promise<ToolExecutionResult> {
    const session = await input.store.createAgentMcpSession(input.context, {
      runId: input.runId,
      ttlSeconds: 120,
      allowedTools: agentToolNames()
    });
    const response = await this.request(input, session.token);
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      const error = typeof body.error === "object" && body.error !== null
        ? body.error as { message?: unknown; code?: unknown }
        : {};
      throw new Error(typeof error.message === "string" ? error.message : `MCP tool ${input.toolName} failed.`);
    }
    const result = typeof body.result === "object" && body.result !== null ? body.result as Record<string, unknown> : {};
    return {
      executed: body.ok === true,
      sideEffect: body.sideEffect === "local_persistence" || body.sideEffect === "cross_app_api" ? body.sideEffect : "none",
      result
    };
  }

  private async request(input: AgentToolClientExecuteInput, token: string): Promise<Response> {
    const path = `/mcp/v1/tools/${input.toolName}/call`;
    const init = {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "x-agent-run-id": input.runId,
        "content-type": "application/json"
      },
      body: JSON.stringify(input.args)
    };
    const app = this.app ?? buildMcpApp({
      settings: input.settings,
      store: input.store,
      integrationTokenProvider: input.integrationTokenProvider,
      fetchImpl: input.fetchImpl,
      replyToMessage: input.replyToMessage
    });
    return app.request(path, init);
  }
}
