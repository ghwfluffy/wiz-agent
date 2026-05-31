import type { Settings } from "../config/settings.js";
import type { AgentStore, RequestContext } from "../domain/types.js";
import type { IntegrationActionId } from "../integrations/capabilityRegistry.js";
import {
  callIntegrationActionApi,
  type IntegrationTokenProvider
} from "./integrationGateway.js";
import type { ToolName } from "./contracts.js";

export type ToolExecutionResult = {
  executed: boolean;
  sideEffect: "none" | "local_persistence" | "cross_app_api";
  result: Record<string, unknown>;
};

export async function executeToolCall(options: {
  context: RequestContext;
  store: AgentStore;
  toolName: ToolName;
  args: Record<string, unknown>;
  settings?: Settings;
  integrationTokenProvider?: IntegrationTokenProvider;
  fetchImpl?: typeof fetch;
}): Promise<ToolExecutionResult> {
  switch (options.toolName) {
    case "create_task": {
      const task = await options.store.createTask(options.context, {
        title: String(options.args.title),
        prompt: String(options.args.prompt),
        dueAt: typeof options.args.dueAt === "string" ? options.args.dueAt : null,
        priority: typeof options.args.priority === "number" ? options.args.priority : 0
      });
      return {
        executed: true,
        sideEffect: "local_persistence",
        result: {
          task_id: task.id,
          status: task.status,
          due_at: task.dueAt
        }
      };
    }
    case "propose_outbound_message": {
      const approvalRequired = options.args.approvalRequired !== false;
      const message = await options.store.queueOutboundMessage(options.context, {
        channel: String(options.args.channel) as "email" | "sms" | "mms",
        status: approvalRequired ? "requires_approval" : "pending",
        toAddr: String(options.args.to),
        subject: typeof options.args.subject === "string" ? options.args.subject : null,
        bodyText: String(options.args.body)
      });
      return {
        executed: true,
        sideEffect: "local_persistence",
        result: {
          outbound_message_id: message.id,
          status: message.status,
          approval_required: approvalRequired
        }
      };
    }
    case "record_observation":
      return {
        executed: true,
        sideEffect: "none",
        result: {
          recorded: true,
          source: options.args.source,
          summary: options.args.summary
        }
      };
    case "integration_action": {
      if (!options.settings) {
        return {
          executed: false,
          sideEffect: "none",
          result: { reason: "settings_required" }
        };
      }
      if (!options.integrationTokenProvider) {
        return {
          executed: false,
          sideEffect: "none",
          result: { reason: "integration_token_provider_required" }
        };
      }
      const response = await callIntegrationActionApi({
        settings: options.settings,
        context: options.context,
        actionId: options.args.actionId as IntegrationActionId,
        pathParams: asStringRecord(options.args.pathParams),
        query: asQueryRecord(options.args.query),
        body: options.args.body,
        tokenProvider: options.integrationTokenProvider,
        fetchImpl: options.fetchImpl
      });
      return {
        executed: response.ok,
        sideEffect: response.ok ? "cross_app_api" : "none",
        result: response.ok
          ? { status: response.status, data: response.data }
          : { reason: response.reason }
      };
    }
    default:
      return {
        executed: false,
        sideEffect: "none",
        result: { reason: "unsupported_tool" }
      };
  }
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      result[key] = item;
    }
  }
  return result;
}

function asQueryRecord(value: unknown): Record<string, string | number | boolean> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const result: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      result[key] = item;
    }
  }
  return result;
}
