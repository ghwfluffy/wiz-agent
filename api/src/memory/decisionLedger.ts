import type { AgentStore, MarkdownConflict, MarkdownDocumentRecord, RequestContext, TaskEventRecord, TaskRecord, ToolCallRecord } from "../domain/types.js";

export function decisionLedgerPath(date = new Date()): string {
  return `/assistant/decisions/${date.toISOString().slice(0, 7)}.md`;
}

type DecisionLinks = {
  runId?: string | null;
  toolCallId?: string | null;
  taskId?: string | null;
  taskEventId?: string | null;
  messageId?: string | null;
  outboundMessageId?: string | null;
  approvalId?: string | null;
  markdownPath?: string | null;
  actionId?: string | null;
};

type DecisionEntry = {
  markerId: string;
  trigger: string;
  action: string;
  alternative?: string | null;
  contextSummary: string;
  rationale: string;
  links?: DecisionLinks;
  sideEffectStatus: string;
  recordedAt?: Date;
};

const MEANINGFUL_TOOL_NAMES = new Set([
  "create_task",
  "write_file",
  "record_owner_feedback",
  "add_memory_list_item",
  "update_memory_list_item",
  "remove_memory_list_item",
  "append_task_prompt",
  "update_task_schedule",
  "update_task_status",
  "split_task",
  "create_followup_task",
  "mark_waiting_on",
  "request_clarification",
  "record_schedule_rationale",
  "propose_outbound_message",
  "ask_owner_clarification",
  "record_observation",
  "integration_action",
  "create_goal",
  "update_goal",
  "complete_goal_checklist_item",
  "record_goal_metric_entry",
  "complete_goal_notification",
  "record_budget_account_value",
  "create_budget_contract",
  "update_budget_contract",
  "delete_budget_contract",
  "create_budget_expense",
  "update_budget_expense",
  "delete_budget_expense"
]);

function isConflict(value: MarkdownDocumentRecord | MarkdownConflict): value is MarkdownConflict {
  return "code" in value && value.code === "conflict";
}

function compact(value: unknown, limit = 360): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, limit) : null;
}

function stringValue(record: Record<string, unknown>, key: string): string | null {
  return compact(record[key]);
}

function resultObject(toolCall: ToolCallRecord): Record<string, unknown> {
  const execution = toolCall.result.execution;
  return typeof execution === "object" && execution !== null ? execution as Record<string, unknown> : {};
}

function linkLines(links: DecisionLinks | undefined): string[] {
  const entries = Object.entries(links ?? {})
    .filter(([, value]) => typeof value === "string" && value.trim())
    .map(([key, value]) => `- ${key}: ${value}`);
  return entries.length > 0 ? entries : ["- none"];
}

function initialDocument(path: string): string {
  const month = path.match(/(\d{4}-\d{2})\.md$/)?.[1] ?? "Unknown";
  return [
    `# Assistant Decisions: ${month}`,
    "",
    "Deterministic host-written ledger of meaningful assistant decisions, tool proposals, and scheduled outcomes.",
    "Entries are based on persisted run, task, tool, message, approval, and markdown records."
  ].join("\n");
}

function buildEntry(input: DecisionEntry): string {
  const recordedAt = input.recordedAt ?? new Date();
  return [
    `<!-- assistant-decision:${input.markerId} -->`,
    `## ${recordedAt.toISOString()} - ${input.action}`,
    "",
    `- Timestamp: ${recordedAt.toISOString()}`,
    `- Trigger/source: ${input.trigger}`,
    `- Action chosen: ${input.action}`,
    `- Alternatives/deferred action: ${compact(input.alternative) ?? "none recorded"}`,
    `- Context summary: ${compact(input.contextSummary, 720) ?? "none recorded"}`,
    `- Rationale: ${compact(input.rationale, 720) ?? "none recorded"}`,
    `- Owner-visible side effect status: ${input.sideEffectStatus}`,
    "",
    "### Linked IDs",
    "",
    ...linkLines(input.links),
    ""
  ].join("\n");
}

async function appendDecisionEntry(options: {
  store: AgentStore;
  context: RequestContext;
  entry: DecisionEntry;
  now?: Date;
}): Promise<{ wrote: boolean; path: string; reason?: string }> {
  const now = options.now ?? options.entry.recordedAt ?? new Date();
  const path = decisionLedgerPath(now);
  const marker = `<!-- assistant-decision:${options.entry.markerId} -->`;
  const existing = await options.store.getMarkdownDocument(options.context, path);
  if (existing?.markdown.includes(marker)) {
    return { wrote: false, path, reason: "duplicate" };
  }

  const entry = buildEntry({ ...options.entry, recordedAt: now });
  const markdown = [
    existing?.markdown.trimEnd() ?? initialDocument(path),
    "",
    entry
  ].join("\n");
  const written = await options.store.writeMarkdownDocument(options.context, {
    path,
    markdown,
    expectedVersion: existing?.version
  });
  if (isConflict(written)) {
    return { wrote: false, path, reason: "conflict" };
  }
  await options.store.recordAudit(options.context, "assistant_decision.recorded", "markdown_document", written.id, {
    path,
    marker_id: options.entry.markerId,
    trigger: options.entry.trigger,
    action: options.entry.action
  });
  return { wrote: true, path };
}

function meaningfulWriteFilePath(path: string | null | undefined): boolean {
  return Boolean(path && (
    path.startsWith("/assistant/self-review/") ||
    path.startsWith("/assistant/memory-review/") ||
    path.startsWith("/assistant/newsletter-interest/")
  ));
}

function entryForToolCall(toolCall: ToolCallRecord): DecisionEntry | null {
  if (toolCall.status !== "accepted" || !MEANINGFUL_TOOL_NAMES.has(toolCall.toolName)) {
    return null;
  }
  if (toolCall.toolName !== "record_observation" && toolCall.result.side_effect_executed !== true) {
    return null;
  }
  const args = toolCall.arguments;
  const result = resultObject(toolCall);
  const links: DecisionLinks = {
    runId: toolCall.runId,
    toolCallId: toolCall.id,
    taskId: stringValue(result, "task_id") ?? stringValue(args, "taskId") ?? stringValue(args, "relatedTaskId") ?? stringValue(args, "sourceTaskId"),
    taskEventId: stringValue(result, "task_event_id") ?? stringValue(result, "source_task_event_id"),
    outboundMessageId: stringValue(result, "outbound_message_id"),
    approvalId: stringValue(result, "approval_id"),
    markdownPath: stringValue(result, "path") ?? stringValue(args, "path"),
    actionId: stringValue(result, "action_id") ?? stringValue(args, "actionId")
  };
  const approvalId = links.approvalId;
  const outboundId = links.outboundMessageId;
  const taskId = links.taskId;
  const taskEventId = links.taskEventId;
  const markdownPath = links.markdownPath;
  const markerBasis = approvalId
    ? `approval:${approvalId}`
    : outboundId
      ? `outbound:${outboundId}`
      : taskEventId
        ? `task-event:${taskEventId}`
        : taskId && ["create_task", "create_followup_task"].includes(toolCall.toolName)
          ? `task:${taskId}:${toolCall.toolName}`
          : markdownPath && toolCall.toolName === "write_file"
            ? `write-file:${toolCall.runId ?? toolCall.id}:${markdownPath}`
            : `tool-call:${toolCall.id}`;

  switch (toolCall.toolName) {
    case "propose_outbound_message":
      return {
        markerId: markerBasis,
        trigger: "tool:propose_outbound_message",
        action: "queued owner-visible outbound proposal for approval",
        alternative: "stay quiet or record an observation",
        contextSummary: compact(args.body, 500) ?? "Outbound proposal body was unavailable.",
        rationale: stringValue(args, "rationale") ?? stringValue(args, "intent") ?? "Model selected an owner-visible message; host queued approval instead of sending.",
        links,
        sideEffectStatus: `approval_required:${stringValue(result, "status") ?? "queued"}`
      };
    case "request_clarification":
    case "ask_owner_clarification":
      return {
        markerId: markerBasis,
        trigger: `tool:${toolCall.toolName}`,
        action: "requested owner clarification",
        alternative: String(args.urgency) === "now" ? "defer to a local clarification task" : "interrupt the owner immediately",
        contextSummary: compact(args.question, 500) ?? "Clarification question was unavailable.",
        rationale: stringValue(args, "rationale") ?? "Agent needed owner input before continuing.",
        links,
        sideEffectStatus: String(args.urgency) === "now" ? `owner_message:${stringValue(result, "status") ?? "pending"}` : "local_task_created"
      };
    case "integration_action":
      return {
        markerId: markerBasis,
        trigger: "tool:integration_action",
        action: "queued cross-app write approval",
        alternative: "do not call the external app",
        contextSummary: stringValue(args, "userIntentSummary") ?? `Requested action ${String(args.actionId)}`,
        rationale: stringValue(args, "userIntentSummary") ?? "High-risk app write requires owner approval.",
        links,
        sideEffectStatus: `approval_required:${stringValue(result, "status") ?? "queued"}`
      };
    case "update_task_schedule":
      return {
        markerId: markerBasis,
        trigger: "tool:update_task_schedule",
        action: "updated task schedule",
        alternative: "leave the schedule unchanged",
        contextSummary: `due_at=${stringValue(result, "due_at") ?? "unscheduled"}; confidence=${stringValue(args, "confidence") ?? "unknown"}`,
        rationale: stringValue(args, "rationale") ?? "Schedule was changed through the controlled task tool.",
        links,
        sideEffectStatus: "local_task_schedule_updated"
      };
    case "update_task_status":
      return {
        markerId: markerBasis,
        trigger: "tool:update_task_status",
        action: `updated task status to ${stringValue(result, "status") ?? stringValue(args, "status") ?? "unknown"}`,
        alternative: "leave the task status unchanged",
        contextSummary: [
          stringValue(args, "waitingOn") ? `waiting_on=${stringValue(args, "waitingOn")}` : null,
          stringValue(args, "blockedReason") ? `blocked_reason=${stringValue(args, "blockedReason")}` : null
        ].filter(Boolean).join("; ") || "Task lifecycle status changed.",
        rationale: stringValue(args, "rationale") ?? "Task status was changed through the controlled task tool.",
        links,
        sideEffectStatus: "local_task_status_updated"
      };
    case "record_schedule_rationale":
    case "mark_waiting_on":
    case "split_task":
    case "create_followup_task":
    case "append_task_prompt":
    case "create_task":
      return {
        markerId: markerBasis,
        trigger: `tool:${toolCall.toolName}`,
        action: toolCall.toolName.replaceAll("_", " "),
        alternative: "no task change",
        contextSummary: stringValue(args, "title") ?? stringValue(args, "prompt") ?? stringValue(args, "waitingOn") ?? "Task state changed.",
        rationale: stringValue(args, "rationale") ?? "Task change was performed through a controlled host tool.",
        links,
        sideEffectStatus: "local_task_persistence"
      };
    case "write_file":
      if (!meaningfulWriteFilePath(markdownPath)) {
        return null;
      }
      return {
        markerId: markerBasis,
        trigger: "tool:write_file",
        action: `wrote assistant review note ${markdownPath}`,
        alternative: "record no durable review note",
        contextSummary: compact(args.content, 500) ?? "Markdown content was unavailable.",
        rationale: stringValue(args, "rationale") ?? "Review note was written through the controlled file tool.",
        links,
        sideEffectStatus: "local_markdown_written"
      };
    case "record_owner_feedback":
      return {
        markerId: markerBasis,
        trigger: "tool:record_owner_feedback",
        action: "recorded owner feedback",
        alternative: "do not update durable feedback signals",
        contextSummary: stringValue(args, "originalBehaviorSummary") ?? "Owner feedback captured.",
        rationale: stringValue(args, "rationale") ?? "Owner correction was captured as additive evidence.",
        links,
        sideEffectStatus: "local_feedback_markdown_written"
      };
    case "record_observation":
      return {
        markerId: markerBasis,
        trigger: "tool:record_observation",
        action: "recorded observation and took no side effect",
        alternative: "take a task, memory, app, or owner-message action",
        contextSummary: stringValue(args, "summary") ?? "Observation recorded.",
        rationale: stringValue(args, "summary") ?? "Agent chose observation/no side effect.",
        links,
        sideEffectStatus: "none"
      };
    default:
      if (approvalId && links.actionId) {
        return {
          markerId: markerBasis,
          trigger: `tool:${toolCall.toolName}`,
          action: "queued cross-app write approval",
          alternative: "do not change the external app",
          contextSummary: stringValue(args, "userIntentSummary") ?? `Requested action ${links.actionId}`,
          rationale: stringValue(args, "userIntentSummary") ?? "Registered app write requires owner approval.",
          links,
          sideEffectStatus: `approval_required:${stringValue(result, "status") ?? "queued"}`
        };
      }
      return null;
  }
}

export async function recordDecisionLedgerForToolCall(options: {
  store: AgentStore;
  context: RequestContext;
  toolCall: ToolCallRecord;
  now?: Date;
}): Promise<{ wrote: boolean; path?: string; reason?: string }> {
  const entry = entryForToolCall(options.toolCall);
  if (!entry) {
    return { wrote: false, reason: "not_meaningful" };
  }
  return appendDecisionEntry({
    store: options.store,
    context: options.context,
    entry,
    now: options.now
  });
}

function latestRationale(task: TaskRecord, events: TaskEventRecord[]): string {
  const rationaleEvent = events.find((event) => compact(event.details.rationale));
  return compact(rationaleEvent?.details.rationale, 720)
    ?? compact(task.scheduleRationale, 720)
    ?? compact(task.blockedReason, 720)
    ?? "Scheduled worker recorded this outcome from persisted task/run/tool state.";
}

export async function recordScheduledTaskDecision(options: {
  store: AgentStore;
  context: RequestContext;
  taskId: string;
  runId?: string | null;
  outcome: "acted" | "observed" | "failed";
  toolName?: string | null;
  failureMessage?: string | null;
  now?: Date;
}): Promise<{ wrote: boolean; path?: string; reason?: string }> {
  const task = await options.store.getTask(options.context, options.taskId);
  if (!task) {
    return { wrote: false, reason: "task_not_found" };
  }
  const events = await options.store.listTaskEvents(options.context, task.id);
  const latestEvent = events.find((event) => ["scheduled_task.outcome", "scheduled_task.failed"].includes(event.eventType));
  const action = options.outcome === "failed"
    ? "recorded scheduled task failure"
    : options.outcome === "acted"
      ? "completed scheduled task with action"
      : "completed scheduled task without owner-visible action";
  const contextSummary = [
    `task=${task.title}`,
    `status=${task.status}`,
    options.toolName ? `tool=${options.toolName}` : null,
    options.failureMessage ? `failure=${compact(options.failureMessage, 240)}` : null,
    latestEvent?.summary ? `event=${compact(latestEvent.summary, 240)}` : null
  ].filter(Boolean).join("; ");

  return appendDecisionEntry({
    store: options.store,
    context: options.context,
    now: options.now,
    entry: {
      markerId: `scheduled-task:${task.id}:${options.runId ?? "no-run"}:${options.outcome}`,
      trigger: `scheduled_task:${task.title}`,
      action,
      alternative: options.outcome === "observed" ? "message owner, change task state, or call an app" : "defer the scheduled work",
      contextSummary,
      rationale: options.failureMessage ?? latestRationale(task, events),
      links: {
        runId: options.runId ?? null,
        taskId: task.id,
        taskEventId: latestEvent?.id ?? null
      },
      sideEffectStatus: options.outcome === "failed"
        ? "failed_no_owner_visible_side_effect"
        : options.outcome === "acted"
          ? "tool_or_local_side_effect_recorded"
          : "none"
    }
  });
}
