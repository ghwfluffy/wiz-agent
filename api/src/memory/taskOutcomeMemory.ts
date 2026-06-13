import type { AgentStore, MarkdownConflict, RequestContext, TaskEventRecord, TaskRecord } from "../domain/types.js";

const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "cancelled"]);

export function taskOutcomeMemoryPath(date = new Date()): string {
  return `/tasks/outcomes/${date.toISOString().slice(0, 7)}.md`;
}

function isConflict(value: unknown): value is MarkdownConflict {
  return typeof value === "object" && value !== null && (value as { code?: unknown }).code === "conflict";
}

function compact(value: unknown, limit = 360): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, limit) : null;
}

function bullet(label: string, value: string | null | undefined): string | null {
  return value ? `- ${label}: ${value}` : null;
}

function eventDetails(events: TaskEventRecord[], eventType: string): TaskEventRecord[] {
  return events.filter((event) => event.eventType === eventType);
}

function collectSourceLinks(task: TaskRecord, events: TaskEventRecord[]): string[] {
  const links = new Set<string>();
  if (task.sourceMemoryPath) {
    links.add(`memory ${task.sourceMemoryPath}`);
  }
  if (task.sourceMessageId) {
    links.add(`message ${task.sourceMessageId}`);
  }
  if (task.sourceTaskId) {
    links.add(`source task ${task.sourceTaskId}`);
  }
  for (const event of events) {
    const details = event.details;
    for (const key of ["source_memory_path", "source_message_id", "source_task_id", "source_task_event_id", "followup_task_id"]) {
      const value = details[key];
      if (typeof value === "string" && value.trim()) {
        links.add(`${key.replaceAll("_", " ")} ${value}`);
      }
    }
    const childTaskIds = details.child_task_ids;
    if (Array.isArray(childTaskIds)) {
      for (const childTaskId of childTaskIds) {
        if (typeof childTaskId === "string" && childTaskId.trim()) {
          links.add(`child task ${childTaskId}`);
        }
      }
    }
  }
  return [...links];
}

function collectWhatHappened(events: TaskEventRecord[]): string {
  const summaries = events
    .filter((event) => event.eventType !== "task.created")
    .slice(0, 8)
    .reverse()
    .map((event) => compact(event.summary, 160))
    .filter((summary): summary is string => Boolean(summary));
  return summaries.length > 0 ? summaries.join(" ") : "Task reached a terminal status.";
}

function collectFailureReason(task: TaskRecord, events: TaskEventRecord[]): string | null {
  if (task.status !== "failed") {
    return null;
  }
  for (const event of events) {
    const reason = compact(event.details.failure_message) ?? compact(event.details.error) ?? compact(event.details.rationale);
    if (reason) {
      return reason;
    }
  }
  return compact(task.blockedReason) ?? "Task failed; no specific failure reason was recorded.";
}

function collectOwnerCorrection(events: TaskEventRecord[]): string | null {
  for (const event of events) {
    const correction = compact(event.details.owner_correction) ?? compact(event.details.owner_preference);
    if (correction) {
      return correction;
    }
  }
  return null;
}

function collectDurability(task: TaskRecord, events: TaskEventRecord[]): string {
  if (collectOwnerCorrection(events) || task.scheduleRationale || task.sourceMemoryPath || task.recurrencePolicy) {
    return "durable";
  }
  if (eventDetails(events, "task.split").length > 0 || eventDetails(events, "task.followup_created").length > 0) {
    return "durable";
  }
  return "one-off";
}

export function buildTaskOutcomeMemoryEntry(input: {
  task: TaskRecord;
  events: TaskEventRecord[];
  recordedAt?: Date;
}): string | null {
  const { task, events } = input;
  if (!TERMINAL_TASK_STATUSES.has(task.status)) {
    return null;
  }
  const recordedAt = input.recordedAt ?? new Date();
  const marker = `<!-- task-outcome:${task.id}:${task.status} -->`;
  const links = collectSourceLinks(task, events);
  const ownerCorrection = collectOwnerCorrection(events);
  const failureReason = collectFailureReason(task, events);
  const splitEvents = eventDetails(events, "task.split");
  const followupEvents = eventDetails(events, "task.followup_created");
  const futureUse = task.status === "failed"
    ? "When similar work appears, check the failure reason and avoid repeating the same approach."
    : splitEvents.length > 0 || followupEvents.length > 0
      ? "Use the linked follow-up/source tasks when continuing this work."
      : task.scheduleRationale
        ? "Reuse the schedule rationale when planning similar work."
        : "Use this as compact context if the owner refers back to the task.";

  return [
    marker,
    `## ${task.title} (${task.id})`,
    "",
    ...[
      bullet("Final status", task.status),
      bullet("Recorded", recordedAt.toISOString()),
      bullet("Created", task.createdAt),
      bullet("Updated", task.updatedAt),
      bullet("Due", task.dueAt ?? "unscheduled"),
      bullet("Source links", links.length > 0 ? links.join("; ") : null),
      bullet("What happened", collectWhatHappened(events)),
      bullet("Failure reason", failureReason),
      bullet("Owner correction/preference", ownerCorrection ?? "none recorded"),
      bullet("Lesson durability", collectDurability(task, events)),
      bullet("Future use", futureUse)
    ].filter((line): line is string => Boolean(line)),
    ""
  ].join("\n");
}

export async function recordTaskOutcomeMemory(options: {
  store: AgentStore;
  context: RequestContext;
  taskId: string;
  now?: Date;
}): Promise<{ wrote: boolean; path?: string; reason?: string }> {
  const task = await options.store.getTask(options.context, options.taskId);
  if (!task) {
    return { wrote: false, reason: "task_not_found" };
  }
  if (!TERMINAL_TASK_STATUSES.has(task.status)) {
    return { wrote: false, reason: "not_terminal" };
  }

  const now = options.now ?? new Date();
  const path = taskOutcomeMemoryPath(now);
  const marker = `<!-- task-outcome:${task.id}:${task.status} -->`;
  const existing = await options.store.getMarkdownDocument(options.context, path);
  if (existing?.markdown.includes(marker)) {
    return { wrote: false, path, reason: "duplicate" };
  }

  const events = await options.store.listTaskEvents(options.context, task.id);
  const entry = buildTaskOutcomeMemoryEntry({ task, events, recordedAt: now });
  if (!entry) {
    return { wrote: false, reason: "not_terminal" };
  }

  const markdown = existing
    ? `${existing.markdown.trimEnd()}\n\n${entry}`
    : [`# Task Outcomes: ${now.toISOString().slice(0, 7)}`, "", entry].join("\n");
  const written = await options.store.writeMarkdownDocument(options.context, {
    path,
    markdown,
    expectedVersion: existing?.version,
    provenance: {
      sourceKind: "task_outcome",
      sourceId: task.id,
      sourcePath: task.sourceMemoryPath,
      sourceLabel: task.title,
      confidence: "high",
      evidence: [
        `task status: ${task.status}`,
        task.scheduleRationale ?? "",
        task.blockedReason ?? ""
      ],
      derivedFrom: [
        task.id,
        task.sourceMessageId ?? "",
        task.sourceMemoryPath ?? ""
      ],
      durability: "durable",
      lastConfirmedAt: now.toISOString()
    }
  });
  if (isConflict(written)) {
    return { wrote: false, path, reason: "conflict" };
  }
  await options.store.recordTaskEvent(options.context, task.id, "task.outcome_memory_recorded", {
    memory_path: path,
    markdown_document_id: written.id,
    summary: "Task outcome was recorded in long-term memory."
  });
  return { wrote: true, path };
}
