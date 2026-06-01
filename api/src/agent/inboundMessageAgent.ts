import type { AgentModelClient } from "./modelClient.js";
import { runAgentTask, type AgentTaskResult } from "./runAgentTask.js";
import type { Settings } from "../config/settings.js";
import type { AgentStore, InboundMessageRecord, RequestContext, TaskRecord } from "../domain/types.js";
import type { IntegrationTokenProvider } from "../tools/integrationGateway.js";

export type OwnerInboundAgentResult = AgentTaskResult & {
  taskId?: string;
  taskEventId?: string;
};

function activeTaskSummary(task: TaskRecord): string {
  return [
    `- id: ${task.id}`,
    `  title: ${task.title}`,
    `  status: ${task.status}`,
    `  due_at: ${task.dueAt ?? "not set"}`,
    `  priority: ${task.priority}`,
    `  prompt_excerpt: ${task.prompt.replace(/\s+/g, " ").slice(0, 260)}`
  ].join("\n");
}

function stringFromResult(result: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = result?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

export async function buildOwnerInboundPrompt(options: {
  store: AgentStore;
  context: RequestContext;
  message: InboundMessageRecord;
}): Promise<string> {
  const activeTasks = (await options.store.listTasks(options.context))
    .filter((task) => !["completed", "cancelled", "failed"].includes(task.status))
    .slice(0, 12);

  return [
    "An owner-classified SMS/MMS/email message arrived. Treat this as an owner instruction because sender policy already classified it as owner.",
    "Decide whether the message belongs to an existing active task or should create/schedule a new task, queue an outbound reply, call a registered app integration, or only record an observation.",
    "If it belongs to an active task, use append_task_prompt with that task id. If it is new work, use create_task. Use propose_outbound_message for replies instead of sending directly.",
    "The list_ongoing_tasks tool exists for task lookup, but the current active task context is included below so you can usually take the next action directly.",
    "",
    "Active tasks:",
    activeTasks.length > 0 ? activeTasks.map(activeTaskSummary).join("\n") : "No active tasks.",
    "",
    "Inbound message:",
    `message_id: ${options.message.id}`,
    `source: ${options.message.source ?? "imap"}`,
    `from: ${options.message.fromAddr}`,
    `to: ${options.message.toAddr}`,
    `received_at: ${options.message.receivedAt ?? options.message.createdAt}`,
    `subject: ${options.message.subject ?? "(none)"}`,
    "body:",
    options.message.bodyText
  ].join("\n");
}

export async function runOwnerInboundAgent(options: {
  context: RequestContext;
  store: AgentStore;
  message: InboundMessageRecord;
  modelClient: AgentModelClient;
  settings?: Settings;
  integrationTokenProvider?: IntegrationTokenProvider;
  fetchImpl?: typeof fetch;
}): Promise<OwnerInboundAgentResult> {
  const prompt = await buildOwnerInboundPrompt({
    store: options.store,
    context: options.context,
    message: options.message
  });
  const result = await runAgentTask({
    context: options.context,
    store: options.store,
    modelClient: options.modelClient,
    request: {
      prompt,
      complexity: { ambiguous: true }
    },
    settings: options.settings,
    integrationTokenProvider: options.integrationTokenProvider,
    fetchImpl: options.fetchImpl
  });

  return {
    ...result,
    taskId: stringFromResult(result.executionResult, "task_id"),
    taskEventId: stringFromResult(result.executionResult, "task_event_id")
  };
}
