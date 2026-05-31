import { z } from "zod";

export const CreateTaskToolSchema = z.object({
  title: z.string().min(1),
  prompt: z.string().min(1),
  dueAt: z.string().datetime().nullable().optional(),
  priority: z.number().int().min(0).max(100).optional()
});

export const ProposeOutboundMessageToolSchema = z.object({
  channel: z.enum(["email", "sms", "mms"]),
  to: z.string().min(1),
  subject: z.string().optional(),
  body: z.string().min(1),
  approvalRequired: z.boolean().default(true)
});

export const RecordObservationToolSchema = z.object({
  summary: z.string().min(1),
  source: z.string().min(1)
});

export const ToolContracts = {
  create_task: CreateTaskToolSchema,
  propose_outbound_message: ProposeOutboundMessageToolSchema,
  record_observation: RecordObservationToolSchema
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
