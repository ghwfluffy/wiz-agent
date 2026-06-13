import type { AgentModelClient } from "./modelClient.js";
import { runAgentTask, type AgentTaskResult } from "./runAgentTask.js";
import type { Settings } from "../config/settings.js";
import type { AgentStore, InboundMessageRecord, RequestContext, TaskRecord } from "../domain/types.js";
import { PERSONAL_PROFILE_SLUG } from "../memory/personalMemory.js";
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

function excerpt(value: string | null | undefined, length: number): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, length);
}

async function recentContextSummary(options: {
  store: AgentStore;
  context: RequestContext;
  message: InboundMessageRecord;
}): Promise<string> {
  const tasks = (await options.store.listTasks(options.context))
    .filter((task) => ["completed", "cancelled", "failed"].includes(task.status))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 8);
  const inbound = (await options.store.listInboundMessages(options.context))
    .filter((message) => message.id !== options.message.id && message.classification === "owner")
    .slice(0, 8);
  const outbound = (await options.store.listOutboundMessages(options.context))
    .slice(0, 8);

  const taskLines = tasks.map((task) => [
    `- completed_task_id: ${task.id}`,
    `  title: ${task.title}`,
    `  status: ${task.status}`,
    `  updated_at: ${task.updatedAt}`,
    `  prompt_excerpt: ${excerpt(task.prompt, 220)}`
  ].join("\n"));
  const inboundLines = inbound.map((message) => [
    `- prior_owner_message_id: ${message.id}`,
    `  source: ${message.source ?? "imap"}`,
    `  received_at: ${message.receivedAt ?? message.createdAt}`,
    `  handling_action: ${message.handlingAction ?? "unknown"}`,
    `  task_id: ${message.taskId ?? "none"}`,
    `  body_excerpt: ${excerpt(message.bodyText, 220)}`
  ].join("\n"));
  const outboundLines = outbound.map((message) => [
    `- outbound_message_id: ${message.id}`,
    `  channel: ${message.channel}`,
    `  status: ${message.status}`,
    `  created_at: ${message.createdAt}`,
    `  body_excerpt: ${excerpt(message.bodyText, 220)}`
  ].join("\n"));

  return [
    "Recently completed/cancelled/failed tasks:",
    taskLines.length > 0 ? taskLines.join("\n") : "None.",
    "",
    "Recent prior owner messages:",
    inboundLines.length > 0 ? inboundLines.join("\n") : "None.",
    "",
    "Recent outbound messages:",
    outboundLines.length > 0 ? outboundLines.join("\n") : "None."
  ].join("\n");
}

async function savedMemorySummary(options: {
  store: AgentStore;
  context: RequestContext;
}): Promise<string> {
  const documents = await Promise.all([
    options.store.getMemoryDocument(options.context, PERSONAL_PROFILE_SLUG),
    options.store.getMemoryDocument(options.context, "newsletter-preferences")
  ]);
  const lines = documents
    .filter((document) => document && document.body.trim())
    .map((document) => [
      `## ${document!.title}`,
      document!.body.trim().slice(0, 1800)
    ].join("\n"));
  return lines.length > 0 ? lines.join("\n\n") : "No saved personal memory yet.";
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
  const recentContext = await recentContextSummary(options);
  const savedMemory = await savedMemorySummary(options);

  return [
    "An owner-classified SMS/MMS/email message arrived. Treat this as an owner instruction because sender policy already classified it as owner.",
    "Decide whether the message should update memory, continue an existing task, create/schedule a new task, queue an outbound reply, call a registered app integration, or only record an observation.",
    "If it belongs to an active or completed task, use append_task_prompt with that task id and set the status back to pending/running as appropriate. If it is new work, use create_task. Use propose_outbound_message for owner replies instead of sending directly.",
    "If the owner gives durable preferences, facts, schedule rationale, project context, or instructions that should persist, use write_memory. Host code will enforce user scope.",
    "When replying, only provide intent='reply' and the message body. Do not choose a recipient, phone number, email address, or carrier gateway; host code will reply to the verified owner channel.",
    "The list_ongoing_tasks, list_recent_context, and list_recent_owner_conversations tools exist for lookup, but the current active and recent context is included below so you can usually take the next action directly.",
    "",
    "Active tasks:",
    activeTasks.length > 0 ? activeTasks.map(activeTaskSummary).join("\n") : "No active tasks.",
    "",
    "Recent memory/context:",
    recentContext,
    "",
    "Saved personal memory:",
    savedMemory,
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
      complexity: { ambiguous: true },
      replyToMessage: options.message
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
