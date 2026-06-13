import { apiUrl } from "./basePath";

export type AuthUser = {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
};

export type AuthMeResponse = {
  authenticated: boolean;
  user: AuthUser | null;
  expiresAt?: string;
};

export type Task = {
  id: string;
  status: string;
  title: string;
  prompt: string;
  dueAt: string | null;
  priority: number;
  scheduleRationale?: string | null;
  sourceMemoryPath?: string | null;
  sourceMessageId?: string | null;
  sourceTaskId?: string | null;
  recurrencePolicy?: string | null;
  lastAgentReviewAt?: string | null;
  nextReviewAt?: string | null;
  waitingOn?: string | null;
  blockedReason?: string | null;
  ownerClarificationNeeded?: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type TaskInput = {
  title: string;
  prompt: string;
  dueAt?: string | null;
  priority?: number;
};

export type TaskEvent = {
  id: string;
  taskId: string;
  eventType: string;
  summary: string;
  details: Record<string, unknown>;
  createdAt: string;
};

export type InboundMessage = {
  id: string;
  providerMessageId: string;
  fromAddr: string;
  toAddr: string;
  subject?: string | null;
  bodyText: string;
  receivedAt?: string | null;
  source?: string | null;
  classification: "owner" | "newsletter" | "trusted" | "untrusted" | "blocked";
  handlingAction: string | null;
  taskId: string | null;
  taskEventId: string | null;
  agentRunId: string | null;
  outboundMessageId: string | null;
  createdAt: string;
};

export type OutboxMessage = {
  id: string;
  channel: "email" | "sms" | "mms";
  status: string;
  toAddr: string;
  subject?: string | null;
  bodyText: string;
  approvalId?: string | null;
  createdAt: string;
  updatedAt: string;
  sentAt?: string | null;
  failureMessage?: string | null;
};

export type Approval = {
  id: string;
  status: "pending" | "approved" | "rejected" | "expired";
  executionStatus: "not_applicable" | "pending" | "running" | "succeeded" | "failed";
  executionResult: Record<string, unknown> | null;
  executionError: string | null;
  executedAt: string | null;
  actionType: string;
  sourceRunId?: string | null;
  sourceRef?: string | null;
  proposedPayload: Record<string, unknown>;
  riskLevel: string;
  summary: string;
  expiresAt: string;
  requestedBy?: string;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AuditEvent = {
  id: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
};

export type Sender = {
  id: string;
  address: string;
  status: "owner" | "newsletter" | "trusted" | "blocked" | "untrusted";
  createdAt: string;
  updatedAt: string;
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

export type JobStatus = {
  name: string;
  status: string;
  pendingTasks?: number;
  dueTasks?: number;
  failedTasks?: number;
  failedRuns?: number;
  pendingMessages?: number;
  approvedMessages?: number;
  sendingMessages?: number;
  failedMessages?: number;
  pendingApprovals?: number;
  pendingJobs?: number;
  claimedJobs?: number;
  failedJobs?: number;
  deadJobs?: number;
  failedToolCalls?: number;
  collections?: number;
  unhealthyCollections?: number;
  lastAuditAt?: string | null;
};

export type RagIndexJob = {
  id: string;
  userId: string;
  documentId: string;
  requestedVersion: number | null;
  requestedContentHash: string | null;
  jobType: string;
  status: string;
  attempts: number;
  lastError: string | null;
  availableAt: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
};

export type RagIndexHealth = {
  userId: string;
  qdrantCollection: string;
  collectionExists: boolean;
  qdrantPointCount: number | null;
  healthStatus: string;
  lastError: string | null;
  expectedDocumentCount: number;
  expectedChunkCount: number;
  updatedAt: string;
};

export type JobsResponse = {
  generatedAt?: string;
  budgets?: Record<string, number>;
  ragIndexHealth?: RagIndexHealth[];
  recentFailures?: {
    agentRuns: unknown[];
    toolCalls: unknown[];
    ragJobs: RagIndexJob[];
  };
  jobs: JobStatus[];
};

export type ConnectorKind = "owner-contact" | "imap" | "smtp" | "openai";

export type ConnectorStatus = "enabled" | "disabled";

export type Connector = {
  id: string;
  kind: ConnectorKind;
  status: ConnectorStatus;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type MemoryDocument = {
  id: string;
  slug: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
};

export type AgentPromptMode = "normal" | "quick_reply" | "planning";

export type AgentPromptResponse = {
  runId: string;
  status: string;
  selectedAction: string | null;
  toolStatus: string;
  repaired: boolean;
  toolResult: Record<string, unknown> | null;
  links: {
    taskId: string | null;
    taskEventId: string | null;
    outboundMessageId: string | null;
    memoryDocumentId: string | null;
    memorySlug: string | null;
    clarificationRequestId: string | null;
  };
  failureMessage: string | null;
};

export type KnowledgeEntry = {
  path: string;
  name: string;
  type: "file" | "directory";
  version?: number;
  updatedAt?: string;
  children?: KnowledgeEntry[];
};

export type KnowledgeDocument = {
  id: string;
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

export type KnowledgeSection = {
  id: string;
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

export type ImapTestResult = {
  ok: boolean;
  configured: boolean;
  host?: string;
  port?: number;
  secure?: boolean;
  mailbox?: string;
  usernameSet?: boolean;
  passwordSet?: boolean;
  unseenCount?: number;
  error?: {
    message: string;
    response?: string;
    responseStatus?: string;
    code?: string;
    command?: string;
  };
};

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(apiUrl(path), {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...init.headers
    },
    ...init
  });

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }

  return (await response.json()) as T;
}

export const api = {
  me(): Promise<AuthMeResponse> {
    return request<AuthMeResponse>("/auth/me");
  },
  devLogin(): Promise<AuthMeResponse> {
    return request<AuthMeResponse>("/auth/dev-login", { method: "POST" });
  },
  logout(): Promise<AuthMeResponse> {
    return request<AuthMeResponse>("/auth/logout", { method: "POST" });
  },
  createTask(input: TaskInput): Promise<Task> {
    return request<Task>("/tasks", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  updateTask(id: string, input: Partial<TaskInput> & { status?: string }): Promise<Task> {
    return request<Task>(`/tasks/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    });
  },
  listTaskEvents(id: string): Promise<{ events: TaskEvent[] }> {
    return request<{ events: TaskEvent[] }>(`/tasks/${encodeURIComponent(id)}/events`);
  },
  addTaskPrompt(id: string, prompt: string): Promise<{ task: Task; events: TaskEvent[] }> {
    return request<{ task: Task; events: TaskEvent[] }>(`/tasks/${encodeURIComponent(id)}/prompts`, {
      method: "POST",
      body: JSON.stringify({ prompt })
    });
  },
  listTasks(): Promise<{ tasks: Task[] }> {
    return request<{ tasks: Task[] }>("/tasks");
  },
  listInbox(): Promise<{ messages: InboundMessage[] }> {
    return request<{ messages: InboundMessage[] }>("/messages");
  },
  listOutbox(): Promise<{ messages: OutboxMessage[] }> {
    return request<{ messages: OutboxMessage[] }>("/outbox");
  },
  listApprovals(status = "pending"): Promise<{ approvals: Approval[] }> {
    return request<{ approvals: Approval[] }>(`/approvals?status=${encodeURIComponent(status)}`);
  },
  updateApproval(id: string, input: { decision: "approve" | "reject" } | { decision: "edit"; text: string }): Promise<{ approval: Approval; outbound?: OutboxMessage }> {
    return request<{ approval: Approval; outbound?: OutboxMessage }>(`/approvals/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    });
  },
  rejectStaleApprovals(): Promise<{ rejected: Approval[] }> {
    return request<{ rejected: Approval[] }>("/approvals/stale/reject", { method: "POST" });
  },
  updateOutbox(id: string, status: "pending" | "approved" | "cancelled"): Promise<OutboxMessage> {
    return request<OutboxMessage>(`/outbox/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ status })
    });
  },
  queueOwnerReview(id: string): Promise<{ message: InboundMessage; outbound: OutboxMessage }> {
    return request<{ message: InboundMessage; outbound: OutboxMessage }>(`/messages/${encodeURIComponent(id)}/owner-review`, {
      method: "POST"
    });
  },
  listAudit(): Promise<{ events: AuditEvent[] }> {
    return request<{ events: AuditEvent[] }>("/audit");
  },
  listMemory(): Promise<{ documents: MemoryDocument[] }> {
    return request<{ documents: MemoryDocument[] }>("/memory");
  },
  getMemory(slug: string): Promise<{ document: MemoryDocument }> {
    return request<{ document: MemoryDocument }>(`/memory/${encodeURIComponent(slug)}`);
  },
  submitAgentPrompt(input: {
    prompt: string;
    mode: AgentPromptMode;
    contextTaskId?: string | null;
  }): Promise<AgentPromptResponse> {
    return request<AgentPromptResponse>("/agent/prompts", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  getKnowledgeTree(path = "/", maxDepth = 6): Promise<{ path: string; entries: KnowledgeEntry[] }> {
    return request<{ path: string; entries: KnowledgeEntry[] }>(
      `/knowledge/tree?path=${encodeURIComponent(path)}&maxDepth=${maxDepth}`
    );
  },
  listKnowledgeFiles(path: string): Promise<{ entries: KnowledgeEntry[] }> {
    return request<{ entries: KnowledgeEntry[] }>(`/knowledge/files?path=${encodeURIComponent(path)}`);
  },
  getKnowledgeFile(path: string): Promise<{ document: KnowledgeDocument }> {
    return request<{ document: KnowledgeDocument }>(`/knowledge/files/${encodeURIComponent(path)}`);
  },
  updateKnowledgeFile(path: string, content: string, expectedVersion?: number): Promise<{ document: KnowledgeDocument }> {
    return request<{ document: KnowledgeDocument }>(`/knowledge/files/${encodeURIComponent(path)}`, {
      method: "PUT",
      body: JSON.stringify({ content, expectedVersion })
    });
  },
  listKnowledgeSections(path: string): Promise<{ sections: KnowledgeSection[] }> {
    return request<{ sections: KnowledgeSection[] }>(`/knowledge/files/${encodeURIComponent(path)}/sections`);
  },
  listSenders(): Promise<{ senders: Sender[] }> {
    return request<{ senders: Sender[] }>("/senders");
  },
  listConnectors(): Promise<{ connectors: Connector[] }> {
    return request<{ connectors: Connector[] }>("/connectors");
  },
  updateConnector(kind: ConnectorKind, status: ConnectorStatus, config: Record<string, unknown>): Promise<Connector> {
    return request<Connector>(`/connectors/${encodeURIComponent(kind)}`, {
      method: "PUT",
      body: JSON.stringify({ status, config })
    });
  },
  testImap(): Promise<ImapTestResult> {
    return request<ImapTestResult>("/connectors/imap/test", { method: "POST" });
  },
  setSender(address: string, status: Sender["status"]): Promise<{ senders: Sender[] }> {
    return request<{ senders: Sender[] }>(`/senders/${encodeURIComponent(address)}`, {
      method: "PUT",
      body: JSON.stringify({ status })
    });
  },
  deleteSender(address: string): Promise<{ senders: Sender[] }> {
    return request<{ senders: Sender[] }>(`/senders/${encodeURIComponent(address)}`, {
      method: "DELETE"
    });
  },
  getAiConfig(): Promise<AiConfig> {
    return request<AiConfig>("/admin/ai-config");
  },
  updateAiConfig(config: AiConfig): Promise<AiConfig> {
    return request<AiConfig>("/admin/ai-config", {
      method: "PUT",
      body: JSON.stringify(config)
    });
  },
  listJobs(): Promise<JobsResponse> {
    return request<JobsResponse>("/jobs");
  },
  retryRagIndexJob(id: string): Promise<{ job: RagIndexJob }> {
    return request<{ job: RagIndexJob }>(`/admin/rag-index-jobs/${encodeURIComponent(id)}/retry`, {
      method: "POST"
    });
  },
  async dashboard(): Promise<{
    tasks: Task[];
    inbox: InboundMessage[];
    outbox: OutboxMessage[];
    audit: AuditEvent[];
    senders: Sender[];
    connectors: Connector[];
    aiConfig: AiConfig | null;
    jobs: JobsResponse;
    memory: MemoryDocument[];
  }> {
    const [tasks, inbox, outbox, audit, senders, connectors, aiConfig, jobs, memory] = await Promise.all([
      api.listTasks(),
      api.listInbox(),
      api.listOutbox(),
      api.listAudit(),
      api.listSenders(),
      api.listConnectors(),
      api.getAiConfig().catch(() => null),
      api.listJobs().catch(() => ({ jobs: [] })),
      api.listMemory().catch(() => ({ documents: [] }))
    ]);
    return {
      tasks: tasks.tasks,
      inbox: inbox.messages,
      outbox: outbox.messages,
      audit: audit.events,
      senders: senders.senders,
      connectors: connectors.connectors,
      aiConfig,
      jobs,
      memory: memory.documents
    };
  }
};
