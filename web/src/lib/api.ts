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
  classification: "owner" | "newsletter" | "untrusted" | "blocked";
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
  createdAt: string;
  updatedAt: string;
  sentAt?: string | null;
  failureMessage?: string | null;
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
  pendingMessages?: number;
  approvedMessages?: number;
  sendingMessages?: number;
  failedMessages?: number;
  lastAuditAt?: string | null;
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
  getAiConfig(): Promise<AiConfig> {
    return request<AiConfig>("/admin/ai-config");
  },
  updateAiConfig(config: AiConfig): Promise<AiConfig> {
    return request<AiConfig>("/admin/ai-config", {
      method: "PUT",
      body: JSON.stringify(config)
    });
  },
  listJobs(): Promise<{ jobs: JobStatus[] }> {
    return request<{ jobs: JobStatus[] }>("/admin/jobs");
  },
  async dashboard(): Promise<{
    tasks: Task[];
    inbox: InboundMessage[];
    outbox: OutboxMessage[];
    audit: AuditEvent[];
    senders: Sender[];
    connectors: Connector[];
    aiConfig: AiConfig | null;
    jobs: JobStatus[];
  }> {
    const [tasks, inbox, outbox, audit, senders, connectors, aiConfig, jobs] = await Promise.all([
      api.listTasks(),
      api.listInbox(),
      api.listOutbox(),
      api.listAudit(),
      api.listSenders(),
      api.listConnectors(),
      api.getAiConfig().catch(() => null),
      api.listJobs().catch(() => ({ jobs: [] }))
    ]);
    return {
      tasks: tasks.tasks,
      inbox: inbox.messages,
      outbox: outbox.messages,
      audit: audit.events,
      senders: senders.senders,
      connectors: connectors.connectors,
      aiConfig,
      jobs: jobs.jobs
    };
  }
};
