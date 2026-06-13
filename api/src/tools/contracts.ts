import { z } from "zod";
import { IntegrationActionIds, IntegrationAppIds } from "../integrations/capabilityRegistry.js";

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

export const GetRecentBotActivityToolSchema = z.object({
  reason: z.string().min(1).optional(),
  lookbackHours: z.number().int().min(1).max(24 * 30).default(24 * 7),
  limit: z.number().int().min(1).max(20).default(10)
});

export const ListAppCapabilitiesToolSchema = z.object({
  appId: z.enum(IntegrationAppIds).optional(),
  includeActions: z.boolean().default(true),
  reason: z.string().min(1).optional()
});

const ChecklistItemSchema = z.object({
  id: z.string().min(1).optional(),
  title: z.string().min(1)
});

const InlineGoalMetricSchema = z.object({
  name: z.string().min(1),
  metricType: z.enum(["number", "count", "date"]),
  decimalPlaces: z.number().int().min(0).max(6).nullable().optional(),
  unitLabel: z.string().nullable().optional(),
  initialNumberValue: z.number().nullable().optional(),
  initialDateValue: z.string().date().nullable().optional(),
  recordedAt: z.string().datetime().nullable().optional()
});

export const ListGoalsToolSchema = z.object({
  includeArchived: z.boolean().default(false),
  reason: z.string().min(1).optional()
});

export const CreateGoalToolSchema = z.object({
  goalType: z.enum(["metric", "checklist"]).default("metric"),
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  startDate: z.string().date(),
  targetDate: z.string().date().nullable().optional(),
  targetValueNumber: z.number().nullable().optional(),
  targetValueDate: z.string().date().nullable().optional(),
  successThresholdPercent: z.number().min(0).max(100).nullable().optional(),
  exceptionDates: z.array(z.string().date()).default([]),
  checklistItems: z.array(ChecklistItemSchema).default([]),
  metricId: z.string().min(1).nullable().optional(),
  newMetric: InlineGoalMetricSchema.nullable().optional(),
  userIntentSummary: z.string().min(1)
});

export const UpdateGoalToolSchema = z.object({
  goalId: z.string().min(1),
  title: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  startDate: z.string().date().optional(),
  targetDate: z.string().date().nullable().optional(),
  targetValueNumber: z.number().nullable().optional(),
  targetValueDate: z.string().date().nullable().optional(),
  successThresholdPercent: z.number().min(0).max(100).nullable().optional(),
  exceptionDates: z.array(z.string().date()).optional(),
  checklistItems: z.array(ChecklistItemSchema).optional(),
  archived: z.boolean().optional(),
  userIntentSummary: z.string().min(1)
});

export const CompleteGoalChecklistItemToolSchema = z.object({
  goalId: z.string().min(1),
  itemId: z.string().min(1),
  completed: z.boolean().default(true),
  userIntentSummary: z.string().min(1)
});

export const ListGoalMetricsToolSchema = z.object({
  includeArchived: z.boolean().default(false),
  reason: z.string().min(1).optional()
});

export const RecordGoalMetricEntryToolSchema = z.object({
  metricId: z.string().min(1),
  numberValue: z.number().nullable().optional(),
  dateValue: z.string().date().nullable().optional(),
  recordedAt: z.string().datetime().nullable().optional(),
  userIntentSummary: z.string().min(1)
});

export const ListGoalNotificationsToolSchema = z.object({
  timezone: z.string().min(1),
  reason: z.string().min(1).optional()
});

export const CompleteGoalNotificationToolSchema = z.object({
  notificationId: z.string().min(1),
  timezone: z.string().min(1),
  numberValue: z.number().nullable().optional(),
  recordedAt: z.string().datetime().nullable().optional(),
  userIntentSummary: z.string().min(1)
});

export const ListBudgetAccountsToolSchema = z.object({
  reason: z.string().min(1).optional()
});

export const GetBudgetAccountToolSchema = z.object({
  accountId: z.string().min(1),
  reason: z.string().min(1).optional()
});

export const RecordBudgetAccountValueToolSchema = z.object({
  accountId: z.string().min(1),
  value: z.record(z.string(), z.unknown()),
  userIntentSummary: z.string().min(1)
});

export const GetNetWorthHistoryToolSchema = z.object({
  reason: z.string().min(1).optional()
});

export const GetNetWorthForecastToolSchema = z.object({
  throughDate: z.string().date().optional(),
  reason: z.string().min(1).optional()
});

export const ListBudgetTransfersToolSchema = z.object({ reason: z.string().min(1).optional() });
export const ListBudgetContractsToolSchema = z.object({ reason: z.string().min(1).optional() });
export const ListBudgetExpensesToolSchema = z.object({ reason: z.string().min(1).optional() });
export const ListBudgetInvestmentsToolSchema = z.object({ reason: z.string().min(1).optional() });
export const ListBudgetAuditLogsToolSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  reason: z.string().min(1).optional()
});

const BudgetContractFieldsSchema = z.object({
  name: z.string().min(1).optional(),
  type: z.enum(["income", "payment", "transfer"]).optional(),
  automatic: z.boolean().optional(),
  amountCents: z.number().int().min(0).optional(),
  organization: z.string().min(1).optional(),
  linkedAccountId: z.string().min(1).nullable().optional(),
  linkedWallet: z.enum(["paypal", "google_pay"]).nullable().optional(),
  sourceAccountId: z.string().min(1).nullable().optional(),
  lastPaymentDate: z.string().date().nullable().optional(),
  nextPaymentDate: z.string().date().nullable().optional(),
  paymentPeriod: z.string().min(1).nullable().optional(),
  paymentDay: z.number().int().min(1).max(31).nullable().optional(),
  expirationDate: z.string().date().nullable().optional(),
  notes: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  accountNumber: z.string().nullable().optional(),
  billingDay: z.number().int().min(1).max(31).nullable().optional()
});

export const CreateBudgetContractToolSchema = BudgetContractFieldsSchema.extend({
  name: z.string().min(1),
  type: z.enum(["income", "payment", "transfer"]),
  amountCents: z.number().int().min(0),
  organization: z.string().min(1),
  userIntentSummary: z.string().min(1)
});

export const UpdateBudgetContractToolSchema = BudgetContractFieldsSchema.extend({
  contractId: z.string().min(1),
  userIntentSummary: z.string().min(1)
});

export const DeleteBudgetContractToolSchema = z.object({
  contractId: z.string().min(1),
  userIntentSummary: z.string().min(1)
});

const BudgetExpenseFieldsSchema = z.object({
  name: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
  notes: z.string().nullable().optional(),
  estimatedAmountCents: z.number().int().min(0).optional(),
  linkedAccountId: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  generalFrequency: z.string().min(1).nullable().optional(),
  lastExpensedDate: z.string().date().nullable().optional(),
  nextExpensedDate: z.string().date().nullable().optional(),
  nextDateIsStatic: z.boolean().optional()
});

export const CreateBudgetExpenseToolSchema = BudgetExpenseFieldsSchema.extend({
  name: z.string().min(1),
  category: z.string().min(1),
  estimatedAmountCents: z.number().int().min(0),
  linkedAccountId: z.string().min(1),
  userIntentSummary: z.string().min(1)
});

export const UpdateBudgetExpenseToolSchema = BudgetExpenseFieldsSchema.extend({
  expenseId: z.string().min(1),
  userIntentSummary: z.string().min(1)
});

export const DeleteBudgetExpenseToolSchema = z.object({
  expenseId: z.string().min(1),
  userIntentSummary: z.string().min(1)
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
  confidence: z.enum(["low", "medium", "high"]),
  nextReviewAt: z.string().datetime().nullable().optional()
});

export const UpdateTaskStatusToolSchema = z.object({
  taskId: z.string().min(1),
  status: z.enum(["pending", "claimed", "running", "waiting", "blocked", "completed", "cancelled", "failed"]),
  rationale: z.string().min(1),
  waitingOn: z.string().min(1).nullable().optional(),
  blockedReason: z.string().min(1).nullable().optional(),
  ownerClarificationNeeded: z.boolean().optional()
});

export const SplitTaskToolSchema = z.object({
  taskId: z.string().min(1),
  newTasks: z.array(z.object({
    title: z.string().min(1),
    prompt: z.string().min(1),
    dueAt: z.string().datetime().nullable().optional(),
    priority: z.number().int().min(0).max(100).optional(),
    scheduleRationale: z.string().min(1)
  })).min(1).max(5),
  rationale: z.string().min(1)
});

export const CreateFollowupTaskToolSchema = z.object({
  sourceTaskId: z.string().min(1).optional(),
  title: z.string().min(1),
  prompt: z.string().min(1),
  dueAt: z.string().datetime().nullable().optional(),
  priority: z.number().int().min(0).max(100).optional(),
  rationale: z.string().min(1)
});

export const MarkWaitingOnToolSchema = z.object({
  taskId: z.string().min(1),
  waitingOn: z.string().min(1),
  rationale: z.string().min(1),
  nextReviewAt: z.string().datetime().nullable().optional()
});

export const RequestClarificationToolSchema = z.object({
  question: z.string().min(1),
  relatedTaskId: z.string().min(1).optional(),
  urgency: z.enum(["now", "daily_briefing", "next_wake"]),
  rationale: z.string().min(1)
});

export const RecordScheduleRationaleToolSchema = z.object({
  taskId: z.string().min(1),
  rationale: z.string().min(1),
  sourceMemoryPath: z.string().min(1).optional(),
  sourceMessageId: z.string().min(1).optional(),
  sourceTaskId: z.string().min(1).optional(),
  recurrencePolicy: z.string().min(1).optional(),
  nextReviewAt: z.string().datetime().nullable().optional()
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
  get_recent_bot_activity: GetRecentBotActivityToolSchema,
  list_app_capabilities: ListAppCapabilitiesToolSchema,
  list_goals: ListGoalsToolSchema,
  create_goal: CreateGoalToolSchema,
  update_goal: UpdateGoalToolSchema,
  complete_goal_checklist_item: CompleteGoalChecklistItemToolSchema,
  list_goal_metrics: ListGoalMetricsToolSchema,
  record_goal_metric_entry: RecordGoalMetricEntryToolSchema,
  list_goal_notifications: ListGoalNotificationsToolSchema,
  complete_goal_notification: CompleteGoalNotificationToolSchema,
  list_budget_accounts: ListBudgetAccountsToolSchema,
  get_budget_account: GetBudgetAccountToolSchema,
  record_budget_account_value: RecordBudgetAccountValueToolSchema,
  get_net_worth_history: GetNetWorthHistoryToolSchema,
  get_net_worth_forecast: GetNetWorthForecastToolSchema,
  list_budget_transfers: ListBudgetTransfersToolSchema,
  list_budget_contracts: ListBudgetContractsToolSchema,
  create_budget_contract: CreateBudgetContractToolSchema,
  update_budget_contract: UpdateBudgetContractToolSchema,
  delete_budget_contract: DeleteBudgetContractToolSchema,
  list_budget_expenses: ListBudgetExpensesToolSchema,
  create_budget_expense: CreateBudgetExpenseToolSchema,
  update_budget_expense: UpdateBudgetExpenseToolSchema,
  delete_budget_expense: DeleteBudgetExpenseToolSchema,
  list_budget_investments: ListBudgetInvestmentsToolSchema,
  list_budget_audit_logs: ListBudgetAuditLogsToolSchema,
  write_memory: WriteMemoryToolSchema,
  append_task_prompt: AppendTaskPromptToolSchema,
  update_task_schedule: UpdateTaskScheduleToolSchema,
  update_task_status: UpdateTaskStatusToolSchema,
  split_task: SplitTaskToolSchema,
  create_followup_task: CreateFollowupTaskToolSchema,
  mark_waiting_on: MarkWaitingOnToolSchema,
  request_clarification: RequestClarificationToolSchema,
  record_schedule_rationale: RecordScheduleRationaleToolSchema,
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
