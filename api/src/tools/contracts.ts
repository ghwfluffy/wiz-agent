import { z } from "zod";
import { IntegrationActionIds } from "../integrations/capabilityRegistry.js";

export const CreateTaskToolSchema = z.object({
  title: z.string().min(1),
  prompt: z.string().min(1),
  dueAt: z.string().datetime().nullable().optional(),
  priority: z.number().int().min(0).max(100).optional()
});

export const ListOngoingTasksToolSchema = z.object({
  reason: z.string().min(1).optional()
});

export const ListRecentContextToolSchema = z.object({
  reason: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(20).default(8)
});

export const ListRecentOwnerConversationsToolSchema = z.object({
  reason: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(20).default(8)
});

export const WriteMemoryToolSchema = z.object({
  slug: z.string().min(1).max(120).regex(/^[a-z0-9][a-z0-9-]*$/),
  title: z.string().min(1).max(160),
  appendMarkdown: z.string().min(1),
  rationale: z.string().min(1)
});

export const AppendTaskPromptToolSchema = z.object({
  taskId: z.string().min(1),
  prompt: z.string().min(1),
  status: z.enum(["pending", "claimed", "running"]).default("pending")
});

export const UpdateTaskScheduleToolSchema = z.object({
  taskId: z.string().min(1),
  dueAt: z.string().datetime().nullable(),
  rationale: z.string().min(1),
  confidence: z.enum(["low", "medium", "high"])
});

export const ProposeOutboundMessageToolSchema = z.object({
  intent: z.enum(["reply"]).default("reply"),
  subject: z.string().optional(),
  body: z.string().min(1),
  approvalRequired: z.boolean().default(false)
}).strict();

export const AskOwnerClarificationToolSchema = z.object({
  question: z.string().min(1),
  relatedTaskId: z.string().min(1).optional(),
  urgency: z.enum(["now", "daily_briefing", "next_wake"])
});

export const RecordObservationToolSchema = z.object({
  summary: z.string().min(1),
  source: z.string().min(1)
});

export const IntegrationActionToolSchema = z.object({
  actionId: z.enum(IntegrationActionIds),
  pathParams: z.record(z.string(), z.string()).default({}),
  query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  body: z.record(z.string(), z.unknown()).optional(),
  userIntentSummary: z.string().min(1),
  approvalRequired: z.boolean().default(false)
});

export const ToolContracts = {
  create_task: CreateTaskToolSchema,
  list_ongoing_tasks: ListOngoingTasksToolSchema,
  list_recent_context: ListRecentContextToolSchema,
  list_recent_owner_conversations: ListRecentOwnerConversationsToolSchema,
  write_memory: WriteMemoryToolSchema,
  append_task_prompt: AppendTaskPromptToolSchema,
  update_task_schedule: UpdateTaskScheduleToolSchema,
  propose_outbound_message: ProposeOutboundMessageToolSchema,
  ask_owner_clarification: AskOwnerClarificationToolSchema,
  record_observation: RecordObservationToolSchema,
  integration_action: IntegrationActionToolSchema
} as const;

export type ToolName = keyof typeof ToolContracts;

export type ToolCallProposal = {
  toolName: ToolName;
  arguments: unknown;
};

export function isToolName(value: string): value is ToolName {
  return value in ToolContracts;
}

export function contractShape(toolName: ToolName): unknown {
  return ToolContracts[toolName].toJSONSchema();
}
