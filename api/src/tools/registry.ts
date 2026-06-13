import type { Settings } from "../config/settings.js";
import type { AgentStore, InboundMessageRecord, RequestContext } from "../domain/types.js";
import type { IntegrationTokenProvider } from "./integrationGateway.js";
import { ToolContracts, type ToolName } from "./contracts.js";
import { executeToolCall, type ToolExecutionResult } from "./toolExecutor.js";

export type ToolAccess = "read" | "write";
export type ToolRisk = "low" | "medium" | "high";
export type ToolSideEffect = "none" | "local_persistence" | "cross_app_api";

export type ToolExecutionContext = {
  context: RequestContext;
  store: AgentStore;
  runId?: string | null;
  settings?: Settings;
  integrationTokenProvider?: IntegrationTokenProvider;
  fetchImpl?: typeof fetch;
  replyToMessage?: Pick<InboundMessageRecord, "fromAddr" | "source" | "subject">;
};

export type ToolDefinition = {
  name: ToolName;
  schema: (typeof ToolContracts)[ToolName];
  access: ToolAccess;
  risk: ToolRisk;
  sideEffect: ToolSideEffect;
  execute(context: ToolExecutionContext, args: Record<string, unknown>): Promise<ToolExecutionResult>;
};

const metadata: Record<ToolName, Pick<ToolDefinition, "access" | "risk" | "sideEffect">> = {
  create_task: { access: "write", risk: "medium", sideEffect: "local_persistence" },
  list_ongoing_tasks: { access: "read", risk: "low", sideEffect: "none" },
  list_recent_context: { access: "read", risk: "low", sideEffect: "none" },
  list_recent_owner_conversations: { access: "read", risk: "low", sideEffect: "none" },
  get_recent_bot_activity: { access: "read", risk: "low", sideEffect: "none" },
  list_app_capabilities: { access: "read", risk: "low", sideEffect: "none" },
  list_goals: { access: "read", risk: "low", sideEffect: "cross_app_api" },
  create_goal: { access: "write", risk: "medium", sideEffect: "local_persistence" },
  update_goal: { access: "write", risk: "medium", sideEffect: "local_persistence" },
  complete_goal_checklist_item: { access: "write", risk: "medium", sideEffect: "local_persistence" },
  list_goal_metrics: { access: "read", risk: "low", sideEffect: "cross_app_api" },
  record_goal_metric_entry: { access: "write", risk: "medium", sideEffect: "local_persistence" },
  list_goal_notifications: { access: "read", risk: "low", sideEffect: "cross_app_api" },
  complete_goal_notification: { access: "write", risk: "medium", sideEffect: "local_persistence" },
  list_budget_accounts: { access: "read", risk: "low", sideEffect: "cross_app_api" },
  get_budget_account: { access: "read", risk: "low", sideEffect: "cross_app_api" },
  record_budget_account_value: { access: "write", risk: "high", sideEffect: "local_persistence" },
  get_net_worth_history: { access: "read", risk: "low", sideEffect: "cross_app_api" },
  get_net_worth_forecast: { access: "read", risk: "low", sideEffect: "cross_app_api" },
  list_budget_transfers: { access: "read", risk: "low", sideEffect: "cross_app_api" },
  list_budget_contracts: { access: "read", risk: "low", sideEffect: "cross_app_api" },
  create_budget_contract: { access: "write", risk: "high", sideEffect: "local_persistence" },
  update_budget_contract: { access: "write", risk: "high", sideEffect: "local_persistence" },
  delete_budget_contract: { access: "write", risk: "high", sideEffect: "local_persistence" },
  list_budget_expenses: { access: "read", risk: "low", sideEffect: "cross_app_api" },
  create_budget_expense: { access: "write", risk: "high", sideEffect: "local_persistence" },
  update_budget_expense: { access: "write", risk: "high", sideEffect: "local_persistence" },
  delete_budget_expense: { access: "write", risk: "high", sideEffect: "local_persistence" },
  list_budget_investments: { access: "read", risk: "low", sideEffect: "cross_app_api" },
  list_budget_audit_logs: { access: "read", risk: "low", sideEffect: "cross_app_api" },
  write_memory: { access: "write", risk: "medium", sideEffect: "local_persistence" },
  write_file: { access: "write", risk: "medium", sideEffect: "local_persistence" },
  append_task_prompt: { access: "write", risk: "medium", sideEffect: "local_persistence" },
  update_task_schedule: { access: "write", risk: "medium", sideEffect: "local_persistence" },
  update_task_status: { access: "write", risk: "medium", sideEffect: "local_persistence" },
  split_task: { access: "write", risk: "medium", sideEffect: "local_persistence" },
  create_followup_task: { access: "write", risk: "medium", sideEffect: "local_persistence" },
  mark_waiting_on: { access: "write", risk: "medium", sideEffect: "local_persistence" },
  request_clarification: { access: "write", risk: "medium", sideEffect: "local_persistence" },
  record_schedule_rationale: { access: "write", risk: "medium", sideEffect: "local_persistence" },
  propose_outbound_message: { access: "write", risk: "high", sideEffect: "local_persistence" },
  ask_owner_clarification: { access: "write", risk: "medium", sideEffect: "local_persistence" },
  record_observation: { access: "write", risk: "low", sideEffect: "none" },
  integration_action: { access: "write", risk: "high", sideEffect: "cross_app_api" }
};

export const ToolRegistry = Object.fromEntries(
  Object.entries(ToolContracts).map(([name, schema]) => {
    const toolName = name as ToolName;
    return [
      toolName,
      {
        name: toolName,
        schema,
        ...metadata[toolName],
        execute: (context: ToolExecutionContext, args: Record<string, unknown>) => executeToolCall({
          ...context,
          toolName,
          args
        })
      } satisfies ToolDefinition
    ];
  })
) as Record<ToolName, ToolDefinition>;

export function listToolDefinitions(): ToolDefinition[] {
  return Object.values(ToolRegistry);
}

export function modelToolDescriptors(): unknown[] {
  return listToolDefinitions().map((tool) => ({
    name: tool.name,
    schema: tool.schema.toJSONSchema(),
    access: tool.access,
    risk: tool.risk,
    sideEffect: tool.sideEffect
  }));
}

export function mcpToolDescriptors(): unknown[] {
  return modelToolDescriptors();
}

export function agentToolNames(): ToolName[] {
  return listToolDefinitions().map((tool) => tool.name);
}
