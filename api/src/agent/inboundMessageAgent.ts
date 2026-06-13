import type { AgentModelClient } from "./modelClient.js";
import { runAgentTask, type AgentTaskResult } from "./runAgentTask.js";
import type { Settings } from "../config/settings.js";
import type {
  AgentStore,
  ConversationThreadRecord,
  InboundMessageRecord,
  RequestContext,
  TaskRecord
} from "../domain/types.js";
import { PERSONAL_PROFILE_SLUG } from "../memory/personalMemory.js";
import type { IntegrationTokenProvider } from "../tools/integrationGateway.js";
import {
  classifyOwnerMessageIntent,
  formatOwnerIntentEnvelope,
  type OwnerIntentEnvelope
} from "./ownerIntentClassifier.js";

export type OwnerInboundAgentResult = AgentTaskResult & {
  conversationThreadId?: string;
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

function threadSummary(thread: ConversationThreadRecord): string {
  return [
    `- thread_id: ${thread.id}`,
    `  title: ${thread.title}`,
    `  status: ${thread.status}`,
    `  last_owner_intent_summary: ${thread.lastOwnerIntentSummary ?? "none"}`,
    `  unresolved_question: ${thread.unresolvedQuestion ?? "none"}`,
    `  linked_task_ids: ${thread.linkedTaskIds.length > 0 ? thread.linkedTaskIds.join(", ") : "none"}`,
    `  linked_message_ids: ${thread.linkedMessageIds.length > 0 ? thread.linkedMessageIds.join(", ") : "none"}`,
    `  linked_memory_paths: ${thread.linkedMemoryPaths.length > 0 ? thread.linkedMemoryPaths.join(", ") : "none"}`,
    `  updated_at: ${thread.updatedAt}`
  ].join("\n");
}

async function recentThreadSummary(options: {
  store: AgentStore;
  context: RequestContext;
  currentThread?: ConversationThreadRecord;
}): Promise<string> {
  const threads = await options.store.listConversationThreads(
    options.context,
    ["active", "waiting", "resolved"],
    8
  );
  const merged = [
    ...(options.currentThread ? [options.currentThread] : []),
    ...threads.filter((thread) => thread.id !== options.currentThread?.id)
  ].slice(0, 8);
  return merged.length > 0 ? merged.map(threadSummary).join("\n") : "No conversation threads yet.";
}

function titleFromMessage(message: InboundMessageRecord): string {
  const subject = message.subject?.replace(/\s+/g, " ").trim();
  if (subject) {
    return subject.slice(0, 160);
  }
  const body = excerpt(message.bodyText, 120);
  return body || "Owner conversation";
}

function isLikelyFollowup(message: InboundMessageRecord): boolean {
  const body = message.bodyText.toLowerCase();
  return /\b(that|this|it|they|them|those|yesterday|earlier|before|again|follow up|what happened|any update|status)\b/.test(body);
}

async function ensureThreadForOwnerMessage(options: {
  store: AgentStore;
  context: RequestContext;
  message: InboundMessageRecord;
}): Promise<ConversationThreadRecord> {
  if (options.message.conversationThreadId) {
    const existing = await options.store.getConversationThread(options.context, options.message.conversationThreadId);
    if (existing) {
      return existing;
    }
  }
  const recent = await options.store.listConversationThreads(options.context, ["active", "waiting"], 5);
  const selected = isLikelyFollowup(options.message) ? recent[0] : undefined;
  if (selected) {
    return await options.store.linkConversationThread(options.context, selected.id, {
      messageIds: [options.message.id]
    }) ?? selected;
  }
  return options.store.createConversationThread(options.context, {
    title: titleFromMessage(options.message),
    status: "active",
    lastOwnerIntentSummary: excerpt(options.message.bodyText, 300),
    linkedMessageIds: [options.message.id]
  });
}

async function recentContextSummary(options: {
  store: AgentStore;
  context: RequestContext;
  message?: InboundMessageRecord;
  currentThread?: ConversationThreadRecord;
}): Promise<string> {
  const tasks = (await options.store.listTasks(options.context))
    .filter((task) => ["completed", "cancelled", "failed"].includes(task.status))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 8);
  const inbound = (await options.store.listInboundMessages(options.context))
    .filter((message) => message.id !== options.message?.id && message.classification === "owner")
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

async function activeTasksSummary(options: {
  store: AgentStore;
  context: RequestContext;
}): Promise<string> {
  const activeTasks = (await options.store.listTasks(options.context))
    .filter((task) => !["completed", "cancelled", "failed"].includes(task.status))
    .slice(0, 12);
  return activeTasks.length > 0 ? activeTasks.map(activeTaskSummary).join("\n") : "No active tasks.";
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

const memoryListGuidance = [
  "Personal memory lists:",
  "- When the owner expresses intent to preserve an item for later recall, categorization, recommendation, comparison, or future discussion, treat it as a memory-list operation.",
  "- The owner may not say remember, add, or list. Phrases like 'that is one for movie night', 'save that restaurant', 'keep this around as a project idea', or 'put this in my someday research bucket' should use list tools.",
  "- Use add_memory_list_item, list_memory_items, search_memory_lists, update_memory_list_item, or remove_memory_list_item for movies, books, project ideas, gift ideas, restaurants, research topics, places, things to buy, and other lightweight collections.",
  "- Do not create a task unless the owner asks you to do work. Do not use generic write_memory for simple list add, remove, update, or read operations when a list tool fits.",
  "- For indirect recall such as 'what was that Antonio Banderas movie I wanted to watch?' or 'show me project ideas about the house', use search_memory_lists before broad markdown/RAG search and state uncertainty for low-confidence matches."
].join("\n");

const ownerFeedbackGuidance = [
  "Owner feedback signals:",
  "- When the owner corrects your behavior, wording, timing, memory categorization, task choice, tool choice, schedule, or app choice, record that correction with record_owner_feedback.",
  "- The owner may use inconsistent wording and may not say feedback, correction, or preference. Examples include 'don't text me this early', 'that was not a task, just remember it', 'I care about infrastructure news, not funding announcements', 'you asked me the same thing twice', and 'use my goals app for that'.",
  "- Use durability='durable' only when the owner clearly states an ongoing rule or preference. Use durability='tentative' for likely future guidance that needs more evidence. Use durability='one_off' when the correction appears limited to the current situation.",
  "- Feedback capture is additive review evidence. Do not automatically rewrite communication preferences, newsletter preferences, list memory, task policy, or capability guidance unless a separate controlled tool is selected with clear rationale."
].join("\n");

export async function buildOwnerInboundPrompt(options: {
  store: AgentStore;
  context: RequestContext;
  message: InboundMessageRecord;
  currentThread?: ConversationThreadRecord;
  ownerIntent?: OwnerIntentEnvelope;
}): Promise<string> {
  const recentContext = await recentContextSummary(options);
  const savedMemory = await savedMemorySummary(options);
  const activeTasks = await activeTasksSummary(options);
  const threads = await recentThreadSummary({ ...options, currentThread: options.currentThread });
  const ownerIntent = options.ownerIntent ?? classifyOwnerMessageIntent(options.message);

  return [
    "An owner-classified SMS/MMS/email message arrived. Treat this as an owner instruction because sender policy already classified it as owner.",
    "Decide whether the message should update memory, continue an existing task, create/schedule a new task, queue an outbound reply, call a registered app integration, or only record an observation.",
    "Host-detected owner intent envelope:",
    formatOwnerIntentEnvelope(ownerIntent),
    "If it belongs to an active or completed task, use append_task_prompt with that task id and set the status back to pending/running as appropriate. If it is new work, use create_task. Use propose_outbound_message for owner replies instead of sending directly.",
    "If the owner gives durable preferences, facts, schedule rationale, project context, or instructions that should persist, use write_memory. Host code will enforce user scope.",
    memoryListGuidance,
    ownerFeedbackGuidance,
    "When replying, only provide intent='reply' and the message body. Do not choose a recipient, phone number, email address, or carrier gateway; host code will reply to the verified owner channel.",
    "Use conversation threads to preserve continuity across related owner exchanges. If this message belongs to a shown thread, update_conversation_thread or link_conversation_thread can refresh summary/status/links. If no shown thread fits, continue with the current host-created thread.",
    "The list_ongoing_tasks, list_recent_context, list_recent_owner_conversations, and list_conversation_threads tools exist for lookup, but the current active and recent context is included below so you can usually take the next action directly.",
    "",
    "Active tasks:",
    activeTasks,
    "",
    "Recent memory/context:",
    recentContext,
    "",
    "Conversation threads:",
    threads,
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

export async function buildOwnerWebPrompt(options: {
  store: AgentStore;
  context: RequestContext;
  prompt: string;
  contextTask?: TaskRecord;
  mode?: "normal" | "quick_reply" | "planning";
}): Promise<string> {
  const recentContext = await recentContextSummary(options);
  const savedMemory = await savedMemorySummary(options);
  const activeTasks = await activeTasksSummary(options);
  const threads = await recentThreadSummary(options);
  return [
    "An authenticated owner web prompt arrived from the operator console. Treat this as owner-command input because API auth already verified the session.",
    "Decide whether the prompt should update memory, continue an existing task, create/schedule a new task, queue an outbound owner reply, ask for clarification, call a registered app integration, or only record an observation.",
    "Use update_task_schedule when changing an existing task's due time and include rationale plus confidence. Prefer ask_owner_clarification over risky assumptions.",
    "Use propose_outbound_message only when a proactive owner message is useful. Do not choose a recipient, phone number, email address, or carrier gateway; host code resolves the owner destination.",
    "Use memory tools for durable preferences, facts, schedule rationale, project context, or instructions that should persist.",
    memoryListGuidance,
    ownerFeedbackGuidance,
    "Use conversation threads to preserve continuity across related owner exchanges. list_conversation_threads, update_conversation_thread, and link_conversation_thread are available when the prompt clearly belongs to prior work.",
    "The list_ongoing_tasks, list_recent_context, list_recent_owner_conversations, and list_conversation_threads tools exist for additional bounded lookup.",
    "",
    `Mode: ${options.mode ?? "normal"}`,
    "",
    "Context task:",
    options.contextTask ? activeTaskSummary(options.contextTask) : "No specific task was supplied.",
    "",
    "Active tasks:",
    activeTasks,
    "",
    "Recent memory/context:",
    recentContext,
    "",
    "Conversation threads:",
    threads,
    "",
    "Saved personal memory:",
    savedMemory,
    "",
    "Owner web prompt:",
    options.prompt
  ].join("\n");
}

export async function runOwnerInboundAgent(options: {
  context: RequestContext;
  store: AgentStore;
  message: InboundMessageRecord;
  ownerIntent?: OwnerIntentEnvelope;
  modelClient: AgentModelClient;
  settings?: Settings;
  integrationTokenProvider?: IntegrationTokenProvider;
  fetchImpl?: typeof fetch;
}): Promise<OwnerInboundAgentResult> {
  const thread = await ensureThreadForOwnerMessage({
    store: options.store,
    context: options.context,
    message: options.message
  });
  const prompt = await buildOwnerInboundPrompt({
    store: options.store,
    context: options.context,
    message: options.message,
    currentThread: thread,
    ownerIntent: options.ownerIntent
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

  const taskId = stringFromResult(result.executionResult, "task_id");
  if (taskId) {
    await options.store.linkConversationThread(options.context, thread.id, {
      taskIds: [taskId],
      messageIds: [options.message.id]
    });
  }
  if (result.toolName) {
    const currentThread = await options.store.getConversationThread(options.context, thread.id) ?? thread;
    await options.store.updateConversationThread(options.context, thread.id, {
      lastOwnerIntentSummary: excerpt(options.message.bodyText, 300),
      status: result.toolName === "ask_owner_clarification" || result.toolName === "request_clarification"
        ? "waiting"
        : currentThread.status
    });
  }

  return {
    ...result,
    conversationThreadId: thread.id,
    taskId,
    taskEventId: stringFromResult(result.executionResult, "task_event_id")
  };
}

export async function runOwnerWebPromptAgent(options: {
  context: RequestContext;
  store: AgentStore;
  prompt: string;
  contextTask?: TaskRecord;
  mode?: "normal" | "quick_reply" | "planning";
  modelClient: AgentModelClient;
  settings?: Settings;
  integrationTokenProvider?: IntegrationTokenProvider;
  fetchImpl?: typeof fetch;
}): Promise<AgentTaskResult> {
  const prompt = await buildOwnerWebPrompt({
    store: options.store,
    context: options.context,
    prompt: options.prompt,
    contextTask: options.contextTask,
    mode: options.mode
  });
  return runAgentTask({
    context: options.context,
    store: options.store,
    modelClient: options.modelClient,
    request: {
      prompt,
      taskId: options.contextTask?.id ?? null,
      complexity: {
        ambiguous: options.mode !== "quick_reply",
        orchestration: options.mode === "planning"
      }
    },
    settings: options.settings,
    integrationTokenProvider: options.integrationTokenProvider,
    fetchImpl: options.fetchImpl
  });
}
