import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  createSessionFromSettings,
  hashSessionToken,
  type AuthenticatedUser,
  type Session
} from "../auth/session.js";
import type { Settings } from "../config/settings.js";
import type {
  AgentStore,
  AgentRunRecord,
  AiConfig,
  AuditRecord,
  InboundMessageInput,
  OutboundMessageRecord,
  RequestContext,
  SenderClassification,
  SenderRecord,
  SenderStatus,
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

function hashOauthState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

function taskFromRow(row: Record<string, unknown>): TaskRecord {
  return {
    id: String(row.id),
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

function outboundFromRow(row: Record<string, unknown>): OutboundMessageRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    conversationId: row.conversation_id ? String(row.conversation_id) : null,
    approvalId: row.approval_id ? String(row.approval_id) : null,
    channel: row.channel as OutboundMessageRecord["channel"],
    status: row.status as OutboundMessageRecord["status"],
    toAddr: String(row.to_addr),
    subject: row.subject ? String(row.subject) : null,
    bodyText: String(row.body_text),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    sentAt: row.sent_at instanceof Date ? row.sent_at.toISOString() : row.sent_at ? String(row.sent_at) : null,
    failureMessage: row.failure_message ? String(row.failure_message) : null
  };
}

function senderFromRow(row: Record<string, unknown>): SenderRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    address: String(row.address),
    status: row.status as SenderStatus,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at)
  };
}

function runFromRow(row: Record<string, unknown>): AgentRunRecord {
  return {
    id: String(row.id),
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
  context: Pick<RequestContext, "userId" | "actorType" | "requestId">,
  action: string,
  entityType: string | null,
  entityId: string | null,
  details: Record<string, unknown> = {}
): Promise<void> {
  await pool.query(
    `INSERT INTO audit_log
      (id, user_id, actor_type, action, entity_type, entity_id, details_json, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [randomUUID(), context.userId, context.actorType, action, entityType, entityId, details, context.requestId]
  );
}

export function createPostgresStore(pool: Pool): AgentStore {
  return {
    async createDevelopmentSession(settings: Settings, requestId: string): Promise<Session> {
      const session = createSessionFromSettings(settings);
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
        `INSERT INTO identities (id, user_id, kind, value, verified_at, is_primary)
         VALUES ($1, $2, 'email', $3, now(), true)
         ON CONFLICT (kind, value) DO UPDATE
           SET user_id = EXCLUDED.user_id,
               verified_at = EXCLUDED.verified_at,
               is_primary = true,
               updated_at = now()`,
        [randomUUID(), session.user.id, session.user.email]
      );
      await pool.query(
        `INSERT INTO sessions (id, token_hash, user_id, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [randomUUID(), hashSessionToken(session.id), session.user.id, session.expiresAt]
      );
      await recordAudit(
        pool,
        {
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

    async createOauthState(input) {
      await pool.query(
        `INSERT INTO oauth_state_records (id, state_hash, code_verifier, next_path, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), hashOauthState(input.state), input.codeVerifier, input.nextPath, input.expiresAt]
      );
    },

    async consumeOauthState(state) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query(
          `SELECT id, code_verifier, next_path
           FROM oauth_state_records
           WHERE state_hash = $1
             AND consumed_at IS NULL
             AND expires_at > now()
           FOR UPDATE`,
          [hashOauthState(state)]
        );
        const row = result.rows[0] as Record<string, unknown> | undefined;
        if (!row) {
          await client.query("COMMIT");
          return undefined;
        }
        await client.query("UPDATE oauth_state_records SET consumed_at = now() WHERE id = $1", [row.id]);
        await client.query("COMMIT");
        return {
          codeVerifier: String(row.code_verifier),
          nextPath: String(row.next_path ?? "/")
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async createOauthSession(settings, input) {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + settings.sessionDurationMinutes * 60_000);
      const sessionId = randomUUID();
      const userId = `oauth:${input.identityProvider}:${input.subject}`;
      await pool.query(
        `INSERT INTO users (id, email, display_name, is_admin)
         VALUES ($1, lower($2), $3, $4)
         ON CONFLICT (id) DO UPDATE
           SET email = EXCLUDED.email,
               display_name = EXCLUDED.display_name,
               is_admin = EXCLUDED.is_admin,
               updated_at = now()`,
        [userId, input.email, input.displayName, input.isAdmin]
      );
      await pool.query(
        `INSERT INTO identities (id, user_id, kind, value, verified_at, is_primary)
         VALUES ($1, $2, $3, $4, now(), true)
         ON CONFLICT (kind, value) DO UPDATE
           SET user_id = EXCLUDED.user_id,
               verified_at = now(),
               is_primary = true,
               updated_at = now()`,
        [randomUUID(), userId, input.identityProvider, input.subject]
      );
      await pool.query(
        `INSERT INTO sessions (id, token_hash, user_id, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [randomUUID(), hashSessionToken(sessionId), userId, expiresAt.toISOString()]
      );
      await recordAudit(
        pool,
        {
          userId,
          actorType: input.isAdmin ? "admin" : "user",
          requestId: input.requestId
        },
        "auth.oauth_login",
        "session",
        null,
        { identity_provider: input.identityProvider }
      );
      return {
        id: sessionId,
        user: {
          id: userId,
          email: input.email,
          displayName: input.displayName,
          isAdmin: input.isAdmin
        },
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString()
      };
    },

    async getSession(sessionId: string | undefined): Promise<Session | undefined> {
      if (!sessionId) {
        return undefined;
      }
      const result = await pool.query(
        `SELECT
           s.created_at,
           s.expires_at,
           u.id AS user_id,
           u.email,
           u.display_name,
           u.is_admin
         FROM sessions s
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
          (id, user_id, title, prompt, due_at, priority, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          id,
          context.userId,
          input.title,
          input.prompt,
          input.dueAt ?? null,
          input.priority ?? 0,
          context.actorType
        ]
      );
      await pool.query(
        `INSERT INTO task_events (id, user_id, task_id, event_type, event_json)
         VALUES ($1, $2, $3, 'task.created', '{}'::jsonb)`,
        [randomUUID(), context.userId, id]
      );
      await recordAudit(pool, context, "task.create", "task", id);
      return taskFromRow(result.rows[0]);
    },

    async listTasks(context: RequestContext): Promise<TaskRecord[]> {
      const result = await pool.query(
        `SELECT * FROM tasks
         WHERE user_id = $1
         ORDER BY created_at DESC`,
        [context.userId]
      );
      return result.rows.map(taskFromRow);
    },

    async getTask(context: RequestContext, taskId: string): Promise<TaskRecord | undefined> {
      const result = await pool.query(
        `SELECT * FROM tasks WHERE id = $1 AND user_id = $2`,
        [taskId, context.userId]
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
         SET title = $3,
             prompt = $4,
             due_at = $5,
             priority = $6,
             status = $7,
             updated_at = now()
         WHERE id = $1 AND user_id = $2
         RETURNING *`,
        [
          taskId,
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

    async claimDueTasks(context: RequestContext, limit: number, now = new Date()): Promise<TaskRecord[]> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const selected = await client.query(
          `SELECT id FROM tasks
           WHERE user_id = $1
             AND status = 'pending'
             AND (due_at IS NULL OR due_at <= $2)
           ORDER BY due_at NULLS FIRST, created_at ASC
           LIMIT $3
           FOR UPDATE SKIP LOCKED`,
          [context.userId, now.toISOString(), limit]
        );
        const ids = selected.rows.map((row) => row.id as string);
        if (ids.length === 0) {
          await client.query("COMMIT");
          return [];
        }
        const updated = await client.query(
          `UPDATE tasks
           SET status = 'claimed', updated_at = now()
           WHERE id = ANY($1::text[])
           RETURNING *`,
          [ids]
        );
        await client.query("COMMIT");
        for (const id of ids) {
          await recordAudit(pool, context, "task.claim", "task", id);
        }
        return updated.rows.map(taskFromRow);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async listAudit(context: RequestContext, includeAllUsers: boolean): Promise<AuditRecord[]> {
      const result = await pool.query(
        includeAllUsers
          ? `SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200`
          : `SELECT * FROM audit_log WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200`,
        includeAllUsers ? [] : [context.userId]
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
          (id, user_id, task_id, status, model_tier, model_id, prompt_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          id,
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
         SET status = $3, failure_message = $4, finished_at = now()
         WHERE id = $1 AND user_id = $2`,
        [runId, context.userId, status, failureMessage]
      );
      await recordAudit(pool, context, `agent_run.${status}`, "agent_run", runId, {
        failure_message: failureMessage
      });
    },

    async recordToolCall(context, input) {
      const result = await pool.query(
        `INSERT INTO tool_calls
          (id, user_id, run_id, tool_name, status, arguments_json, result_json, validation_error, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $5 IN ('accepted', 'rejected', 'failed') THEN now() ELSE NULL END)
         RETURNING *`,
        [
          randomUUID(),
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
    },

    async listSenders(context) {
      const result = await pool.query(
        `SELECT * FROM senders
         WHERE user_id = $1
         ORDER BY updated_at DESC, address ASC`,
        [context.userId]
      );
      return result.rows.map(senderFromRow);
    },

    async getSenderStatus(context, address) {
      const result = await pool.query(
        `SELECT status FROM senders
         WHERE user_id = $1 AND lower(address) = lower($2)`,
        [context.userId, address]
      );
      return result.rows[0]?.status as SenderStatus | undefined;
    },

    async setSenderStatus(context, address, status) {
      await pool.query(
        `INSERT INTO senders (id, user_id, address, status)
         VALUES ($1, $2, lower($3), $4)
         ON CONFLICT (user_id, address) DO UPDATE
           SET status = EXCLUDED.status, updated_at = now()`,
        [randomUUID(), context.userId, address, status]
      );
      await recordAudit(pool, context, "sender.status.set", "sender", address, { status });
    },

    async recordInboundMessage(context, input: InboundMessageInput, classification: SenderClassification) {
      const existing = await pool.query(
        `SELECT id FROM messages
         WHERE user_id = $1 AND provider_message_id = $2`,
        [context.userId, input.providerMessageId]
      );
      if (existing.rows[0]) {
        return { id: existing.rows[0].id as string, duplicate: true };
      }
      const id = randomUUID();
      await pool.query(
        `INSERT INTO messages
          (id, user_id, direction, source, provider_message_id, from_addr, to_addr, subject, body_text,
           auth_status, received_at)
         VALUES ($1, $2, 'inbound', $3, $4, lower($5), lower($6), $7, $8, $9, $10)`,
        [
          id,
          context.userId,
          input.source ?? "imap",
          input.providerMessageId,
          input.fromAddr,
          input.toAddr,
          input.subject ?? null,
          input.bodyText,
          classification,
          input.receivedAt ?? new Date().toISOString()
        ]
      );
      await recordAudit(pool, context, "message.inbound.record", "message", id, { classification });
      return { id, duplicate: false };
    },

    async queueOutboundMessage(context, input) {
      const result = await pool.query(
        `INSERT INTO outbound_messages
          (id, user_id, conversation_id, approval_id, channel, status, to_addr, subject, body_text)
         VALUES ($1, $2, $3, $4, $5, $6, lower($7), $8, $9)
         RETURNING *`,
        [
          randomUUID(),
          context.userId,
          input.conversationId ?? null,
          input.approvalId ?? null,
          input.channel,
          input.status,
          input.toAddr,
          input.subject ?? null,
          input.bodyText
        ]
      );
      const record = outboundFromRow(result.rows[0]);
      await recordAudit(pool, context, "outbound.queue", "outbound_message", record.id, {
        channel: record.channel,
        status: record.status
      });
      return record;
    },

    async listOutboundMessages(context, statuses) {
      const statusFilter = statuses && statuses.length > 0;
      const result = await pool.query(
        statusFilter
          ? `SELECT * FROM outbound_messages
             WHERE user_id = $1 AND status = ANY($2::text[])
             ORDER BY created_at ASC`
          : `SELECT * FROM outbound_messages
             WHERE user_id = $1
             ORDER BY created_at DESC`,
        statusFilter ? [context.userId, statuses] : [context.userId]
      );
      return result.rows.map(outboundFromRow);
    },

    async updateOutboundMessageStatus(context, messageId, status, failureMessage = null) {
      const result = await pool.query(
        `UPDATE outbound_messages
         SET status = $3,
             failure_message = $4,
             sent_at = CASE WHEN $3 = 'sent' THEN now() ELSE sent_at END,
             updated_at = now()
         WHERE id = $1 AND user_id = $2
         RETURNING *`,
        [messageId, context.userId, status, failureMessage]
      );
      const record = result.rows[0] ? outboundFromRow(result.rows[0]) : undefined;
      if (record) {
        await recordAudit(pool, context, `outbound.${status}`, "outbound_message", messageId, {
          failure_message: failureMessage
        });
      }
      return record;
    }
  };
}

export function createMemoryStore(): AgentStore {
  const sessions = new Map<string, Session>();
  const tasks = new Map<string, TaskRecord>();
  const runs = new Map<string, AgentRunRecord>();
  const toolCalls = new Map<string, ToolCallRecord>();
  const senderStatuses = new Map<string, SenderRecord>();
  const inboundProviderIds = new Map<string, string>();
  const outboundMessages = new Map<string, OutboundMessageRecord>();
  const audit: AuditRecord[] = [];
  let aiConfig = DEFAULT_AI_CONFIG;

  function pushAudit(
    context: Pick<RequestContext, "userId" | "actorType" | "requestId">,
    action: string,
    entityType: string | null,
    entityId: string | null,
    details: Record<string, unknown> = {}
  ): void {
    audit.unshift({
      id: randomUUID(),
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
    async createOauthState(input) {
      sessions.set(`oauth-state:${input.state}`, {
        id: input.codeVerifier,
        user: {
          id: input.nextPath,
          email: "",
          displayName: "",
          isAdmin: false
        },
        createdAt: nowIso(),
        expiresAt: input.expiresAt
      });
    },
    async consumeOauthState(state) {
      const record = sessions.get(`oauth-state:${state}`);
      sessions.delete(`oauth-state:${state}`);
      if (!record || Date.parse(record.expiresAt) <= Date.now()) {
        return undefined;
      }
      return {
        codeVerifier: record.id,
        nextPath: record.user.id
      };
    },
    async createOauthSession(settings, input) {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + settings.sessionDurationMinutes * 60_000);
      const session: Session = {
        id: randomUUID(),
        user: {
          id: `oauth:${input.identityProvider}:${input.subject}`,
          email: input.email,
          displayName: input.displayName,
          isAdmin: input.isAdmin
        },
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString()
      };
      sessions.set(session.id, session);
      pushAudit(
        {
          userId: session.user.id,
          actorType: session.user.isAdmin ? "admin" : "user",
          requestId: input.requestId
        },
        "auth.oauth_login",
        "session",
        null,
        { identity_provider: input.identityProvider }
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
      return [...tasks.values()].filter((task) => task.userId === context.userId);
    },
    async getTask(context: RequestContext, taskId: string): Promise<TaskRecord | undefined> {
      const task = tasks.get(taskId);
      if (!task || task.userId !== context.userId) {
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
    async claimDueTasks(context: RequestContext, limit: number, now = new Date()): Promise<TaskRecord[]> {
      const claimed: TaskRecord[] = [];
      for (const task of tasks.values()) {
        if (claimed.length >= limit) {
          break;
        }
        const isDue = task.dueAt === null || Date.parse(task.dueAt) <= now.getTime();
        if (task.userId === context.userId && task.status === "pending" && isDue) {
          const updated = { ...task, status: "claimed", updatedAt: nowIso() };
          tasks.set(task.id, updated);
          claimed.push(updated);
          pushAudit(context, "task.claim", "task", task.id);
        }
      }
      return claimed;
    },
    async listAudit(context: RequestContext, includeAllUsers: boolean): Promise<AuditRecord[]> {
      return audit.filter((entry) => {
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
    },
    async listSenders(context) {
      return [...senderStatuses.values()]
        .filter((sender) => sender.userId === context.userId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.address.localeCompare(b.address));
    },
    async getSenderStatus(context, address) {
      return senderStatuses.get(`${context.userId}:${address.toLowerCase()}`)?.status;
    },
    async setSenderStatus(context, address, status) {
      const key = `${context.userId}:${address.toLowerCase()}`;
      const existing = senderStatuses.get(key);
      const now = nowIso();
      senderStatuses.set(key, {
        id: existing?.id ?? randomUUID(),
        userId: context.userId,
        address: address.toLowerCase(),
        status,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      });
      pushAudit(context, "sender.status.set", "sender", address, { status });
    },
    async recordInboundMessage(context, input, classification) {
      const key = `${context.userId}:${input.providerMessageId}`;
      const existing = inboundProviderIds.get(key);
      if (existing) {
        return { id: existing, duplicate: true };
      }
      const id = randomUUID();
      inboundProviderIds.set(key, id);
      pushAudit(context, "message.inbound.record", "message", id, { classification });
      return { id, duplicate: false };
    },
    async queueOutboundMessage(context, input) {
      const now = nowIso();
      const message: OutboundMessageRecord = {
        ...input,
        id: randomUUID(),
        userId: context.userId,
        conversationId: input.conversationId ?? null,
        approvalId: input.approvalId ?? null,
        subject: input.subject ?? null,
        createdAt: now,
        updatedAt: now,
        sentAt: null,
        failureMessage: null
      };
      outboundMessages.set(message.id, message);
      pushAudit(context, "outbound.queue", "outbound_message", message.id, {
        channel: message.channel,
        status: message.status
      });
      return message;
    },
    async listOutboundMessages(context, statuses) {
      return [...outboundMessages.values()].filter((message) => {
        if (message.userId !== context.userId) {
          return false;
        }
        return !statuses || statuses.length === 0 || statuses.includes(message.status);
      });
    },
    async updateOutboundMessageStatus(context, messageId, status, failureMessage = null) {
      const message = outboundMessages.get(messageId);
      if (!message || message.userId !== context.userId) {
        return undefined;
      }
      const updated = {
        ...message,
        status,
        updatedAt: nowIso(),
        sentAt: status === "sent" ? nowIso() : message.sentAt,
        failureMessage
      };
      outboundMessages.set(messageId, updated);
      pushAudit(context, `outbound.${status}`, "outbound_message", messageId, {
        failure_message: failureMessage
      });
      return updated;
    }
  };
}
