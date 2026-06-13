import { randomUUID } from "node:crypto";
import type { AgentStore, MarkdownConflict, MarkdownDocumentRecord, RequestContext } from "../domain/types.js";

export const OWNER_FEEDBACK_TYPES = [
  "communication",
  "memory",
  "task",
  "tool",
  "schedule",
  "app_action",
  "preference",
  "other"
] as const;

export const OWNER_FEEDBACK_DURABILITY = ["durable", "tentative", "one_off"] as const;

export const OWNER_FEEDBACK_FOLLOW_UP_TARGETS = [
  "communication_preferences",
  "newsletter_preferences",
  "task_policy",
  "list_memory",
  "capability_guidance",
  "schedule_policy",
  "none",
  "other"
] as const;

export type OwnerFeedbackType = (typeof OWNER_FEEDBACK_TYPES)[number];
export type OwnerFeedbackDurability = (typeof OWNER_FEEDBACK_DURABILITY)[number];
export type OwnerFeedbackFollowUpTarget = (typeof OWNER_FEEDBACK_FOLLOW_UP_TARGETS)[number];

export type OwnerFeedbackInput = {
  feedbackType: OwnerFeedbackType;
  correctionText: string;
  originalBehaviorSummary: string;
  durability: OwnerFeedbackDurability;
  followUpTarget: OwnerFeedbackFollowUpTarget;
  rationale: string;
  affectedMemoryPaths?: string[];
  affectedTaskIds?: string[];
  affectedToolCallIds?: string[];
  affectedMessageIds?: string[];
  affectedAppIds?: string[];
};

function monthPath(date: Date): string {
  return `/assistant/feedback/${date.toISOString().slice(0, 7)}.md`;
}

function dayStamp(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function markdownList(values: string[] | undefined): string {
  const cleaned = [...new Set((values ?? []).map(compactLine).filter(Boolean))];
  return cleaned.length > 0 ? cleaned.map((value) => `  - ${value}`).join("\n") : "  - none";
}

function compactLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function buildEntry(input: OwnerFeedbackInput, now: Date, runId?: string | null): string {
  const feedbackId = randomUUID();
  return [
    `## ${dayStamp(now)} ${input.feedbackType} feedback`,
    "",
    `<!-- owner-feedback:${feedbackId} -->`,
    `recorded_at: ${now.toISOString()}`,
    `feedback_type: ${input.feedbackType}`,
    `durability: ${input.durability}`,
    `follow_up_target: ${input.followUpTarget}`,
    `source_run_id: ${runId ?? "none"}`,
    "",
    "### Owner Correction",
    "",
    input.correctionText.trim(),
    "",
    "### Original Behavior Or Context",
    "",
    input.originalBehaviorSummary.trim(),
    "",
    "### Affected References",
    "",
    "memory_paths:",
    markdownList(input.affectedMemoryPaths),
    "task_ids:",
    markdownList(input.affectedTaskIds),
    "tool_call_ids:",
    markdownList(input.affectedToolCallIds),
    "message_ids:",
    markdownList(input.affectedMessageIds),
    "app_ids:",
    markdownList(input.affectedAppIds),
    "",
    "### Follow-Up Guidance",
    "",
    `Target: ${input.followUpTarget}`,
    `Rationale: ${compactLine(input.rationale)}`,
    "",
    "Do not automatically rewrite preferences from this feedback. Use a separate controlled tool with rationale when a durable preference update is warranted."
  ].join("\n");
}

function initialDocument(path: string): string {
  const month = path.match(/(\d{4}-\d{2})\.md$/)?.[1] ?? "Unknown";
  return [
    `# Owner Feedback: ${month}`,
    "",
    "Structured owner corrections captured by the controlled feedback tool.",
    "These entries are training signals and review evidence; they are not preference rewrites by themselves."
  ].join("\n");
}

function isConflict(value: MarkdownDocumentRecord | MarkdownConflict): value is MarkdownConflict {
  return "code" in value && value.code === "conflict";
}

export function ownerFeedbackPath(date = new Date()): string {
  return monthPath(date);
}

export async function recordOwnerFeedback(options: {
  store: AgentStore;
  context: RequestContext;
  input: OwnerFeedbackInput;
  runId?: string | null;
  now?: Date;
}): Promise<Record<string, unknown>> {
  const now = options.now ?? new Date();
  const path = ownerFeedbackPath(now);
  const existing = await options.store.getMarkdownDocument(options.context, path);
  const entry = buildEntry(options.input, now, options.runId);
  const markdown = [
    existing?.markdown.trimEnd() ?? initialDocument(path),
    "",
    entry
  ].join("\n");
  const document = await options.store.writeMarkdownDocument(options.context, {
    path,
    markdown,
    expectedVersion: existing?.version
  });
  if (isConflict(document)) {
    return {
      code: "conflict",
      path: document.path,
      expected_version: document.expectedVersion,
      actual_version: document.actualVersion
    };
  }
  await options.store.recordAudit(options.context, "owner_feedback.recorded", "markdown_document", document.id, {
    path,
    feedback_type: options.input.feedbackType,
    durability: options.input.durability,
    follow_up_target: options.input.followUpTarget,
    source_run_id: options.runId ?? null
  });
  return {
    markdown_document_id: document.id,
    path: document.path,
    version: document.version,
    feedback_type: options.input.feedbackType,
    durability: options.input.durability,
    follow_up_target: options.input.followUpTarget
  };
}
