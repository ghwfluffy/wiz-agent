import type { AuthenticatedUser, Session } from "../auth/session.js";

export type ActorType = "user" | "admin" | "agent" | "system";

export type RequestContext = {
  userId: string;
  actorType: ActorType;
  permissions: string[];
  requestId: string;
  session: Session;
};

export type TaskRecord = {
  id: string;
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

export type TaskEventRecord = {
  id: string;
  userId: string;
  taskId: string;
  eventType: string;
  summary: string;
  details: Record<string, unknown>;
  createdAt: string;
};

export type SenderStatus = "owner" | "newsletter" | "trusted" | "blocked" | "untrusted";

export type SenderClassification = "owner" | "newsletter" | "untrusted" | "blocked";

export type SenderRecord = {
  id: string;
  userId: string;
  address: string;
  status: SenderStatus;
  createdAt: string;
  updatedAt: string;
};

export type InboundMessageInput = {
  providerMessageId: string;
  fromAddr: string;
  toAddr: string;
  subject?: string | null;
  bodyText: string;
  receivedAt?: string | null;
  source?: string;
};

export type InboundMessageRecord = InboundMessageInput & {
  id: string;
  userId: string;
  classification: SenderClassification;
  handlingAction: InboundHandlingResult["action"] | null;
  taskId: string | null;
  taskEventId: string | null;
  agentRunId: string | null;
  outboundMessageId: string | null;
  createdAt: string;
};

export type OutboundMessageInput = {
  channel: "email" | "sms" | "mms";
  status: "pending" | "requires_approval" | "approved" | "sending" | "sent" | "failed" | "cancelled";
  toAddr: string;
  subject?: string | null;
  bodyText: string;
  approvalId?: string | null;
  conversationId?: string | null;
};

export type OutboundMessageRecord = OutboundMessageInput & {
  id: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
  sentAt?: string | null;
  failureMessage?: string | null;
};

export type InboundHandlingResult = {
  classification: SenderClassification;
  action: "routed_to_agent" | "queued_owner_review" | "accepted_newsletter" | "blocked" | "rate_limited";
  messageId?: string;
  taskId?: string;
  taskEventId?: string;
  agentRunId?: string;
  outboundMessageId?: string;
};

export type AuditRecord = {
  id: string;
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

export type ConnectorKind = "owner-contact" | "imap" | "smtp" | "openai";

export type ConnectorStatus = "enabled" | "disabled";

export type ConnectorRecord = {
  id: string;
  userId: string;
  kind: ConnectorKind;
  status: ConnectorStatus;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type ConnectorInput = {
  kind: ConnectorKind;
  status: ConnectorStatus;
  config: Record<string, unknown>;
};

export type AgentRunRecord = {
  id: string;
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
  createOauthState(context: {
    state: string;
    codeVerifier: string;
    nextPath: string;
    expiresAt: string;
  }): Promise<void>;
  consumeOauthState(state: string): Promise<{ codeVerifier: string; nextPath: string } | undefined>;
  createOauthSession(settings: import("../config/settings.js").Settings, input: {
    subject: string;
    email: string;
    displayName: string;
    isAdmin: boolean;
    identityProvider: string;
    requestId: string;
  }): Promise<Session>;
  getSession(sessionId: string | undefined): Promise<Session | undefined>;
  revokeSession(sessionId: string | undefined, requestId: string): Promise<void>;
  createTask(context: RequestContext, input: TaskInput): Promise<TaskRecord>;
  listTasks(context: RequestContext): Promise<TaskRecord[]>;
  getTask(context: RequestContext, taskId: string): Promise<TaskRecord | undefined>;
  updateTask(context: RequestContext, taskId: string, update: TaskUpdate): Promise<TaskRecord | undefined>;
  listTaskEvents(context: RequestContext, taskId: string): Promise<TaskEventRecord[]>;
  recordTaskEvent(
    context: Pick<RequestContext, "userId">,
    taskId: string,
    eventType: string,
    details?: Record<string, unknown>
  ): Promise<TaskEventRecord>;
  claimDueTasks(context: RequestContext, limit: number, now?: Date): Promise<TaskRecord[]>;
  listAudit(context: RequestContext, includeAllUsers: boolean): Promise<AuditRecord[]>;
  recordAudit(
    context: Pick<RequestContext, "userId" | "actorType" | "requestId">,
    action: string,
    entityType: string | null,
    entityId: string | null,
    details?: Record<string, unknown>
  ): Promise<void>;
  getAiConfig(): Promise<AiConfig>;
  updateAiConfig(context: RequestContext, config: AiConfig): Promise<AiConfig>;
  listConnectors(context: RequestContext): Promise<ConnectorRecord[]>;
  getConnector(context: RequestContext, kind: ConnectorKind): Promise<ConnectorRecord | undefined>;
  upsertConnector(context: RequestContext, input: ConnectorInput): Promise<ConnectorRecord>;
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
  listSenders(context: RequestContext): Promise<SenderRecord[]>;
  getSenderStatus(context: RequestContext, address: string): Promise<SenderStatus | undefined>;
  setSenderStatus(context: RequestContext, address: string, status: SenderStatus): Promise<void>;
  recordInboundMessage(
    context: RequestContext,
    input: InboundMessageInput,
    classification: SenderClassification
  ): Promise<InboundMessageRecord & { duplicate: boolean }>;
  listInboundMessages(context: RequestContext): Promise<InboundMessageRecord[]>;
  getInboundMessage(context: RequestContext, messageId: string): Promise<InboundMessageRecord | undefined>;
  updateInboundMessageHandling(
    context: RequestContext,
    messageId: string,
    handling: {
      action: InboundHandlingResult["action"];
      taskId?: string | null;
      taskEventId?: string | null;
      agentRunId?: string | null;
      outboundMessageId?: string | null;
    }
  ): Promise<InboundMessageRecord | undefined>;
  queueOutboundMessage(context: RequestContext, input: OutboundMessageInput): Promise<OutboundMessageRecord>;
  listOutboundMessages(context: RequestContext, statuses?: string[]): Promise<OutboundMessageRecord[]>;
  listUsersWithWork(statuses?: string[], now?: Date): Promise<AuthenticatedUser[]>;
  updateOutboundMessageStatus(
    context: RequestContext,
    messageId: string,
    status: OutboundMessageInput["status"],
    failureMessage?: string | null
  ): Promise<OutboundMessageRecord | undefined>;
};
