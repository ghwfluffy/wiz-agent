import type { AuthenticatedUser, Session } from "../auth/session.js";

export type ActorType = "user" | "admin" | "agent" | "system";

export type RequestContext = {
  userId: string;
  actorType: ActorType;
  permissions: string[];
  requestId: string;
  session: Session;
  mcpAllowedTools?: string[] | null;
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
  scheduleRationale: string | null;
  sourceMemoryPath: string | null;
  sourceMessageId: string | null;
  sourceTaskId: string | null;
  recurrencePolicy: string | null;
  lastAgentReviewAt: string | null;
  nextReviewAt: string | null;
  waitingOn: string | null;
  blockedReason: string | null;
  ownerClarificationNeeded: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type TaskInput = {
  title: string;
  prompt: string;
  dueAt?: string | null;
  priority?: number;
  scheduleRationale?: string | null;
  sourceMemoryPath?: string | null;
  sourceMessageId?: string | null;
  sourceTaskId?: string | null;
  recurrencePolicy?: string | null;
  nextReviewAt?: string | null;
};

export type TaskUpdate = Partial<TaskInput> & {
  status?: string;
  lastAgentReviewAt?: string | null;
  waitingOn?: string | null;
  blockedReason?: string | null;
  ownerClarificationNeeded?: boolean;
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

export type SenderClassification = "owner" | "newsletter" | "trusted" | "untrusted" | "blocked";

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

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export type ApprovalActionType =
  | "send_outbound_message"
  | "update_task_schedule"
  | "trust_sender"
  | "block_sender"
  | "write_important_memory"
  | "cross_app_write_action"
  | "delete_archive_data";

export type ApprovalRiskLevel = "medium" | "high";

export type ApprovalInput = {
  sourceRunId?: string | null;
  sourceRef?: string | null;
  actionType: ApprovalActionType;
  proposedPayload: Record<string, unknown>;
  riskLevel: ApprovalRiskLevel;
  summary: string;
  expiresAt: string;
  requestedBy?: string;
};

export type ApprovalRecord = ApprovalInput & {
  id: string;
  userId: string;
  status: ApprovalStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type InboundHandlingResult = {
  classification: SenderClassification;
  action:
    | "routed_to_agent"
    | "queued_owner_review"
    | "accepted_newsletter"
    | "accepted_trusted"
    | "blocked"
    | "rate_limited"
    | "sender_reviewed"
    | "approval_decided";
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

export type MemoryDocumentRecord = {
  id: string;
  userId: string;
  slug: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
};

export type MarkdownPathType = "file" | "directory" | "missing";

export type MarkdownDirectoryEntry = {
  path: string;
  name: string;
  type: "file" | "directory";
  version?: number;
  updatedAt?: string;
};

export type MarkdownDocumentRecord = {
  id: string;
  userId: string;
  path: string;
  basename: string;
  title: string | null;
  markdown: string;
  contentHash: string;
  version: number;
  indexStatus: string;
  createdAt: string;
  updatedAt: string;
};

export type MarkdownSectionRecord = {
  id: string;
  userId: string;
  documentId: string;
  documentVersion: number;
  sectionId: string;
  parentSectionId: string | null;
  heading: string;
  headingPath: string[];
  level: number;
  lineStart: number;
  lineEnd: number;
  contentHash: string;
};

export type MarkdownHeadingMatch = {
  path: string;
  version: number;
  sectionId: string;
  heading: string;
  headingPath: string[];
  level: number;
  lineStart: number;
  lineEnd: number;
};

export type MarkdownWriteInput = {
  path: string;
  markdown: string;
  expectedVersion?: number;
};

export type MarkdownMoveInput = {
  from: string;
  to: string;
  expectedVersions?: Record<string, number>;
};

export type MarkdownConflict = {
  code: "conflict";
  path: string;
  expectedVersion: number;
  actualVersion: number;
};

export type MarkdownIndexStatus = {
  path: string;
  version: number;
  indexStatus: string;
  pendingJobs: number;
};

export type RagIndexJobType = "index_markdown" | "delete_markdown";

export type RagIndexJobRecord = {
  id: string;
  userId: string;
  documentId: string;
  requestedVersion: number | null;
  requestedContentHash: string | null;
  jobType: RagIndexJobType;
  status: string;
  attempts: number;
  lastError: string | null;
  availableAt: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
};

export type RagUserIndexHealthRecord = {
  userId: string;
  qdrantCollection: string;
  collectionExists: boolean;
  qdrantPointCount: number | null;
  healthStatus: string;
  lastError: string | null;
  embeddingModel: string;
  embeddingDimensions: number;
  lastCollectionCheckAt: string | null;
  lastReconciliationStartedAt: string | null;
  lastReconciliationCompletedAt: string | null;
  expectedDocumentCount: number;
  expectedChunkCount: number;
  updatedAt: string;
};

export type RagDocumentChunkInput = {
  id: string;
  documentVersion: number;
  sectionId: string | null;
  headingPath: string[];
  chunkIndex: number;
  content: string;
  contentHash: string;
  qdrantPointId: string;
  qdrantCollection: string;
  embeddingModel: string;
  embeddingDimensions: number;
  indexedAt?: string | null;
};

export type RagDocumentChunkRecord = RagDocumentChunkInput & {
  userId: string;
  documentId: string;
  createdAt: string;
};

export type RagIndexHealthInput = {
  collectionExists?: boolean;
  qdrantPointCount?: number | null;
  healthStatus?: string;
  lastError?: string | null;
  embeddingModel?: string;
  embeddingDimensions?: number;
  reconciliationStartedAt?: string | null;
  reconciliationCompletedAt?: string | null;
};

export type MarkdownSemanticSearchResult = {
  path: string;
  version: number;
  sectionId: string | null;
  headingPath: string[];
  chunkIndex: number;
  score: number;
  excerpt: string;
};

export type AgentMcpSession = {
  id: string;
  token: string;
  userId: string;
  runId: string | null;
  expiresAt: string;
  allowedTools: string[] | null;
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
  listMemoryDocuments(context: RequestContext): Promise<MemoryDocumentRecord[]>;
  getMemoryDocument(context: RequestContext, slug: string): Promise<MemoryDocumentRecord | undefined>;
  upsertMemoryDocument(context: RequestContext, input: {
    slug: string;
    title: string;
    body: string;
  }): Promise<MemoryDocumentRecord>;
  listMarkdownDirectory(context: RequestContext, path: string): Promise<MarkdownDirectoryEntry[]>;
  getMarkdownDocument(context: RequestContext, path: string, version?: number): Promise<MarkdownDocumentRecord | undefined>;
  getMarkdownDocumentById(
    context: Pick<RequestContext, "userId">,
    documentId: string,
    version?: number
  ): Promise<MarkdownDocumentRecord | undefined>;
  writeMarkdownDocument(
    context: RequestContext,
    input: MarkdownWriteInput
  ): Promise<MarkdownDocumentRecord | MarkdownConflict>;
  deleteMarkdownPath(context: RequestContext, path: string, expectedVersion?: number): Promise<boolean | MarkdownConflict>;
  moveMarkdownPath(context: RequestContext, input: MarkdownMoveInput): Promise<MarkdownDocumentRecord[] | MarkdownConflict>;
  listMarkdownSections(context: RequestContext, path: string): Promise<MarkdownSectionRecord[]>;
  readMarkdownSection(context: RequestContext, path: string, sectionId: string): Promise<MarkdownSectionRecord | undefined>;
  replaceMarkdownSection(
    context: RequestContext,
    path: string,
    sectionId: string,
    markdown: string,
    expectedVersion: number
  ): Promise<MarkdownDocumentRecord | MarkdownConflict | undefined>;
  appendMarkdownSection(
    context: RequestContext,
    path: string,
    sectionId: string,
    markdown: string,
    expectedVersion?: number
  ): Promise<MarkdownDocumentRecord | MarkdownConflict | undefined>;
  searchMarkdownExact(context: RequestContext, query: string): Promise<MarkdownDirectoryEntry[]>;
  searchMarkdownSemantic(context: RequestContext, input: {
    pointIds: string[];
    scoresByPointId: Record<string, number>;
    pathPrefix?: string;
    limit?: number;
  }): Promise<MarkdownSemanticSearchResult[]>;
  searchMarkdownHeadings(context: RequestContext, input: {
    query?: string;
    pathPrefix?: string;
    maxDepth?: number;
  }): Promise<MarkdownHeadingMatch[]>;
  grepMarkdown(context: RequestContext, input: {
    pattern: string;
    pathPrefix?: string;
    caseSensitive?: boolean;
    regex?: boolean;
    contextLines?: number;
    limit?: number;
  }): Promise<Array<{ path: string; line: number; text: string; before: string[]; after: string[] }>>;
  getMarkdownIndexStatus(context: RequestContext, path?: string): Promise<MarkdownIndexStatus[]>;
  reindexMarkdownPath(context: RequestContext, path: string): Promise<MarkdownIndexStatus[]>;
  ensureUserRagIndex(context: Pick<RequestContext, "userId">): Promise<string>;
  enqueueRagJob(context: Pick<RequestContext, "userId">, documentId: string, jobType: RagIndexJobType): Promise<RagIndexJobRecord>;
  claimRagIndexJobs(limit: number, now: Date): Promise<RagIndexJobRecord[]>;
  listRagIndexJobs(
    context: RequestContext,
    includeAllUsers?: boolean,
    statuses?: string[]
  ): Promise<RagIndexJobRecord[]>;
  retryRagIndexJob(context: RequestContext, jobId: string, includeAllUsers?: boolean): Promise<RagIndexJobRecord | undefined>;
  completeRagIndexJob(jobId: string): Promise<void>;
  failRagIndexJob(jobId: string, error: string, retryAt?: Date): Promise<void>;
  markRagIndexJobDead(jobId: string, error: string): Promise<void>;
  replaceDocumentChunks(
    context: Pick<RequestContext, "userId">,
    documentId: string,
    chunks: RagDocumentChunkInput[],
    indexedDocument?: { version: number; contentHash: string }
  ): Promise<RagDocumentChunkRecord[]>;
  listChunksForDocument(context: Pick<RequestContext, "userId">, documentId: string): Promise<RagDocumentChunkRecord[]>;
  listRagUserIndexHealth(context: RequestContext, includeAllUsers?: boolean): Promise<RagUserIndexHealthRecord[]>;
  updateRagIndexHealth(userId: string, input: RagIndexHealthInput): Promise<void>;
  createAgentMcpSession(context: RequestContext, input: {
    runId?: string | null;
    ttlSeconds?: number;
    allowedTools?: string[] | null;
  }): Promise<AgentMcpSession>;
  resolveAgentMcpSession(token: string | undefined, runId?: string | null): Promise<RequestContext | undefined>;
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
  listAgentRuns(context: RequestContext, includeAllUsers?: boolean): Promise<AgentRunRecord[]>;
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
  listToolCalls(context: RequestContext, includeAllUsers?: boolean): Promise<ToolCallRecord[]>;
  listSenders(context: RequestContext): Promise<SenderRecord[]>;
  getSenderStatus(context: RequestContext, address: string): Promise<SenderStatus | undefined>;
  setSenderStatus(context: RequestContext, address: string, status: SenderStatus): Promise<void>;
  deleteSender(context: RequestContext, address: string): Promise<boolean>;
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
  createApproval(context: RequestContext, input: ApprovalInput): Promise<ApprovalRecord>;
  listApprovals(context: RequestContext, statuses?: ApprovalStatus[]): Promise<ApprovalRecord[]>;
  getApproval(context: RequestContext, approvalId: string): Promise<ApprovalRecord | undefined>;
  updateApprovalStatus(
    context: RequestContext,
    approvalId: string,
    status: ApprovalStatus,
    decidedBy?: string | null
  ): Promise<ApprovalRecord | undefined>;
  updateApprovalPayload(
    context: RequestContext,
    approvalId: string,
    proposedPayload: Record<string, unknown>,
    summary?: string
  ): Promise<ApprovalRecord | undefined>;
};
