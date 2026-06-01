import { apiUrl } from "./basePath";

export type AuthUser = {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
};

export type Tenant = {
  id: string;
  name: string;
};

export type AuthMeResponse = {
  authenticated: boolean;
  user: AuthUser | null;
  tenant: Tenant | null;
  expiresAt?: string;
};

export type Task = {
  id: string;
  status: string;
  title: string;
  prompt: string;
  dueAt: string | null;
  priority: number;
};

export type TaskInput = {
  title: string;
  prompt: string;
  dueAt?: string | null;
  priority?: number;
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
  updateOutbox(id: string, status: "pending" | "approved" | "cancelled"): Promise<OutboxMessage> {
    return request<OutboxMessage>(`/outbox/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ status })
    });
  },
  setSender(address: string, status: Sender["status"]): Promise<{ senders: Sender[] }> {
    return request<{ senders: Sender[] }>(`/senders/${encodeURIComponent(address)}`, {
      method: "PUT",
      body: JSON.stringify({ status })
    });
  },
  updateAiConfig(config: AiConfig): Promise<AiConfig> {
    return request<AiConfig>("/admin/ai-config", {
      method: "PUT",
      body: JSON.stringify(config)
    });
  },
  async dashboard(): Promise<{
    tasks: Task[];
    outbox: OutboxMessage[];
    audit: AuditEvent[];
    senders: Sender[];
    aiConfig: AiConfig | null;
    jobs: JobStatus[];
  }> {
    const [tasks, outbox, audit, senders, aiConfig, jobs] = await Promise.all([
      request<{ tasks: Task[] }>("/tasks"),
      request<{ messages: OutboxMessage[] }>("/outbox"),
      request<{ events: AuditEvent[] }>("/audit"),
      request<{ senders: Sender[] }>("/senders"),
      request<AiConfig>("/admin/ai-config").catch(() => null),
      request<{ jobs: JobStatus[] }>("/admin/jobs").catch(() => ({ jobs: [] }))
    ]);
    return {
      tasks: tasks.tasks,
      outbox: outbox.messages,
      audit: audit.events,
      senders: senders.senders,
      aiConfig,
      jobs: jobs.jobs
    };
  }
};
