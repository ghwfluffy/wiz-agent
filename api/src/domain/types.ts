import type { Session } from "../auth/session.js";

export type ActorType = "user" | "admin" | "agent" | "system";

export type RequestContext = {
  tenantId: string;
  userId: string;
  actorType: ActorType;
  permissions: string[];
  requestId: string;
  session: Session;
};

export type TaskRecord = {
  id: string;
  tenantId: string;
  userId: string;
  status: string;
  kind: string;
  title: string;
  prompt: string;
  dueAt: string | null;
  priority: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type TaskInput = {
  title: string;
  prompt: string;
  dueAt?: string | null;
  priority?: number;
};

export type TaskUpdate = Partial<TaskInput> & {
  status?: string;
};

export type AuditRecord = {
  id: string;
  tenantId: string | null;
  userId: string | null;
  actorType: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  details: Record<string, unknown>;
  requestId: string | null;
  createdAt: string;
};

export type AiConfig = {
  fastModel: string;
  smartModel: string;
  orchestratorModel: string;
  repairModel: string;
  maxToolCalls: number;
  maxRuntimeSec: number;
  repairAttemptLimit: number;
};

export type AgentRunRecord = {
  id: string;
  tenantId: string;
  userId: string;
  taskId: string | null;
  status: string;
  modelTier: string;
  modelId: string;
  promptVersion: string | null;
  startedAt: string;
  finishedAt: string | null;
  failureMessage: string | null;
};

export type ToolCallRecord = {
  id: string;
  tenantId: string;
  userId: string;
  runId: string | null;
  toolName: string;
  status: string;
  arguments: Record<string, unknown>;
  result: Record<string, unknown>;
  validationError: string | null;
  createdAt: string;
  completedAt: string | null;
};

export type AgentStore = {
  createDevelopmentSession(settings: import("../config/settings.js").Settings, requestId: string): Promise<Session>;
  getSession(sessionId: string | undefined): Promise<Session | undefined>;
  revokeSession(sessionId: string | undefined, requestId: string): Promise<void>;
  createTask(context: RequestContext, input: TaskInput): Promise<TaskRecord>;
  listTasks(context: RequestContext): Promise<TaskRecord[]>;
  getTask(context: RequestContext, taskId: string): Promise<TaskRecord | undefined>;
  updateTask(context: RequestContext, taskId: string, update: TaskUpdate): Promise<TaskRecord | undefined>;
  listAudit(context: RequestContext, includeAllUsers: boolean): Promise<AuditRecord[]>;
  getAiConfig(): Promise<AiConfig>;
  updateAiConfig(context: RequestContext, config: AiConfig): Promise<AiConfig>;
  createAgentRun(
    context: RequestContext,
    input: {
      taskId?: string | null;
      status: string;
      modelTier: string;
      modelId: string;
      promptVersion?: string | null;
    }
  ): Promise<AgentRunRecord>;
  finishAgentRun(context: RequestContext, runId: string, status: string, failureMessage?: string | null): Promise<void>;
  recordToolCall(
    context: RequestContext,
    input: {
      runId?: string | null;
      toolName: string;
      status: string;
      arguments: Record<string, unknown>;
      result?: Record<string, unknown>;
      validationError?: string | null;
    }
  ): Promise<ToolCallRecord>;
};
