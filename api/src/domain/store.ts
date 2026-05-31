import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  createSessionFromSettings,
  hashSessionToken,
  type AuthenticatedUser,
  type Session,
  type Tenant
} from "../auth/session.js";
import type { Settings } from "../config/settings.js";
import type {
  AgentStore,
  AgentRunRecord,
  AiConfig,
  AuditRecord,
  RequestContext,
  TaskInput,
  TaskRecord,
  TaskUpdate,
  ToolCallRecord
} from "./types.js";

const DEFAULT_AI_CONFIG: AiConfig = {
  fastModel: "gpt-5-mini",
  smartModel: "gpt-5",
  orchestratorModel: "gpt-5",
  repairModel: "gpt-5-mini",
  maxToolCalls: 10,
  maxRuntimeSec: 120,
  repairAttemptLimit: 1
};

function nowIso(): string {
  return new Date().toISOString();
}

function taskFromRow(row: Record<string, unknown>): TaskRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    status: String(row.status),
    kind: String(row.kind),
    title: String(row.title),
    prompt: String(row.prompt),
    dueAt: row.due_at instanceof Date ? row.due_at.toISOString() : row.due_at ? String(row.due_at) : null,
    priority: Number(row.priority),
    createdBy: String(row.created_by),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at)
  };
}

function auditFromRow(row: Record<string, unknown>): AuditRecord {
  return {
    id: String(row.id),
    tenantId: row.tenant_id ? String(row.tenant_id) : null,
    userId: row.user_id ? String(row.user_id) : null,
    actorType: String(row.actor_type),
    action: String(row.action),
    entityType: row.entity_type ? String(row.entity_type) : null,
    entityId: row.entity_id ? String(row.entity_id) : null,
    details: (row.details_json as Record<string, unknown> | null) ?? {},
    requestId: row.request_id ? String(row.request_id) : null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at)
  };
}

function runFromRow(row: Record<string, unknown>): AgentRunRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    taskId: row.task_id ? String(row.task_id) : null,
    status: String(row.status),
    modelTier: String(row.model_tier),
    modelId: String(row.model_id),
    promptVersion: row.prompt_version ? String(row.prompt_version) : null,
    startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : String(row.started_at),
    finishedAt: row.finished_at instanceof Date ? row.finished_at.toISOString() : row.finished_at ? String(row.finished_at) : null,
    failureMessage: row.failure_message ? String(row.failure_message) : null
  };
}

function toolCallFromRow(row: Record<string, unknown>): ToolCallRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    runId: row.run_id ? String(row.run_id) : null,
    toolName: String(row.tool_name),
    status: String(row.status),
    arguments: (row.arguments_json as Record<string, unknown> | null) ?? {},
    result: (row.result_json as Record<string, unknown> | null) ?? {},
    validationError: row.validation_error ? String(row.validation_error) : null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    completedAt: row.completed_at instanceof Date
      ? row.completed_at.toISOString()
      : row.completed_at
        ? String(row.completed_at)
        : null
  };
}

async function recordAudit(
  pool: Pool,
  context: Pick<RequestContext, "tenantId" | "userId" | "actorType" | "requestId">,
  action: string,
  entityType: string | null,
  entityId: string | null,
  details: Record<string, unknown> = {}
): Promise<void> {
  await pool.query(
    `INSERT INTO audit_log
      (id, tenant_id, user_id, actor_type, action, entity_type, entity_id, details_json, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [randomUUID(), context.tenantId, context.userId, context.actorType, action, entityType, entityId, details, context.requestId]
  );
}

export function createPostgresStore(pool: Pool): AgentStore {
  return {
    async createDevelopmentSession(settings: Settings, requestId: string): Promise<Session> {
      const session = createSessionFromSettings(settings);
      await pool.query(
        `INSERT INTO tenants (id, name)
         VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = now()`,
        [session.tenant.id, session.tenant.name]
      );
      await pool.query(
        `INSERT INTO users (id, email, display_name, is_admin)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE
           SET email = EXCLUDED.email,
               display_name = EXCLUDED.display_name,
               is_admin = EXCLUDED.is_admin,
               updated_at = now()`,
        [session.user.id, session.user.email, session.user.displayName, session.user.isAdmin]
      );
      await pool.query(
        `INSERT INTO tenant_memberships (tenant_id, user_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role, updated_at = now()`,
        [session.tenant.id, session.user.id, session.user.isAdmin ? "admin" : "member"]
      );
      await pool.query(
        `INSERT INTO identities (id, tenant_id, user_id, kind, value, verified_at, is_primary)
         VALUES ($1, $2, $3, 'email', $4, now(), true)
         ON CONFLICT (kind, value) DO UPDATE
           SET tenant_id = EXCLUDED.tenant_id,
               user_id = EXCLUDED.user_id,
               verified_at = EXCLUDED.verified_at,
               is_primary = true,
               updated_at = now()`,
        [randomUUID(), session.tenant.id, session.user.id, session.user.email]
      );
      await pool.query(
        `INSERT INTO sessions (id, token_hash, tenant_id, user_id, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), hashSessionToken(session.id), session.tenant.id, session.user.id, session.expiresAt]
      );
      await recordAudit(
        pool,
        {
          tenantId: session.tenant.id,
          userId: session.user.id,
          actorType: "user",
          requestId
        },
        "auth.dev_login",
        "session",
        null,
        { auth_mode: "standalone" }
      );
      return session;
    },

    async getSession(sessionId: string | undefined): Promise<Session | undefined> {
      if (!sessionId) {
        return undefined;
      }
      const result = await pool.query(
        `SELECT
           s.created_at,
           s.expires_at,
           t.id AS tenant_id,
           t.name AS tenant_name,
           u.id AS user_id,
           u.email,
           u.display_name,
           u.is_admin
         FROM sessions s
         JOIN tenants t ON t.id = s.tenant_id
         JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1
           AND s.revoked_at IS NULL
           AND s.expires_at > now()`,
        [hashSessionToken(sessionId)]
      );
      const row = result.rows[0] as Record<string, unknown> | undefined;
      if (!row) {
        return undefined;
      }
      await pool.query("UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1", [hashSessionToken(sessionId)]);
      return {
        id: sessionId,
        user: {
          id: String(row.user_id),
          email: String(row.email),
          displayName: String(row.display_name),
          isAdmin: Boolean(row.is_admin)
        },
        tenant: {
          id: String(row.tenant_id),
          name: String(row.tenant_name)
        },
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
        expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at)
      };
    },

    async revokeSession(sessionId: string | undefined, requestId: string): Promise<void> {
      const session = await this.getSession(sessionId);
      if (!sessionId || !session) {
        return;
      }
      await pool.query("UPDATE sessions SET revoked_at = now() WHERE token_hash = $1", [hashSessionToken(sessionId)]);
      await recordAudit(
        pool,
        {
          tenantId: session.tenant.id,
          userId: session.user.id,
          actorType: session.user.isAdmin ? "admin" : "user",
          requestId
        },
        "auth.logout",
        "session",
        null
      );
    },

    async createTask(context: RequestContext, input: TaskInput): Promise<TaskRecord> {
      const id = randomUUID();
      const result = await pool.query(
        `INSERT INTO tasks
          (id, tenant_id, user_id, title, prompt, due_at, priority, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          id,
          context.tenantId,
          context.userId,
          input.title,
          input.prompt,
          input.dueAt ?? null,
          input.priority ?? 0,
          context.actorType
        ]
      );
      await pool.query(
        `INSERT INTO task_events (id, tenant_id, user_id, task_id, event_type, event_json)
         VALUES ($1, $2, $3, $4, 'task.created', '{}'::jsonb)`,
        [randomUUID(), context.tenantId, context.userId, id]
      );
      await recordAudit(pool, context, "task.create", "task", id);
      return taskFromRow(result.rows[0]);
    },

    async listTasks(context: RequestContext): Promise<TaskRecord[]> {
      const result = await pool.query(
        `SELECT * FROM tasks
         WHERE tenant_id = $1 AND user_id = $2
         ORDER BY created_at DESC`,
        [context.tenantId, context.userId]
      );
      return result.rows.map(taskFromRow);
    },

    async getTask(context: RequestContext, taskId: string): Promise<TaskRecord | undefined> {
      const result = await pool.query(
        `SELECT * FROM tasks WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
        [taskId, context.tenantId, context.userId]
      );
      return result.rows[0] ? taskFromRow(result.rows[0]) : undefined;
    },

    async updateTask(context: RequestContext, taskId: string, update: TaskUpdate): Promise<TaskRecord | undefined> {
      const existing = await this.getTask(context, taskId);
      if (!existing) {
        return undefined;
      }
      const result = await pool.query(
        `UPDATE tasks
         SET title = $4,
             prompt = $5,
             due_at = $6,
             priority = $7,
             status = $8,
             updated_at = now()
         WHERE id = $1 AND tenant_id = $2 AND user_id = $3
         RETURNING *`,
        [
          taskId,
          context.tenantId,
          context.userId,
          update.title ?? existing.title,
          update.prompt ?? existing.prompt,
          update.dueAt ?? existing.dueAt,
          update.priority ?? existing.priority,
          update.status ?? existing.status
        ]
      );
      await recordAudit(pool, context, "task.update", "task", taskId);
      return result.rows[0] ? taskFromRow(result.rows[0]) : undefined;
    },

    async listAudit(context: RequestContext, includeAllUsers: boolean): Promise<AuditRecord[]> {
      const result = await pool.query(
        includeAllUsers
          ? `SELECT * FROM audit_log WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 200`
          : `SELECT * FROM audit_log WHERE tenant_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 200`,
        includeAllUsers ? [context.tenantId] : [context.tenantId, context.userId]
      );
      return result.rows.map(auditFromRow);
    },

    async getAiConfig(): Promise<AiConfig> {
      const result = await pool.query("SELECT config_json FROM admin_ai_config WHERE id = 'default'");
      return {
        ...DEFAULT_AI_CONFIG,
        ...((result.rows[0]?.config_json as Partial<AiConfig> | undefined) ?? {})
      };
    },

    async updateAiConfig(context: RequestContext, config: AiConfig): Promise<AiConfig> {
      await pool.query(
        `INSERT INTO admin_ai_config (id, config_json, updated_by)
         VALUES ('default', $1, $2)
         ON CONFLICT (id) DO UPDATE
           SET config_json = EXCLUDED.config_json,
               updated_by = EXCLUDED.updated_by,
               updated_at = now()`,
        [config, context.userId]
      );
      await recordAudit(pool, context, "admin.ai_config.update", "admin_ai_config", "default");
      return config;
    },

    async createAgentRun(context, input) {
      const id = randomUUID();
      const result = await pool.query(
        `INSERT INTO agent_runs
          (id, tenant_id, user_id, task_id, status, model_tier, model_id, prompt_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          id,
          context.tenantId,
          context.userId,
          input.taskId ?? null,
          input.status,
          input.modelTier,
          input.modelId,
          input.promptVersion ?? null
        ]
      );
      await recordAudit(pool, context, "agent_run.create", "agent_run", id, {
        model_tier: input.modelTier,
        model_id: input.modelId
      });
      return runFromRow(result.rows[0]);
    },

    async finishAgentRun(context, runId, status, failureMessage = null) {
      await pool.query(
        `UPDATE agent_runs
         SET status = $4, failure_message = $5, finished_at = now()
         WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
        [runId, context.tenantId, context.userId, status, failureMessage]
      );
      await recordAudit(pool, context, `agent_run.${status}`, "agent_run", runId, {
        failure_message: failureMessage
      });
    },

    async recordToolCall(context, input) {
      const result = await pool.query(
        `INSERT INTO tool_calls
          (id, tenant_id, user_id, run_id, tool_name, status, arguments_json, result_json, validation_error, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $6 IN ('accepted', 'rejected', 'failed') THEN now() ELSE NULL END)
         RETURNING *`,
        [
          randomUUID(),
          context.tenantId,
          context.userId,
          input.runId ?? null,
          input.toolName,
          input.status,
          input.arguments,
          input.result ?? {},
          input.validationError ?? null
        ]
      );
      await recordAudit(pool, context, `tool_call.${input.status}`, "tool_call", result.rows[0].id, {
        tool_name: input.toolName,
        validation_error: input.validationError ?? null
      });
      return toolCallFromRow(result.rows[0]);
    }
  };
}

export function createMemoryStore(): AgentStore {
  const sessions = new Map<string, Session>();
  const tasks = new Map<string, TaskRecord>();
  const runs = new Map<string, AgentRunRecord>();
  const toolCalls = new Map<string, ToolCallRecord>();
  const audit: AuditRecord[] = [];
  let aiConfig = DEFAULT_AI_CONFIG;

  function pushAudit(
    context: Pick<RequestContext, "tenantId" | "userId" | "actorType" | "requestId">,
    action: string,
    entityType: string | null,
    entityId: string | null,
    details: Record<string, unknown> = {}
  ): void {
    audit.unshift({
      id: randomUUID(),
      tenantId: context.tenantId,
      userId: context.userId,
      actorType: context.actorType,
      action,
      entityType,
      entityId,
      details,
      requestId: context.requestId,
      createdAt: nowIso()
    });
  }

  return {
    async createDevelopmentSession(settings: Settings, requestId: string): Promise<Session> {
      const session = createSessionFromSettings(settings);
      sessions.set(session.id, session);
      pushAudit(
        {
          tenantId: session.tenant.id,
          userId: session.user.id,
          actorType: session.user.isAdmin ? "admin" : "user",
          requestId
        },
        "auth.dev_login",
        "session",
        null,
        { auth_mode: "standalone" }
      );
      return session;
    },
    async getSession(sessionId: string | undefined): Promise<Session | undefined> {
      if (!sessionId) {
        return undefined;
      }
      const session = sessions.get(sessionId);
      if (!session || Date.parse(session.expiresAt) <= Date.now()) {
        sessions.delete(sessionId);
        return undefined;
      }
      return session;
    },
    async revokeSession(sessionId: string | undefined, requestId: string): Promise<void> {
      const session = sessionId ? sessions.get(sessionId) : undefined;
      if (sessionId) {
        sessions.delete(sessionId);
      }
      if (session) {
        pushAudit(
          {
            tenantId: session.tenant.id,
            userId: session.user.id,
            actorType: session.user.isAdmin ? "admin" : "user",
            requestId
          },
          "auth.logout",
          "session",
          null
        );
      }
    },
    async createTask(context: RequestContext, input: TaskInput): Promise<TaskRecord> {
      const now = nowIso();
      const task: TaskRecord = {
        id: randomUUID(),
        tenantId: context.tenantId,
        userId: context.userId,
        status: "pending",
        kind: "manual",
        title: input.title,
        prompt: input.prompt,
        dueAt: input.dueAt ?? null,
        priority: input.priority ?? 0,
        createdBy: context.actorType,
        createdAt: now,
        updatedAt: now
      };
      tasks.set(task.id, task);
      pushAudit(context, "task.create", "task", task.id);
      return task;
    },
    async listTasks(context: RequestContext): Promise<TaskRecord[]> {
      return [...tasks.values()].filter((task) => task.tenantId === context.tenantId && task.userId === context.userId);
    },
    async getTask(context: RequestContext, taskId: string): Promise<TaskRecord | undefined> {
      const task = tasks.get(taskId);
      if (!task || task.tenantId !== context.tenantId || task.userId !== context.userId) {
        return undefined;
      }
      return task;
    },
    async updateTask(context: RequestContext, taskId: string, update: TaskUpdate): Promise<TaskRecord | undefined> {
      const task = await this.getTask(context, taskId);
      if (!task) {
        return undefined;
      }
      const updated = {
        ...task,
        ...update,
        dueAt: update.dueAt === undefined ? task.dueAt : update.dueAt,
        updatedAt: nowIso()
      };
      tasks.set(taskId, updated);
      pushAudit(context, "task.update", "task", taskId);
      return updated;
    },
    async listAudit(context: RequestContext, includeAllUsers: boolean): Promise<AuditRecord[]> {
      return audit.filter((entry) => {
        if (entry.tenantId !== context.tenantId) {
          return false;
        }
        return includeAllUsers || entry.userId === context.userId;
      });
    },
    async getAiConfig(): Promise<AiConfig> {
      return aiConfig;
    },
    async updateAiConfig(context: RequestContext, config: AiConfig): Promise<AiConfig> {
      aiConfig = config;
      pushAudit(context, "admin.ai_config.update", "admin_ai_config", "default");
      return aiConfig;
    },
    async createAgentRun(context, input) {
      const now = nowIso();
      const run: AgentRunRecord = {
        id: randomUUID(),
        tenantId: context.tenantId,
        userId: context.userId,
        taskId: input.taskId ?? null,
        status: input.status,
        modelTier: input.modelTier,
        modelId: input.modelId,
        promptVersion: input.promptVersion ?? null,
        startedAt: now,
        finishedAt: null,
        failureMessage: null
      };
      runs.set(run.id, run);
      pushAudit(context, "agent_run.create", "agent_run", run.id, {
        model_tier: input.modelTier,
        model_id: input.modelId
      });
      return run;
    },
    async finishAgentRun(context, runId, status, failureMessage = null) {
      const run = runs.get(runId);
      if (run) {
        runs.set(runId, {
          ...run,
          status,
          finishedAt: nowIso(),
          failureMessage
        });
      }
      pushAudit(context, `agent_run.${status}`, "agent_run", runId, {
        failure_message: failureMessage
      });
    },
    async recordToolCall(context, input) {
      const now = nowIso();
      const toolCall: ToolCallRecord = {
        id: randomUUID(),
        tenantId: context.tenantId,
        userId: context.userId,
        runId: input.runId ?? null,
        toolName: input.toolName,
        status: input.status,
        arguments: input.arguments,
        result: input.result ?? {},
        validationError: input.validationError ?? null,
        createdAt: now,
        completedAt: ["accepted", "rejected", "failed"].includes(input.status) ? now : null
      };
      toolCalls.set(toolCall.id, toolCall);
      pushAudit(context, `tool_call.${input.status}`, "tool_call", toolCall.id, {
        tool_name: input.toolName,
        validation_error: input.validationError ?? null
      });
      return toolCall;
    }
  };
}
