import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  createSessionFromSettings,
  hashSessionToken,
  type AuthenticatedUser,
  type Session
} from "../auth/session.js";
import type { Settings } from "../config/settings.js";
import {
  appendToSectionMarkdown,
  basenameForPath,
  hashMarkdown,
  memorySlugToMarkdownPath,
  normalizeMarkdownDirectory,
  normalizeMarkdownPath,
  parseMarkdownSections,
  replaceSectionMarkdown,
  titleFromMarkdown
} from "../memory/markdownFilesystem.js";
import type {
  AgentStore,
  AgentMcpSession,
  AgentRunRecord,
  ApprovalInput,
  ApprovalRecord,
  ApprovalStatus,
  AiConfig,
  ConnectorInput,
  ConnectorKind,
  ConnectorRecord,
  ConnectorStatus,
  AuditRecord,
  InboundMessageInput,
  InboundMessageRecord,
  MarkdownConflict,
  MarkdownDirectoryEntry,
  MarkdownDocumentRecord,
  MarkdownHeadingMatch,
  MarkdownIndexStatus,
  MarkdownSectionRecord,
  MemoryDocumentRecord,
  OutboundMessageRecord,
  RagDocumentChunkInput,
  RagDocumentChunkRecord,
  RagIndexJobRecord,
  RagIndexJobType,
  RagUserIndexHealthRecord,
  RequestContext,
  SenderClassification,
  SenderRecord,
  SenderStatus,
  TaskEventRecord,
  TaskInput,
  TaskRecord,
  TaskUpdate,
  ToolCallRecord
} from "./types.js";
import { qdrantCollectionForUser } from "../rag/qdrant.js";

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
  const scheduleContext = (row.schedule_context_json as Record<string, unknown> | null) ?? {};
  return {
    id: String(row.id),
    userId: String(row.user_id),
    status: String(row.status),
    kind: String(row.kind),
    title: String(row.title),
    prompt: String(row.prompt),
    dueAt: row.due_at instanceof Date ? row.due_at.toISOString() : row.due_at ? String(row.due_at) : null,
    priority: Number(row.priority),
    scheduleRationale: typeof scheduleContext.schedule_rationale === "string" ? scheduleContext.schedule_rationale : null,
    sourceMemoryPath: typeof scheduleContext.source_memory_path === "string" ? scheduleContext.source_memory_path : null,
    sourceMessageId: typeof scheduleContext.source_message_id === "string" ? scheduleContext.source_message_id : null,
    sourceTaskId: typeof scheduleContext.source_task_id === "string" ? scheduleContext.source_task_id : null,
    recurrencePolicy: typeof scheduleContext.recurrence_policy === "string" ? scheduleContext.recurrence_policy : null,
    lastAgentReviewAt: typeof scheduleContext.last_agent_review_at === "string" ? scheduleContext.last_agent_review_at : null,
    nextReviewAt: typeof scheduleContext.next_review_at === "string" ? scheduleContext.next_review_at : null,
    waitingOn: typeof scheduleContext.waiting_on === "string" ? scheduleContext.waiting_on : null,
    blockedReason: typeof scheduleContext.blocked_reason === "string" ? scheduleContext.blocked_reason : null,
    ownerClarificationNeeded: scheduleContext.owner_clarification_needed === true,
    createdBy: String(row.created_by),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at)
  };
}

function scheduleContextFromTaskInput(input: TaskInput): Record<string, unknown> {
  return Object.fromEntries(Object.entries({
    schedule_rationale: input.scheduleRationale ?? null,
    source_memory_path: input.sourceMemoryPath ?? null,
    source_message_id: input.sourceMessageId ?? null,
    source_task_id: input.sourceTaskId ?? null,
    recurrence_policy: input.recurrencePolicy ?? null,
    next_review_at: input.nextReviewAt ?? null
  }).filter(([, value]) => value !== null && value !== undefined));
}

function scheduleContextFromTaskUpdate(existing: TaskRecord, update: TaskUpdate): Record<string, unknown> {
  return Object.fromEntries(Object.entries({
    schedule_rationale: update.scheduleRationale === undefined ? existing.scheduleRationale : update.scheduleRationale,
    source_memory_path: update.sourceMemoryPath === undefined ? existing.sourceMemoryPath : update.sourceMemoryPath,
    source_message_id: update.sourceMessageId === undefined ? existing.sourceMessageId : update.sourceMessageId,
    source_task_id: update.sourceTaskId === undefined ? existing.sourceTaskId : update.sourceTaskId,
    recurrence_policy: update.recurrencePolicy === undefined ? existing.recurrencePolicy : update.recurrencePolicy,
    last_agent_review_at: update.lastAgentReviewAt === undefined ? existing.lastAgentReviewAt : update.lastAgentReviewAt,
    next_review_at: update.nextReviewAt === undefined ? existing.nextReviewAt : update.nextReviewAt,
    waiting_on: update.waitingOn === undefined ? existing.waitingOn : update.waitingOn,
    blocked_reason: update.blockedReason === undefined ? existing.blockedReason : update.blockedReason,
    owner_clarification_needed: update.ownerClarificationNeeded === undefined
      ? existing.ownerClarificationNeeded
      : update.ownerClarificationNeeded
  }).filter(([, value]) => value !== null && value !== undefined && value !== false));
}

function taskEventSummary(eventType: string, details: Record<string, unknown>): string {
  if (typeof details.summary === "string" && details.summary.trim()) {
    return details.summary;
  }
  if (eventType === "task.created") {
    return "Task created.";
  }
  if (eventType === "task.updated" && typeof details.status === "object" && details.status !== null) {
    const status = details.status as { from?: unknown; to?: unknown };
    return `Status changed from ${String(status.from ?? "unknown")} to ${String(status.to ?? "unknown")}.`;
  }
  if (eventType === "task.prompt_added") {
    return "A follow-up prompt was added to the task.";
  }
  if (eventType === "task.claim") {
    return "Worker claimed the task for processing.";
  }
  if (eventType === "agent_run.create") {
    return "Agent run started.";
  }
  if (eventType.startsWith("agent_run.")) {
    return `Agent run ${eventType.replace("agent_run.", "")}.`;
  }
  if (eventType.startsWith("tool_call.")) {
    return `Tool call ${eventType.replace("tool_call.", "")}.`;
  }
  if (eventType === "message.inbound.record") {
    return "Inbound message recorded.";
  }
  if (eventType === "outbound.queue") {
    return "Outbound message queued.";
  }
  if (eventType.startsWith("outbound.")) {
    return `Outbound message ${eventType.replace("outbound.", "")}.`;
  }
  return eventType;
}

function taskEventFromRow(row: Record<string, unknown>): TaskEventRecord {
  const details = (row.event_json as Record<string, unknown> | null) ?? {};
  return {
    id: String(row.id),
    userId: String(row.user_id),
    taskId: String(row.task_id),
    eventType: String(row.event_type),
    summary: taskEventSummary(String(row.event_type), details),
    details,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at)
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

function approvalFromRow(row: Record<string, unknown>): ApprovalRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    status: row.status as ApprovalStatus,
    actionType: row.action_type as ApprovalRecord["actionType"],
    sourceRunId: row.source_run_id ? String(row.source_run_id) : null,
    sourceRef: row.source_ref ? String(row.source_ref) : null,
    proposedPayload: (row.action_json as Record<string, unknown> | null) ?? {},
    riskLevel: row.risk_level as ApprovalRecord["riskLevel"],
    summary: String(row.summary ?? ""),
    expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at ? String(row.expires_at) : "",
    requestedBy: String(row.requested_by),
    decidedBy: row.decided_by ? String(row.decided_by) : null,
    decidedAt: row.decided_at instanceof Date ? row.decided_at.toISOString() : row.decided_at ? String(row.decided_at) : null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at)
  };
}

function inboundFromRow(row: Record<string, unknown>): InboundMessageRecord {
  const authJson = (row.auth_json as Record<string, unknown> | null) ?? {};
  return {
    id: String(row.id),
    userId: String(row.user_id),
    providerMessageId: String(row.provider_message_id ?? ""),
    fromAddr: String(row.from_addr ?? ""),
    toAddr: String(row.to_addr ?? ""),
    subject: row.subject ? String(row.subject) : null,
    bodyText: String(row.body_text ?? ""),
    receivedAt: row.received_at instanceof Date ? row.received_at.toISOString() : row.received_at ? String(row.received_at) : null,
    source: String(row.source ?? "imap"),
    classification: row.auth_status as InboundMessageRecord["classification"],
    handlingAction: typeof authJson.handling_action === "string"
      ? authJson.handling_action as InboundMessageRecord["handlingAction"]
      : null,
    taskId: typeof authJson.task_id === "string" ? authJson.task_id : null,
    taskEventId: typeof authJson.task_event_id === "string" ? authJson.task_event_id : null,
    agentRunId: typeof authJson.agent_run_id === "string" ? authJson.agent_run_id : null,
    outboundMessageId: typeof authJson.outbound_message_id === "string" ? authJson.outbound_message_id : null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at)
  };
}

function connectorFromRow(row: Record<string, unknown>): ConnectorRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    kind: String(row.kind) as ConnectorKind,
    status: String(row.status) as ConnectorStatus,
    config: (row.config_json as Record<string, unknown> | null) ?? {},
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at)
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

function memoryDocumentFromRow(row: Record<string, unknown>): MemoryDocumentRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    slug: String(row.slug),
    title: String(row.title),
    body: String(row.body ?? ""),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at)
  };
}

function markdownDocumentFromRow(row: Record<string, unknown>): MarkdownDocumentRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    path: String(row.path),
    basename: String(row.basename),
    title: row.title ? String(row.title) : null,
    markdown: String(row.markdown ?? ""),
    contentHash: String(row.content_hash),
    version: Number(row.version),
    indexStatus: String(row.index_status),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at)
  };
}

function markdownSectionFromRow(row: Record<string, unknown>): MarkdownSectionRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    documentId: String(row.document_id),
    documentVersion: Number(row.document_version),
    sectionId: String(row.section_id),
    parentSectionId: row.parent_section_id ? String(row.parent_section_id) : null,
    heading: String(row.heading),
    headingPath: Array.isArray(row.heading_path) ? row.heading_path.map(String) : [],
    level: Number(row.level),
    lineStart: Number(row.line_start),
    lineEnd: Number(row.line_end),
    contentHash: String(row.content_hash)
  };
}

function ragIndexJobFromRow(row: Record<string, unknown>): RagIndexJobRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    documentId: String(row.document_id),
    requestedVersion: row.requested_version === null || row.requested_version === undefined ? null : Number(row.requested_version),
    requestedContentHash: row.requested_content_hash ? String(row.requested_content_hash) : null,
    jobType: String(row.job_type) as RagIndexJobType,
    status: String(row.status),
    attempts: Number(row.attempts),
    lastError: row.last_error ? String(row.last_error) : null,
    availableAt: row.available_at instanceof Date ? row.available_at.toISOString() : String(row.available_at),
    startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : row.started_at ? String(row.started_at) : null,
    completedAt: row.completed_at instanceof Date ? row.completed_at.toISOString() : row.completed_at ? String(row.completed_at) : null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at)
  };
}

function ragUserIndexHealthFromRow(row: Record<string, unknown>): RagUserIndexHealthRecord {
  return {
    userId: String(row.user_id),
    qdrantCollection: String(row.qdrant_collection),
    collectionExists: row.collection_exists === true,
    qdrantPointCount: row.qdrant_point_count === null || row.qdrant_point_count === undefined ? null : Number(row.qdrant_point_count),
    healthStatus: String(row.health_status),
    lastError: row.last_error ? String(row.last_error) : null,
    embeddingModel: String(row.embedding_model),
    embeddingDimensions: Number(row.embedding_dimensions),
    lastCollectionCheckAt: row.last_collection_check_at instanceof Date
      ? row.last_collection_check_at.toISOString()
      : row.last_collection_check_at
        ? String(row.last_collection_check_at)
        : null,
    lastReconciliationStartedAt: row.last_reconciliation_started_at instanceof Date
      ? row.last_reconciliation_started_at.toISOString()
      : row.last_reconciliation_started_at
        ? String(row.last_reconciliation_started_at)
        : null,
    lastReconciliationCompletedAt: row.last_reconciliation_completed_at instanceof Date
      ? row.last_reconciliation_completed_at.toISOString()
      : row.last_reconciliation_completed_at
        ? String(row.last_reconciliation_completed_at)
        : null,
    expectedDocumentCount: Number(row.expected_document_count),
    expectedChunkCount: Number(row.expected_chunk_count),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at)
  };
}

function ragDocumentChunkFromRow(row: Record<string, unknown>): RagDocumentChunkRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    documentId: String(row.document_id),
    documentVersion: Number(row.document_version),
    sectionId: row.section_id ? String(row.section_id) : null,
    headingPath: Array.isArray(row.heading_path) ? row.heading_path.map(String) : [],
    chunkIndex: Number(row.chunk_index),
    content: String(row.content ?? ""),
    contentHash: String(row.content_hash),
    qdrantPointId: String(row.qdrant_point_id),
    qdrantCollection: String(row.qdrant_collection),
    embeddingModel: String(row.embedding_model),
    embeddingDimensions: Number(row.embedding_dimensions),
    indexedAt: row.indexed_at instanceof Date ? row.indexed_at.toISOString() : row.indexed_at ? String(row.indexed_at) : null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at)
  };
}

function conflict(path: string, expectedVersion: number, actualVersion: number): MarkdownConflict {
  return {
    code: "conflict",
    path,
    expectedVersion,
    actualVersion
  };
}

function isMarkdownConflict(value: unknown): value is MarkdownConflict {
  return typeof value === "object" && value !== null && (value as { code?: unknown }).code === "conflict";
}

function contextForAgentSession(session: AgentMcpSession): RequestContext {
  return {
    userId: session.userId,
    actorType: "agent",
    permissions: ["agent", "mcp"],
    requestId: `mcp:${session.id}`,
    session: {
      id: session.token,
      user: {
        id: session.userId,
        email: "",
        displayName: "Agent MCP Session",
        isAdmin: false
      },
      createdAt: nowIso(),
      expiresAt: session.expiresAt
    },
    mcpAllowedTools: session.allowedTools
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

function userFromRow(row: Record<string, unknown>): AuthenticatedUser {
  return {
    id: String(row.id),
    email: String(row.email),
    displayName: String(row.display_name),
    isAdmin: Boolean(row.is_admin)
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

async function insertTaskEvent(
  pool: Pool,
  context: Pick<RequestContext, "userId">,
  taskId: string,
  eventType: string,
  details: Record<string, unknown> = {}
): Promise<TaskEventRecord> {
  const result = await pool.query(
    `INSERT INTO task_events (id, user_id, task_id, event_type, event_json)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [randomUUID(), context.userId, taskId, eventType, details]
  );
  return taskEventFromRow(result.rows[0]);
}

async function taskIdForRun(pool: Pool, context: Pick<RequestContext, "userId">, runId: string): Promise<string | null> {
  const result = await pool.query(
    `SELECT task_id FROM agent_runs WHERE id = $1 AND user_id = $2`,
    [runId, context.userId]
  );
  const taskId = result.rows[0]?.task_id;
  return taskId ? String(taskId) : null;
}

async function insertMarkdownSections(
  queryable: Pick<Pool, "query">,
  context: Pick<RequestContext, "userId">,
  documentId: string,
  version: number,
  markdown: string
): Promise<void> {
  await queryable.query(
    `DELETE FROM markdown_sections
     WHERE user_id = $1 AND document_id = $2 AND document_version = $3`,
    [context.userId, documentId, version]
  );
  for (const section of parseMarkdownSections(markdown)) {
    await queryable.query(
      `INSERT INTO markdown_sections
        (id, user_id, document_id, document_version, section_id, parent_section_id, heading,
         heading_path, level, line_start, line_end, content_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        randomUUID(),
        context.userId,
        documentId,
        version,
        section.sectionId,
        section.parentSectionId,
        section.heading,
        JSON.stringify(section.headingPath),
        section.level,
        section.lineStart,
        section.lineEnd,
        section.contentHash
      ]
    );
  }
}

async function enqueueMarkdownIndexJob(
  queryable: Pick<Pool, "query">,
  context: Pick<RequestContext, "userId">,
  document: Pick<MarkdownDocumentRecord, "id" | "version" | "contentHash">
): Promise<void> {
  await queryable.query(
    `INSERT INTO rag_index_jobs
      (id, user_id, document_id, requested_version, requested_content_hash, job_type)
     VALUES ($1, $2, $3, $4, $5, 'index_markdown')`,
    [randomUUID(), context.userId, document.id, document.version, document.contentHash]
  );
}

async function writeMarkdownDocumentPostgres(
  pool: Pool,
  context: RequestContext,
  input: { path: string; markdown: string; expectedVersion?: number },
  auditAction = "markdown.write"
): Promise<MarkdownDocumentRecord | MarkdownConflict> {
  const path = normalizeMarkdownPath(input.path);
  const contentHash = hashMarkdown(input.markdown);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(
      `SELECT * FROM markdown_documents
       WHERE user_id = $1 AND path = $2 AND deleted_at IS NULL
       FOR UPDATE`,
      [context.userId, path]
    );
    const existingRow = existing.rows[0] as Record<string, unknown> | undefined;
    if (input.expectedVersion !== undefined) {
      const actualVersion = existingRow ? Number(existingRow.version) : 0;
      if (actualVersion !== input.expectedVersion) {
        await client.query("ROLLBACK");
        return conflict(path, input.expectedVersion, actualVersion);
      }
    }
    const result = existingRow
      ? await client.query(
        `UPDATE markdown_documents
         SET basename = $3,
             title = $4,
             markdown = $5,
             content_hash = $6,
             version = version + 1,
             index_status = 'pending',
             updated_at = now()
         WHERE id = $1 AND user_id = $2
         RETURNING *`,
        [existingRow.id, context.userId, basenameForPath(path), titleFromMarkdown(input.markdown), input.markdown, contentHash]
      )
      : await client.query(
        `INSERT INTO markdown_documents
          (id, user_id, path, basename, title, markdown, content_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [randomUUID(), context.userId, path, basenameForPath(path), titleFromMarkdown(input.markdown), input.markdown, contentHash]
      );
    const document = markdownDocumentFromRow(result.rows[0]);
    await insertMarkdownSections(client, context, document.id, document.version, document.markdown);
    await enqueueMarkdownIndexJob(client, context, document);
    await client.query(
      `INSERT INTO audit_log
        (id, user_id, actor_type, action, entity_type, entity_id, details_json, request_id)
       VALUES ($1, $2, $3, $4, 'markdown_document', $5, $6, $7)`,
      [randomUUID(), context.userId, context.actorType, auditAction, document.id, { path, version: document.version }, context.requestId]
    );
    await client.query("COMMIT");
    return document;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
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
      const scheduleContext = scheduleContextFromTaskInput(input);
      const result = await pool.query(
        `INSERT INTO tasks
          (id, user_id, title, prompt, due_at, priority, created_by, schedule_context_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          id,
          context.userId,
          input.title,
          input.prompt,
          input.dueAt ?? null,
          input.priority ?? 0,
          context.actorType,
          scheduleContext
        ]
      );
      await insertTaskEvent(pool, context, id, "task.created", {
        summary: "Task created.",
        title: input.title,
        due_at: input.dueAt ?? null,
        priority: input.priority ?? 0,
        schedule_context: scheduleContext
      });
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
      const next = {
        title: update.title ?? existing.title,
        prompt: update.prompt ?? existing.prompt,
        dueAt: update.dueAt === undefined ? existing.dueAt : update.dueAt,
        priority: update.priority ?? existing.priority,
        status: update.status ?? existing.status,
        scheduleContext: scheduleContextFromTaskUpdate(existing, update)
      };
      const result = await pool.query(
        `UPDATE tasks
         SET title = $3,
             prompt = $4,
             due_at = $5,
             priority = $6,
             status = $7,
             schedule_context_json = $8,
             updated_at = now()
         WHERE id = $1 AND user_id = $2
         RETURNING *`,
        [
          taskId,
          context.userId,
          next.title,
          next.prompt,
          next.dueAt,
          next.priority,
          next.status,
          next.scheduleContext
        ]
      );
      const changes: Record<string, unknown> = {};
      if (existing.status !== next.status) {
        changes.status = { from: existing.status, to: next.status };
      }
      if (existing.title !== next.title) {
        changes.title = { from: existing.title, to: next.title };
      }
      if (existing.prompt !== next.prompt) {
        changes.prompt = { changed: true };
      }
      if (existing.dueAt !== next.dueAt) {
        changes.due_at = { from: existing.dueAt, to: next.dueAt };
      }
      if (existing.priority !== next.priority) {
        changes.priority = { from: existing.priority, to: next.priority };
      }
      if (JSON.stringify(scheduleContextFromTaskUpdate(existing, {})) !== JSON.stringify(next.scheduleContext)) {
        changes.schedule_context = next.scheduleContext;
      }
      await insertTaskEvent(pool, context, taskId, "task.updated", changes);
      await recordAudit(pool, context, "task.update", "task", taskId);
      return result.rows[0] ? taskFromRow(result.rows[0]) : undefined;
    },

    async listTaskEvents(context, taskId) {
      const result = await pool.query(
        `SELECT te.*
         FROM task_events te
         JOIN tasks t ON t.id = te.task_id
         WHERE te.task_id = $1
           AND te.user_id = $2
           AND t.user_id = $2
         ORDER BY te.created_at DESC`,
        [taskId, context.userId]
      );
      return result.rows.map(taskEventFromRow);
    },

    async recordTaskEvent(context, taskId, eventType, details = {}) {
      return insertTaskEvent(pool, context, taskId, eventType, details);
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
          await insertTaskEvent(pool, context, id, "task.claim", {
            summary: "Worker claimed the task for processing."
          });
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

    async recordAudit(context, action, entityType, entityId, details = {}) {
      await recordAudit(pool, context, action, entityType, entityId, details);
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

    async listMemoryDocuments(context) {
      const result = await pool.query(
        `SELECT *
         FROM memory_documents
         WHERE user_id = $1
         ORDER BY updated_at DESC, slug ASC`,
        [context.userId]
      );
      return result.rows.map(memoryDocumentFromRow);
    },

    async getMemoryDocument(context, slug) {
      const result = await pool.query(
        `SELECT *
         FROM memory_documents
         WHERE user_id = $1 AND slug = $2
         LIMIT 1`,
        [context.userId, slug]
      );
      return result.rows[0] ? memoryDocumentFromRow(result.rows[0]) : undefined;
    },

    async upsertMemoryDocument(context, input) {
      const result = await pool.query(
        `INSERT INTO memory_documents (id, user_id, slug, title, body)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, slug) DO UPDATE
           SET title = EXCLUDED.title,
               body = EXCLUDED.body,
               updated_at = now()
         RETURNING *`,
        [randomUUID(), context.userId, input.slug, input.title, input.body]
      );
      const record = memoryDocumentFromRow(result.rows[0]);
      await recordAudit(pool, context, "memory.upsert", "memory_document", record.id, {
        slug: record.slug
      });
      await writeMarkdownDocumentPostgres(pool, context, {
        path: memorySlugToMarkdownPath(record.slug),
        markdown: record.body
      }, "memory.markdown_dual_write");
      return record;
    },

    async listMarkdownDirectory(context, path) {
      const dir = normalizeMarkdownDirectory(path);
      const prefix = dir === "/" ? "/" : `${dir}/`;
      const result = await pool.query(
        `SELECT path, basename, version, updated_at
         FROM markdown_documents
         WHERE user_id = $1
           AND deleted_at IS NULL
           AND path LIKE $2
         ORDER BY path ASC`,
        [context.userId, `${prefix}%`]
      );
      const entries = new Map<string, MarkdownDirectoryEntry>();
      for (const row of result.rows as Record<string, unknown>[]) {
        const fullPath = String(row.path);
        const remainder = fullPath.slice(prefix.length);
        if (!remainder) {
          continue;
        }
        const [first = "", ...rest] = remainder.split("/");
        if (rest.length === 0) {
          entries.set(fullPath, {
            path: fullPath,
            name: String(row.basename),
            type: "file",
            version: Number(row.version),
            updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at)
          });
        } else {
          const childPath = `${prefix}${first}`;
          entries.set(childPath, {
            path: childPath,
            name: first,
            type: "directory"
          });
        }
      }
      return [...entries.values()].sort((a, b) => a.type.localeCompare(b.type) || a.path.localeCompare(b.path));
    },

    async getMarkdownDocument(context, path, version) {
      const normalized = normalizeMarkdownPath(path);
      const result = await pool.query(
        version === undefined
          ? `SELECT * FROM markdown_documents
             WHERE user_id = $1 AND path = $2 AND deleted_at IS NULL
             LIMIT 1`
          : `SELECT * FROM markdown_documents
             WHERE user_id = $1 AND path = $2 AND version = $3 AND deleted_at IS NULL
             LIMIT 1`,
        version === undefined ? [context.userId, normalized] : [context.userId, normalized, version]
      );
      return result.rows[0] ? markdownDocumentFromRow(result.rows[0]) : undefined;
    },

    async getMarkdownDocumentById(context, documentId, version) {
      const result = await pool.query(
        version === undefined
          ? `SELECT * FROM markdown_documents
             WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL
             LIMIT 1`
          : `SELECT * FROM markdown_documents
             WHERE user_id = $1 AND id = $2 AND version = $3 AND deleted_at IS NULL
             LIMIT 1`,
        version === undefined ? [context.userId, documentId] : [context.userId, documentId, version]
      );
      return result.rows[0] ? markdownDocumentFromRow(result.rows[0]) : undefined;
    },

    async writeMarkdownDocument(context, input) {
      return writeMarkdownDocumentPostgres(pool, context, input);
    },

    async deleteMarkdownPath(context, path, expectedVersion) {
      const normalized = normalizeMarkdownPath(path);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const existing = await client.query(
          `SELECT * FROM markdown_documents
           WHERE user_id = $1 AND path = $2 AND deleted_at IS NULL
           FOR UPDATE`,
          [context.userId, normalized]
        );
        const row = existing.rows[0] as Record<string, unknown> | undefined;
        if (!row) {
          await client.query("COMMIT");
          return false;
        }
        if (expectedVersion !== undefined && Number(row.version) !== expectedVersion) {
          await client.query("ROLLBACK");
          return conflict(normalized, expectedVersion, Number(row.version));
        }
        await client.query(
          `UPDATE markdown_documents
           SET deleted_at = now(), index_status = 'pending', updated_at = now()
           WHERE id = $1 AND user_id = $2`,
          [row.id, context.userId]
        );
        await client.query(
          `INSERT INTO rag_index_jobs
            (id, user_id, document_id, requested_version, requested_content_hash, job_type)
           VALUES ($1, $2, $3, $4, $5, 'delete_markdown')`,
          [randomUUID(), context.userId, row.id, row.version, row.content_hash]
        );
        await client.query("COMMIT");
        await recordAudit(pool, context, "markdown.delete", "markdown_document", String(row.id), { path: normalized });
        return true;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async moveMarkdownPath(context, input) {
      const from = normalizeMarkdownPath(input.from);
      const to = normalizeMarkdownPath(input.to);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query(
          `SELECT * FROM markdown_documents
           WHERE user_id = $1
             AND deleted_at IS NULL
             AND (path = $2 OR path LIKE $3)
           ORDER BY path ASC
           FOR UPDATE`,
          [context.userId, from, `${from}/%`]
        );
        const rows = result.rows as Record<string, unknown>[];
        for (const row of rows) {
          const expected = input.expectedVersions?.[String(row.path)];
          if (expected !== undefined && expected !== Number(row.version)) {
            await client.query("ROLLBACK");
            return conflict(String(row.path), expected, Number(row.version));
          }
        }
        const moved: MarkdownDocumentRecord[] = [];
        for (const row of rows) {
          const oldPath = String(row.path);
          const nextPath = oldPath === from ? to : `${to}${oldPath.slice(from.length)}`;
          const updated = await client.query(
            `UPDATE markdown_documents
             SET path = $3,
                 basename = $4,
                 version = version + 1,
                 index_status = 'pending',
                 updated_at = now()
             WHERE id = $1 AND user_id = $2
             RETURNING *`,
            [row.id, context.userId, nextPath, basenameForPath(nextPath)]
          );
          const document = markdownDocumentFromRow(updated.rows[0]);
          await enqueueMarkdownIndexJob(client, context, document);
          moved.push(document);
        }
        await client.query("COMMIT");
        await recordAudit(pool, context, "markdown.move", "markdown_document", null, {
          from,
          to,
          count: moved.length
        });
        return moved;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async listMarkdownSections(context, path) {
      const document = await this.getMarkdownDocument(context, path);
      if (!document) {
        return [];
      }
      const result = await pool.query(
        `SELECT * FROM markdown_sections
         WHERE user_id = $1 AND document_id = $2 AND document_version = $3
         ORDER BY line_start ASC`,
        [context.userId, document.id, document.version]
      );
      return result.rows.map(markdownSectionFromRow);
    },

    async readMarkdownSection(context, path, sectionId) {
      return (await this.listMarkdownSections(context, path)).find((section) => section.sectionId === sectionId);
    },

    async replaceMarkdownSection(context, path, sectionId, markdown, expectedVersion) {
      const document = await this.getMarkdownDocument(context, path);
      if (!document) {
        return undefined;
      }
      if (document.version !== expectedVersion) {
        return conflict(document.path, expectedVersion, document.version);
      }
      const section = parseMarkdownSections(document.markdown).find((entry) => entry.sectionId === sectionId);
      if (!section) {
        return undefined;
      }
      return writeMarkdownDocumentPostgres(pool, context, {
        path: document.path,
        markdown: replaceSectionMarkdown(document.markdown, section, markdown),
        expectedVersion
      }, "markdown.section.replace");
    },

    async appendMarkdownSection(context, path, sectionId, markdown, expectedVersion) {
      const document = await this.getMarkdownDocument(context, path);
      if (!document) {
        return undefined;
      }
      if (expectedVersion !== undefined && document.version !== expectedVersion) {
        return conflict(document.path, expectedVersion, document.version);
      }
      const section = parseMarkdownSections(document.markdown).find((entry) => entry.sectionId === sectionId);
      if (!section) {
        return undefined;
      }
      return writeMarkdownDocumentPostgres(pool, context, {
        path: document.path,
        markdown: appendToSectionMarkdown(document.markdown, section, markdown),
        expectedVersion
      }, "markdown.section.append");
    },

    async searchMarkdownExact(context, query) {
      const result = await pool.query(
        `SELECT path, basename, version, updated_at
         FROM markdown_documents
         WHERE user_id = $1
           AND deleted_at IS NULL
           AND (path ILIKE $2 OR title ILIKE $2 OR markdown ILIKE $2)
         ORDER BY updated_at DESC
         LIMIT 50`,
        [context.userId, `%${query}%`]
      );
      return result.rows.map((row: Record<string, unknown>) => ({
        path: String(row.path),
        name: String(row.basename),
        type: "file" as const,
        version: Number(row.version),
        updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at)
      }));
    },

    async searchMarkdownSemantic(context, input) {
      const prefix = input.pathPrefix ? normalizeMarkdownDirectory(input.pathPrefix) : "/";
      if (input.pointIds.length === 0) {
        return [];
      }
      const result = await pool.query(
        `SELECT d.path, d.version, c.section_id, c.heading_path, c.chunk_index, c.content, c.qdrant_point_id
         FROM markdown_document_chunks c
         JOIN markdown_documents d ON d.user_id = c.user_id
          AND d.id = c.document_id
          AND d.version = c.document_version
         WHERE c.user_id = $1
           AND c.qdrant_point_id = ANY($2::text[])
           AND d.deleted_at IS NULL
           AND ($3 = '/' OR d.path = $3 OR d.path LIKE $4)`,
        [context.userId, input.pointIds, prefix, `${prefix}/%`]
      );
      const byPoint = new Map((result.rows as Record<string, unknown>[]).map((row) => [String(row.qdrant_point_id), row]));
      return input.pointIds
        .map((pointId) => {
          const row = byPoint.get(pointId);
          if (!row) {
            return undefined;
          }
          return {
            path: String(row.path),
            version: Number(row.version),
            sectionId: row.section_id ? String(row.section_id) : null,
            headingPath: Array.isArray(row.heading_path) ? row.heading_path.map(String) : [],
            chunkIndex: Number(row.chunk_index),
            score: input.scoresByPointId[pointId] ?? 0,
            excerpt: String(row.content ?? "").replace(/\s+/g, " ").trim().slice(0, 320)
          };
        })
        .filter((row): row is NonNullable<typeof row> => row !== undefined)
        .slice(0, Math.max(1, Math.min(input.limit ?? 10, 25)));
    },

    async searchMarkdownHeadings(context, input) {
      const prefix = input.pathPrefix ? normalizeMarkdownDirectory(input.pathPrefix) : "/";
      const query = input.query?.trim().toLowerCase();
      const maxDepth = input.maxDepth === undefined ? undefined : Math.max(0, Math.min(input.maxDepth, 6));
      const result = await pool.query(
        `SELECT d.path, d.version, s.section_id, s.heading, s.heading_path, s.level, s.line_start, s.line_end
         FROM markdown_documents d
         JOIN markdown_sections s ON s.user_id = d.user_id
          AND s.document_id = d.id
          AND s.document_version = d.version
         WHERE d.user_id = $1
           AND d.deleted_at IS NULL
           AND ($2 = '/' OR d.path = $2 OR d.path LIKE $3)
           AND ($4::text IS NULL OR lower(s.heading) LIKE $4 OR lower(s.section_id) LIKE $4)
           AND ($5::int IS NULL OR s.level <= $5)
         ORDER BY d.path ASC, s.line_start ASC
         LIMIT 100`,
        [
          context.userId,
          prefix,
          `${prefix}/%`,
          query ? `%${query}%` : null,
          maxDepth ?? null
        ]
      );
      return result.rows.map((row: Record<string, unknown>): MarkdownHeadingMatch => ({
        path: String(row.path),
        version: Number(row.version),
        sectionId: String(row.section_id),
        heading: String(row.heading),
        headingPath: Array.isArray(row.heading_path) ? row.heading_path.map(String) : [],
        level: Number(row.level),
        lineStart: Number(row.line_start),
        lineEnd: Number(row.line_end)
      }));
    },

    async grepMarkdown(context, input) {
      const prefix = input.pathPrefix ? normalizeMarkdownDirectory(input.pathPrefix) : "/";
      const result = await pool.query(
        `SELECT path, markdown FROM markdown_documents
         WHERE user_id = $1
           AND deleted_at IS NULL
           AND ($2 = '/' OR path = $2 OR path LIKE $3)
         ORDER BY path ASC`,
        [context.userId, prefix, `${prefix}/%`]
      );
      const flags = input.caseSensitive ? "" : "i";
      const matcher = input.regex ? new RegExp(input.pattern, flags) : undefined;
      const needle = input.caseSensitive ? input.pattern : input.pattern.toLowerCase();
      const contextLines = Math.max(0, Math.min(input.contextLines ?? 0, 5));
      const limit = Math.max(1, Math.min(input.limit ?? 50, 100));
      const matches: Array<{ path: string; line: number; text: string; before: string[]; after: string[] }> = [];
      for (const row of result.rows as Record<string, unknown>[]) {
        const lines = String(row.markdown ?? "").split("\n");
        lines.forEach((line, index) => {
          if (matches.length >= limit) {
            return;
          }
          const hit = matcher ? matcher.test(line) : (input.caseSensitive ? line : line.toLowerCase()).includes(needle);
          if (hit) {
            matches.push({
              path: String(row.path),
              line: index + 1,
              text: line,
              before: lines.slice(Math.max(0, index - contextLines), index),
              after: lines.slice(index + 1, index + 1 + contextLines)
            });
          }
        });
      }
      return matches;
    },

    async getMarkdownIndexStatus(context, path) {
      const prefix = path ? normalizeMarkdownDirectory(path) : "/";
      const result = await pool.query(
        `SELECT d.path, d.version, d.index_status, count(j.id)::int AS pending_jobs
         FROM markdown_documents d
         LEFT JOIN rag_index_jobs j ON j.user_id = d.user_id
          AND j.document_id = d.id
          AND j.status = 'pending'
         WHERE d.user_id = $1
           AND d.deleted_at IS NULL
           AND ($2 = '/' OR d.path = $2 OR d.path LIKE $3)
         GROUP BY d.path, d.version, d.index_status
         ORDER BY d.path ASC`,
        [context.userId, prefix, `${prefix}/%`]
      );
      return result.rows.map((row: Record<string, unknown>) => ({
        path: String(row.path),
        version: Number(row.version),
        indexStatus: String(row.index_status),
        pendingJobs: Number(row.pending_jobs)
      }));
    },

    async reindexMarkdownPath(context, path) {
      const prefix = normalizeMarkdownDirectory(path);
      const result = await pool.query(
        `SELECT * FROM markdown_documents
         WHERE user_id = $1
           AND deleted_at IS NULL
           AND ($2 = '/' OR path = $2 OR path LIKE $3)
         ORDER BY path ASC`,
        [context.userId, prefix, `${prefix}/%`]
      );
      for (const row of result.rows as Record<string, unknown>[]) {
        await enqueueMarkdownIndexJob(pool, context, markdownDocumentFromRow(row));
      }
      return this.getMarkdownIndexStatus(context, path);
    },

    async ensureUserRagIndex(context) {
      const collection = qdrantCollectionForUser(context.userId);
      await pool.query(
        `INSERT INTO rag_user_indexes (user_id, qdrant_collection)
         VALUES ($1, $2)
         ON CONFLICT (user_id) DO NOTHING`,
        [context.userId, collection]
      );
      return collection;
    },

    async enqueueRagJob(context, documentId, jobType) {
      const document = await pool.query(
        `SELECT version, content_hash
         FROM markdown_documents
         WHERE user_id = $1 AND id = $2
         LIMIT 1`,
        [context.userId, documentId]
      );
      const row = document.rows[0] as Record<string, unknown> | undefined;
      const result = await pool.query(
        `INSERT INTO rag_index_jobs
          (id, user_id, document_id, requested_version, requested_content_hash, job_type)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          randomUUID(),
          context.userId,
          documentId,
          row?.version ?? null,
          row?.content_hash ?? null,
          jobType
        ]
      );
      return ragIndexJobFromRow(result.rows[0]);
    },

    async claimRagIndexJobs(limit, now) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const selected = await client.query(
          `SELECT id
           FROM rag_index_jobs
           WHERE (status = 'pending' AND available_at <= $1)
              OR (status = 'claimed' AND started_at < $1::timestamptz - interval '5 minutes')
           ORDER BY created_at ASC
           LIMIT $2
           FOR UPDATE SKIP LOCKED`,
          [now.toISOString(), limit]
        );
        const ids = selected.rows.map((row) => String(row.id));
        if (ids.length === 0) {
          await client.query("COMMIT");
          return [];
        }
        const updated = await client.query(
          `UPDATE rag_index_jobs
           SET status = 'claimed',
               attempts = attempts + 1,
               started_at = now()
           WHERE id = ANY($1::text[])
           RETURNING *`,
          [ids]
        );
        await client.query("COMMIT");
        return updated.rows.map(ragIndexJobFromRow);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async listRagIndexJobs(context, includeAllUsers = false, statuses) {
      const statusFilter = statuses && statuses.length > 0 ? statuses : null;
      const result = await pool.query(
        `SELECT *
         FROM rag_index_jobs
         WHERE ($2 = true OR user_id = $1)
           AND ($3::text[] IS NULL OR status = ANY($3::text[]))
         ORDER BY created_at DESC
         LIMIT 200`,
        [context.userId, includeAllUsers, statusFilter]
      );
      return result.rows.map(ragIndexJobFromRow);
    },

    async retryRagIndexJob(context, jobId, includeAllUsers = false) {
      const result = await pool.query(
        `UPDATE rag_index_jobs
         SET status = 'pending',
             available_at = now(),
             started_at = NULL,
             completed_at = NULL,
             last_error = NULL
         WHERE id = $1
           AND ($2 = true OR user_id = $3)
           AND status IN ('failed', 'dead')
         RETURNING *`,
        [jobId, includeAllUsers, context.userId]
      );
      const record = result.rows[0] ? ragIndexJobFromRow(result.rows[0]) : undefined;
      if (record) {
        await recordAudit(pool, context, "rag.index_job.retry", "rag_index_job", record.id, {
          target_user_id: record.userId,
          document_id: record.documentId,
          job_type: record.jobType,
          attempts: record.attempts
        });
      }
      return record;
    },

    async completeRagIndexJob(jobId) {
      await pool.query(
        `UPDATE rag_index_jobs
         SET status = 'completed', completed_at = now()
         WHERE id = $1`,
        [jobId]
      );
    },

    async failRagIndexJob(jobId, error, retryAtValue) {
      await pool.query(
        `UPDATE rag_index_jobs
         SET status = $2,
             last_error = $3,
             available_at = COALESCE($4, available_at)
         WHERE id = $1`,
        [jobId, retryAtValue ? "pending" : "failed", error, retryAtValue?.toISOString() ?? null]
      );
    },

    async markRagIndexJobDead(jobId, error) {
      await pool.query(
        `UPDATE rag_index_jobs
         SET status = 'dead', last_error = $2, completed_at = now()
         WHERE id = $1`,
        [jobId, error]
      );
    },

    async replaceDocumentChunks(context, documentId, chunks, indexedDocument) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `DELETE FROM markdown_document_chunks
           WHERE user_id = $1 AND document_id = $2`,
          [context.userId, documentId]
        );
        for (const chunk of chunks) {
          await client.query(
            `INSERT INTO markdown_document_chunks
              (id, user_id, document_id, document_version, section_id, heading_path, chunk_index,
               content, content_hash, qdrant_point_id, qdrant_collection, embedding_model,
               embedding_dimensions, indexed_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            [
              chunk.id,
              context.userId,
              documentId,
              chunk.documentVersion,
              chunk.sectionId,
              JSON.stringify(chunk.headingPath),
              chunk.chunkIndex,
              chunk.content,
              chunk.contentHash,
              chunk.qdrantPointId,
              chunk.qdrantCollection,
              chunk.embeddingModel,
              chunk.embeddingDimensions,
              chunk.indexedAt ?? null
            ]
          );
        }
        const latest = chunks.at(0);
        const indexedVersion = indexedDocument?.version ?? latest?.documentVersion ?? null;
        const indexedContentHash = indexedDocument?.contentHash ?? null;
        await client.query(
          `UPDATE markdown_documents
           SET index_status = 'indexed',
               indexed_version = COALESCE($3, indexed_version),
               indexed_content_hash = COALESCE($4, indexed_content_hash),
               indexed_at = now()
           WHERE user_id = $1 AND id = $2`,
          [context.userId, documentId, indexedVersion, indexedContentHash]
        );
        await client.query("COMMIT");
        return this.listChunksForDocument(context, documentId);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async listChunksForDocument(context, documentId) {
      const result = await pool.query(
        `SELECT *
         FROM markdown_document_chunks
         WHERE user_id = $1 AND document_id = $2
         ORDER BY chunk_index ASC`,
        [context.userId, documentId]
      );
      return result.rows.map(ragDocumentChunkFromRow);
    },

    async listRagUserIndexHealth(context, includeAllUsers = false) {
      const result = await pool.query(
        `SELECT *
         FROM rag_user_indexes
         WHERE ($2 = true OR user_id = $1)
         ORDER BY updated_at DESC
         LIMIT 200`,
        [context.userId, includeAllUsers]
      );
      return result.rows.map(ragUserIndexHealthFromRow);
    },

    async updateRagIndexHealth(userId, input) {
      const collection = qdrantCollectionForUser(userId);
      await pool.query(
        `INSERT INTO rag_user_indexes
          (user_id, qdrant_collection, collection_exists, qdrant_point_count, health_status,
           last_error, embedding_model, embedding_dimensions, last_reconciliation_started_at,
           last_reconciliation_completed_at, last_collection_check_at, expected_document_count,
           expected_chunk_count)
         VALUES (
           $1, $2, COALESCE($3, false), $4, COALESCE($5, 'unknown'), $6,
           COALESCE($7, 'text-embedding-3-small'), COALESCE($8, 1536), $9, $10, now(),
           (SELECT count(*) FROM markdown_documents WHERE user_id = $1 AND deleted_at IS NULL),
           (SELECT count(*) FROM markdown_document_chunks WHERE user_id = $1)
         )
         ON CONFLICT (user_id) DO UPDATE
           SET collection_exists = COALESCE($3, rag_user_indexes.collection_exists),
               qdrant_point_count = COALESCE($4, rag_user_indexes.qdrant_point_count),
               health_status = COALESCE($5, rag_user_indexes.health_status),
               last_error = $6,
               embedding_model = COALESCE($7, rag_user_indexes.embedding_model),
               embedding_dimensions = COALESCE($8, rag_user_indexes.embedding_dimensions),
               last_reconciliation_started_at = COALESCE($9, rag_user_indexes.last_reconciliation_started_at),
               last_reconciliation_completed_at = COALESCE($10, rag_user_indexes.last_reconciliation_completed_at),
               last_collection_check_at = now(),
               expected_document_count = EXCLUDED.expected_document_count,
               expected_chunk_count = EXCLUDED.expected_chunk_count,
               updated_at = now()`,
        [
          userId,
          collection,
          input.collectionExists ?? null,
          input.qdrantPointCount ?? null,
          input.healthStatus ?? null,
          input.lastError ?? null,
          input.embeddingModel ?? null,
          input.embeddingDimensions ?? null,
          input.reconciliationStartedAt ?? null,
          input.reconciliationCompletedAt ?? null
        ]
      );
    },

    async createAgentMcpSession(context, input) {
      const token = randomUUID();
      const expiresAt = new Date(Date.now() + (input.ttlSeconds ?? 900) * 1000).toISOString();
      const id = randomUUID();
      await pool.query(
        `INSERT INTO agent_mcp_sessions (id, token_hash, user_id, run_id, allowed_tools_json, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, hashSessionToken(token), context.userId, input.runId ?? null, input.allowedTools ?? null, expiresAt]
      );
      await recordAudit(pool, context, "mcp.session.create", "agent_mcp_session", id, {
        run_id: input.runId ?? null,
        allowed_tools: input.allowedTools ?? null
      });
      return { id, token, userId: context.userId, runId: input.runId ?? null, expiresAt, allowedTools: input.allowedTools ?? null };
    },

    async resolveAgentMcpSession(token, runId) {
      if (!token) {
        return undefined;
      }
      const result = await pool.query(
        `SELECT id, user_id, run_id, allowed_tools_json, expires_at
         FROM agent_mcp_sessions
         WHERE token_hash = $1
           AND revoked_at IS NULL
           AND expires_at > now()
         LIMIT 1`,
        [hashSessionToken(token)]
      );
      const row = result.rows[0] as Record<string, unknown> | undefined;
      if (!row) {
        return undefined;
      }
      const session: AgentMcpSession = {
        id: String(row.id),
        token,
        userId: String(row.user_id),
        runId: row.run_id ? String(row.run_id) : null,
        expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at),
        allowedTools: Array.isArray(row.allowed_tools_json) ? row.allowed_tools_json.map(String) : null
      };
      if (session.runId && session.runId !== runId) {
        return undefined;
      }
      return contextForAgentSession(session);
    },

    async listConnectors(context: RequestContext): Promise<ConnectorRecord[]> {
      const result = await pool.query(
        `SELECT DISTINCT ON (kind) *
         FROM connectors
         WHERE user_id = $1
         ORDER BY kind, updated_at DESC, created_at DESC`,
        [context.userId]
      );
      return result.rows.map(connectorFromRow);
    },

    async getConnector(context: RequestContext, kind: ConnectorKind): Promise<ConnectorRecord | undefined> {
      const result = await pool.query(
        `SELECT *
         FROM connectors
         WHERE user_id = $1 AND kind = $2
         ORDER BY updated_at DESC, created_at DESC
         LIMIT 1`,
        [context.userId, kind]
      );
      return result.rows[0] ? connectorFromRow(result.rows[0]) : undefined;
    },

    async upsertConnector(context: RequestContext, input: ConnectorInput): Promise<ConnectorRecord> {
      const existing = await pool.query(
        `SELECT id
         FROM connectors
         WHERE user_id = $1 AND kind = $2
         ORDER BY updated_at DESC, created_at DESC
         LIMIT 1`,
        [context.userId, input.kind]
      );
      const existingId = existing.rows[0]?.id as string | undefined;
      const result = existingId
        ? await pool.query(
          `UPDATE connectors
           SET status = $3, config_json = $4, updated_at = now()
           WHERE id = $1 AND user_id = $2
           RETURNING *`,
          [existingId, context.userId, input.status, input.config]
        )
        : await pool.query(
          `INSERT INTO connectors (id, user_id, kind, status, config_json)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *`,
          [randomUUID(), context.userId, input.kind, input.status, input.config]
        );
      const record = connectorFromRow(result.rows[0]);
      await recordAudit(pool, context, "connector.upsert", "connector", record.id, {
        kind: record.kind,
        status: record.status
      });
      return record;
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
      if (input.taskId) {
        await insertTaskEvent(pool, context, input.taskId, "agent_run.create", {
          model_tier: input.modelTier,
          model_id: input.modelId,
          summary: `Agent run started with ${input.modelId}.`
        });
      }
      return runFromRow(result.rows[0]);
    },

    async listAgentRuns(context, includeAllUsers = false) {
      const result = await pool.query(
        `SELECT *
         FROM agent_runs
         WHERE ($2 = true OR user_id = $1)
         ORDER BY started_at DESC
         LIMIT 200`,
        [context.userId, includeAllUsers]
      );
      return result.rows.map(runFromRow);
    },

    async finishAgentRun(context, runId, status, failureMessage = null) {
      const taskId = await taskIdForRun(pool, context, runId);
      await pool.query(
        `UPDATE agent_runs
         SET status = $3, failure_message = $4, finished_at = now()
         WHERE id = $1 AND user_id = $2`,
        [runId, context.userId, status, failureMessage]
      );
      await recordAudit(pool, context, `agent_run.${status}`, "agent_run", runId, {
        failure_message: failureMessage
      });
      if (taskId) {
        await insertTaskEvent(pool, context, taskId, `agent_run.${status}`, {
          run_id: runId,
          failure_message: failureMessage,
          summary: failureMessage ? `Agent run ${status}: ${failureMessage}` : `Agent run ${status}.`
        });
      }
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
      if (input.runId) {
        const taskId = await taskIdForRun(pool, context, input.runId);
        if (taskId) {
          await insertTaskEvent(pool, context, taskId, `tool_call.${input.status}`, {
            run_id: input.runId,
            tool_name: input.toolName,
            validation_error: input.validationError ?? null,
            result: input.result ?? {},
            summary: input.validationError
              ? `${input.toolName} failed validation: ${input.validationError}`
              : `${input.toolName} tool call ${input.status}.`
          });
        }
      }
      return toolCallFromRow(result.rows[0]);
    },

    async listToolCalls(context, includeAllUsers = false) {
      const result = await pool.query(
        `SELECT *
         FROM tool_calls
         WHERE ($2 = true OR user_id = $1)
         ORDER BY created_at DESC
         LIMIT 200`,
        [context.userId, includeAllUsers]
      );
      return result.rows.map(toolCallFromRow);
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

    async deleteSender(context, address) {
      const result = await pool.query(
        `DELETE FROM senders
         WHERE user_id = $1 AND lower(address) = lower($2)`,
        [context.userId, address]
      );
      const deleted = Number(result.rowCount ?? 0) > 0;
      if (deleted) {
        await recordAudit(pool, context, "sender.status.delete", "sender", address, {});
      }
      return deleted;
    },

    async recordInboundMessage(context, input: InboundMessageInput, classification: SenderClassification) {
      const existing = await pool.query(
        `SELECT * FROM messages
         WHERE user_id = $1 AND provider_message_id = $2`,
        [context.userId, input.providerMessageId]
      );
      if (existing.rows[0]) {
        return { ...inboundFromRow(existing.rows[0]), duplicate: true };
      }
      const id = randomUUID();
      const result = await pool.query(
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
      const inserted = await pool.query("SELECT * FROM messages WHERE id = $1 AND user_id = $2", [id, context.userId]);
      return { ...inboundFromRow(inserted.rows[0] ?? result.rows[0]), duplicate: false };
    },

    async listInboundMessages(context) {
      const result = await pool.query(
        `SELECT * FROM messages
         WHERE user_id = $1 AND direction = 'inbound'
         ORDER BY COALESCE(received_at, created_at) DESC, created_at DESC
         LIMIT 500`,
        [context.userId]
      );
      return result.rows.map(inboundFromRow);
    },

    async getInboundMessage(context, messageId) {
      const result = await pool.query(
        `SELECT * FROM messages
         WHERE id = $1 AND user_id = $2 AND direction = 'inbound'
         LIMIT 1`,
        [messageId, context.userId]
      );
      return result.rows[0] ? inboundFromRow(result.rows[0]) : undefined;
    },

    async updateInboundMessageHandling(context, messageId, handling) {
      const result = await pool.query(
        `UPDATE messages
         SET auth_json = auth_json || $3::jsonb
         WHERE id = $1 AND user_id = $2 AND direction = 'inbound'
         RETURNING *`,
        [
          messageId,
          context.userId,
          JSON.stringify({
            handling_action: handling.action,
            task_id: handling.taskId ?? null,
            task_event_id: handling.taskEventId ?? null,
            agent_run_id: handling.agentRunId ?? null,
            outbound_message_id: handling.outboundMessageId ?? null
          })
        ]
      );
      if (!result.rows[0]) {
        return undefined;
      }
      await recordAudit(pool, context, "message.inbound.handled", "message", messageId, {
        action: handling.action,
        task_id: handling.taskId ?? null,
        task_event_id: handling.taskEventId ?? null,
        agent_run_id: handling.agentRunId ?? null,
        outbound_message_id: handling.outboundMessageId ?? null
      });
      return inboundFromRow(result.rows[0]);
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

    async listUsersWithWork(statuses = ["pending", "approved"], now = new Date()) {
      const result = await pool.query(
        `SELECT DISTINCT u.*
         FROM users u
         WHERE EXISTS (
           SELECT 1
           FROM outbound_messages om
           WHERE om.user_id = u.id
             AND om.status = ANY($1::text[])
         )
         OR EXISTS (
           SELECT 1
           FROM tasks t
           WHERE t.user_id = u.id
             AND t.status = 'pending'
             AND (t.due_at IS NULL OR t.due_at <= $2)
         )
         OR EXISTS (
           SELECT 1
           FROM connectors c
           WHERE c.user_id = u.id
             AND c.kind = 'imap'
             AND c.status = 'enabled'
         )
         ORDER BY u.email ASC`,
        [statuses, now.toISOString()]
      );
      return result.rows.map(userFromRow);
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
    },

    async createApproval(context, input) {
      const result = await pool.query(
        `INSERT INTO approvals
          (id, user_id, status, action_type, source_run_id, source_ref, risk_level, summary, expires_at, action_json, requested_by)
         VALUES ($1, $2, 'pending', $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [
          randomUUID(),
          context.userId,
          input.actionType,
          input.sourceRunId ?? null,
          input.sourceRef ?? null,
          input.riskLevel,
          input.summary,
          input.expiresAt,
          JSON.stringify(input.proposedPayload),
          input.requestedBy ?? context.actorType
        ]
      );
      const record = approvalFromRow(result.rows[0]);
      await recordAudit(pool, context, "approval.requested", "approval", record.id, {
        action_type: record.actionType,
        risk_level: record.riskLevel,
        source_run_id: record.sourceRunId,
        source_ref: record.sourceRef
      });
      return record;
    },

    async listApprovals(context, statuses) {
      const statusFilter = statuses && statuses.length > 0;
      const result = await pool.query(
        statusFilter
          ? `SELECT * FROM approvals
             WHERE user_id = $1 AND status = ANY($2::text[])
             ORDER BY created_at DESC
             LIMIT 500`
          : `SELECT * FROM approvals
             WHERE user_id = $1
             ORDER BY created_at DESC
             LIMIT 500`,
        statusFilter ? [context.userId, statuses] : [context.userId]
      );
      return result.rows.map(approvalFromRow);
    },

    async getApproval(context, approvalId) {
      const result = await pool.query(
        `SELECT * FROM approvals WHERE id = $1 AND user_id = $2 LIMIT 1`,
        [approvalId, context.userId]
      );
      return result.rows[0] ? approvalFromRow(result.rows[0]) : undefined;
    },

    async updateApprovalStatus(context, approvalId, status, decidedBy = null) {
      const result = await pool.query(
        `UPDATE approvals
         SET status = $3,
             decided_by = CASE WHEN $3 IN ('approved', 'rejected', 'expired') THEN $4 ELSE decided_by END,
             decided_at = CASE WHEN $3 IN ('approved', 'rejected', 'expired') THEN now() ELSE decided_at END,
             updated_at = now()
         WHERE id = $1 AND user_id = $2
         RETURNING *`,
        [approvalId, context.userId, status, decidedBy]
      );
      const record = result.rows[0] ? approvalFromRow(result.rows[0]) : undefined;
      if (record) {
        await recordAudit(pool, context, `approval.${status}`, "approval", approvalId, {
          action_type: record.actionType,
          risk_level: record.riskLevel
        });
      }
      return record;
    },

    async updateApprovalPayload(context, approvalId, proposedPayload, summary) {
      const result = await pool.query(
        `UPDATE approvals
         SET action_json = $3,
             summary = COALESCE($4, summary),
             updated_at = now()
         WHERE id = $1 AND user_id = $2 AND status = 'pending'
         RETURNING *`,
        [approvalId, context.userId, JSON.stringify(proposedPayload), summary ?? null]
      );
      const record = result.rows[0] ? approvalFromRow(result.rows[0]) : undefined;
      if (record) {
        await recordAudit(pool, context, "approval.edited", "approval", approvalId, {
          action_type: record.actionType
        });
      }
      return record;
    }
  };
}

export function createMemoryStore(): AgentStore {
  const sessions = new Map<string, Session>();
  const users = new Map<string, AuthenticatedUser>();
  const tasks = new Map<string, TaskRecord>();
  const taskEvents = new Map<string, TaskEventRecord[]>();
  const runs = new Map<string, AgentRunRecord>();
  const toolCalls = new Map<string, ToolCallRecord>();
  const senderStatuses = new Map<string, SenderRecord>();
  const memoryDocuments = new Map<string, MemoryDocumentRecord>();
  const markdownDocuments = new Map<string, MarkdownDocumentRecord>();
  const markdownSections = new Map<string, MarkdownSectionRecord[]>();
  const markdownIndexJobs: RagIndexJobRecord[] = [];
  const markdownChunks = new Map<string, RagDocumentChunkRecord[]>();
  const ragCollections = new Map<string, string>();
  const ragHealth = new Map<string, RagUserIndexHealthRecord>();
  const agentMcpSessions = new Map<string, AgentMcpSession>();
  const connectors = new Map<string, ConnectorRecord>();
  const inboundProviderIds = new Map<string, string>();
  const inboundMessages = new Map<string, InboundMessageRecord>();
  const outboundMessages = new Map<string, OutboundMessageRecord>();
  const approvals = new Map<string, ApprovalRecord>();
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

  function pushTaskEvent(
    context: Pick<RequestContext, "userId">,
    taskId: string,
    eventType: string,
    details: Record<string, unknown> = {}
  ): TaskEventRecord {
    const event: TaskEventRecord = {
      id: randomUUID(),
      userId: context.userId,
      taskId,
      eventType,
      summary: taskEventSummary(eventType, details),
      details,
      createdAt: nowIso()
    };
    taskEvents.set(taskId, [event, ...(taskEvents.get(taskId) ?? [])]);
    return event;
  }

  function storeMarkdownSections(document: MarkdownDocumentRecord): void {
    markdownSections.set(
      document.id,
      parseMarkdownSections(document.markdown).map((section) => ({
        id: randomUUID(),
        userId: document.userId,
        documentId: document.id,
        documentVersion: document.version,
        sectionId: section.sectionId,
        parentSectionId: section.parentSectionId,
        heading: section.heading,
        headingPath: section.headingPath,
        level: section.level,
        lineStart: section.lineStart,
        lineEnd: section.lineEnd,
        contentHash: section.contentHash
      }))
    );
  }

  function pushRagJob(
    context: Pick<RequestContext, "userId">,
    document: Pick<MarkdownDocumentRecord, "id" | "version" | "contentHash">,
    jobType: RagIndexJobType
  ): RagIndexJobRecord {
    const now = nowIso();
    const job: RagIndexJobRecord = {
      id: randomUUID(),
      userId: context.userId,
      documentId: document.id,
      requestedVersion: document.version,
      requestedContentHash: document.contentHash,
      jobType,
      status: "pending",
      attempts: 0,
      lastError: null,
      availableAt: now,
      startedAt: null,
      completedAt: null,
      createdAt: now
    };
    markdownIndexJobs.push(job);
    return job;
  }

  function writeMarkdownMemory(
    context: RequestContext,
    input: { path: string; markdown: string; expectedVersion?: number },
    auditAction = "markdown.write"
  ): MarkdownDocumentRecord | MarkdownConflict {
    const path = normalizeMarkdownPath(input.path);
    const key = `${context.userId}:${path}`;
    const existing = markdownDocuments.get(key);
    if (input.expectedVersion !== undefined) {
      const actualVersion = existing?.version ?? 0;
      if (actualVersion !== input.expectedVersion) {
        return conflict(path, input.expectedVersion, actualVersion);
      }
    }
    const now = nowIso();
    const document: MarkdownDocumentRecord = {
      id: existing?.id ?? randomUUID(),
      userId: context.userId,
      path,
      basename: basenameForPath(path),
      title: titleFromMarkdown(input.markdown),
      markdown: input.markdown,
      contentHash: hashMarkdown(input.markdown),
      version: existing ? existing.version + 1 : 1,
      indexStatus: "pending",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    markdownDocuments.set(key, document);
    storeMarkdownSections(document);
    pushRagJob(context, document, "index_markdown");
    pushAudit(context, auditAction, "markdown_document", document.id, {
      path: document.path,
      version: document.version
    });
    return document;
  }

  function markdownPathMatchesPrefix(path: string, prefix: string): boolean {
    return prefix === "/" || path === prefix || path.startsWith(`${prefix}/`);
  }

  return {
    async createDevelopmentSession(settings: Settings, requestId: string): Promise<Session> {
      const session = createSessionFromSettings(settings);
      sessions.set(session.id, session);
      users.set(session.user.id, session.user);
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
      users.set(session.user.id, session.user);
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
        scheduleRationale: input.scheduleRationale ?? null,
        sourceMemoryPath: input.sourceMemoryPath ?? null,
        sourceMessageId: input.sourceMessageId ?? null,
        sourceTaskId: input.sourceTaskId ?? null,
        recurrencePolicy: input.recurrencePolicy ?? null,
        lastAgentReviewAt: null,
        nextReviewAt: input.nextReviewAt ?? null,
        waitingOn: null,
        blockedReason: null,
        ownerClarificationNeeded: false,
        createdBy: context.actorType,
        createdAt: now,
        updatedAt: now
      };
      tasks.set(task.id, task);
      pushTaskEvent(context, task.id, "task.created", {
        summary: "Task created.",
        title: task.title,
        due_at: task.dueAt,
        priority: task.priority,
        schedule_context: scheduleContextFromTaskInput(input)
      });
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
      const previous = task;
      const updated = {
        ...task,
        ...update,
        dueAt: update.dueAt === undefined ? task.dueAt : update.dueAt,
        scheduleRationale: update.scheduleRationale === undefined ? task.scheduleRationale : update.scheduleRationale,
        sourceMemoryPath: update.sourceMemoryPath === undefined ? task.sourceMemoryPath : update.sourceMemoryPath,
        sourceMessageId: update.sourceMessageId === undefined ? task.sourceMessageId : update.sourceMessageId,
        sourceTaskId: update.sourceTaskId === undefined ? task.sourceTaskId : update.sourceTaskId,
        recurrencePolicy: update.recurrencePolicy === undefined ? task.recurrencePolicy : update.recurrencePolicy,
        lastAgentReviewAt: update.lastAgentReviewAt === undefined ? task.lastAgentReviewAt : update.lastAgentReviewAt,
        nextReviewAt: update.nextReviewAt === undefined ? task.nextReviewAt : update.nextReviewAt,
        waitingOn: update.waitingOn === undefined ? task.waitingOn : update.waitingOn,
        blockedReason: update.blockedReason === undefined ? task.blockedReason : update.blockedReason,
        ownerClarificationNeeded: update.ownerClarificationNeeded === undefined
          ? task.ownerClarificationNeeded
          : update.ownerClarificationNeeded,
        updatedAt: nowIso()
      };
      tasks.set(taskId, updated);
      const changes: Record<string, unknown> = {};
      if (previous.status !== updated.status) {
        changes.status = { from: previous.status, to: updated.status };
      }
      if (previous.title !== updated.title) {
        changes.title = { from: previous.title, to: updated.title };
      }
      if (previous.prompt !== updated.prompt) {
        changes.prompt = { changed: true };
      }
      if (previous.dueAt !== updated.dueAt) {
        changes.due_at = { from: previous.dueAt, to: updated.dueAt };
      }
      if (previous.priority !== updated.priority) {
        changes.priority = { from: previous.priority, to: updated.priority };
      }
      if (JSON.stringify(scheduleContextFromTaskUpdate(previous, {})) !== JSON.stringify(scheduleContextFromTaskUpdate(updated, {}))) {
        changes.schedule_context = scheduleContextFromTaskUpdate(updated, {});
      }
      pushTaskEvent(context, taskId, "task.updated", changes);
      pushAudit(context, "task.update", "task", taskId);
      return updated;
    },
    async listTaskEvents(context: RequestContext, taskId: string): Promise<TaskEventRecord[]> {
      const task = await this.getTask(context, taskId);
      if (!task) {
        return [];
      }
      return taskEvents.get(taskId) ?? [];
    },
    async recordTaskEvent(context, taskId, eventType, details = {}) {
      return pushTaskEvent(context, taskId, eventType, details);
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
          pushTaskEvent(context, task.id, "task.claim", {
            summary: "Worker claimed the task for processing."
          });
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
    async recordAudit(context, action, entityType, entityId, details = {}) {
      pushAudit(context, action, entityType, entityId, details);
    },
    async getAiConfig(): Promise<AiConfig> {
      return aiConfig;
    },
    async updateAiConfig(context: RequestContext, config: AiConfig): Promise<AiConfig> {
      aiConfig = config;
      pushAudit(context, "admin.ai_config.update", "admin_ai_config", "default");
      return aiConfig;
    },
    async listMemoryDocuments(context) {
      return [...memoryDocuments.values()]
        .filter((document) => document.userId === context.userId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.slug.localeCompare(b.slug));
    },
    async getMemoryDocument(context, slug) {
      return memoryDocuments.get(`${context.userId}:${slug}`);
    },
    async upsertMemoryDocument(context, input) {
      const key = `${context.userId}:${input.slug}`;
      const existing = memoryDocuments.get(key);
      const now = nowIso();
      const record: MemoryDocumentRecord = {
        id: existing?.id ?? randomUUID(),
        userId: context.userId,
        slug: input.slug,
        title: input.title,
        body: input.body,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };
      memoryDocuments.set(key, record);
      pushAudit(context, "memory.upsert", "memory_document", record.id, {
        slug: record.slug
      });
      writeMarkdownMemory(context, {
        path: memorySlugToMarkdownPath(record.slug),
        markdown: record.body
      }, "memory.markdown_dual_write");
      return record;
    },
    async listMarkdownDirectory(context, path) {
      const dir = normalizeMarkdownDirectory(path);
      const prefix = dir === "/" ? "/" : `${dir}/`;
      const entries = new Map<string, MarkdownDirectoryEntry>();
      for (const document of markdownDocuments.values()) {
        if (document.userId !== context.userId || !document.path.startsWith(prefix)) {
          continue;
        }
        const remainder = document.path.slice(prefix.length);
        if (!remainder) {
          continue;
        }
        const [first = "", ...rest] = remainder.split("/");
        if (rest.length === 0) {
          entries.set(document.path, {
            path: document.path,
            name: document.basename,
            type: "file",
            version: document.version,
            updatedAt: document.updatedAt
          });
        } else {
          entries.set(`${prefix}${first}`, {
            path: `${prefix}${first}`,
            name: first,
            type: "directory"
          });
        }
      }
      return [...entries.values()].sort((a, b) => a.type.localeCompare(b.type) || a.path.localeCompare(b.path));
    },
    async getMarkdownDocument(context, path, version) {
      const document = markdownDocuments.get(`${context.userId}:${normalizeMarkdownPath(path)}`);
      if (!document || (version !== undefined && document.version !== version)) {
        return undefined;
      }
      return document;
    },
    async getMarkdownDocumentById(context, documentId, version) {
      return [...markdownDocuments.values()].find((document) => {
        return document.userId === context.userId
          && document.id === documentId
          && (version === undefined || document.version === version);
      });
    },
    async writeMarkdownDocument(context, input) {
      return writeMarkdownMemory(context, input);
    },
    async deleteMarkdownPath(context, path, expectedVersion) {
      const normalized = normalizeMarkdownPath(path);
      const key = `${context.userId}:${normalized}`;
      const document = markdownDocuments.get(key);
      if (!document) {
        return false;
      }
      if (expectedVersion !== undefined && document.version !== expectedVersion) {
        return conflict(normalized, expectedVersion, document.version);
      }
      markdownDocuments.delete(key);
      markdownSections.delete(document.id);
      pushRagJob(context, document, "delete_markdown");
      pushAudit(context, "markdown.delete", "markdown_document", document.id, { path: normalized });
      return true;
    },
    async moveMarkdownPath(context, input) {
      const from = normalizeMarkdownPath(input.from);
      const to = normalizeMarkdownPath(input.to);
      const documents = [...markdownDocuments.values()]
        .filter((document) => document.userId === context.userId && (document.path === from || document.path.startsWith(`${from}/`)))
        .sort((a, b) => a.path.localeCompare(b.path));
      for (const document of documents) {
        const expected = input.expectedVersions?.[document.path];
        if (expected !== undefined && expected !== document.version) {
          return conflict(document.path, expected, document.version);
        }
      }
      const moved: MarkdownDocumentRecord[] = [];
      for (const document of documents) {
        markdownDocuments.delete(`${context.userId}:${document.path}`);
        const nextPath = document.path === from ? to : `${to}${document.path.slice(from.length)}`;
        const updated: MarkdownDocumentRecord = {
          ...document,
          path: nextPath,
          basename: basenameForPath(nextPath),
          version: document.version + 1,
          indexStatus: "pending",
          updatedAt: nowIso()
        };
        markdownDocuments.set(`${context.userId}:${nextPath}`, updated);
        pushRagJob(context, updated, "index_markdown");
        moved.push(updated);
      }
      pushAudit(context, "markdown.move", "markdown_document", null, { from, to, count: moved.length });
      return moved;
    },
    async listMarkdownSections(context, path) {
      const document = await this.getMarkdownDocument(context, path);
      if (!document) {
        return [];
      }
      return markdownSections.get(document.id) ?? [];
    },
    async readMarkdownSection(context, path, sectionId) {
      return (await this.listMarkdownSections(context, path)).find((section) => section.sectionId === sectionId);
    },
    async replaceMarkdownSection(context, path, sectionId, markdown, expectedVersion) {
      const document = await this.getMarkdownDocument(context, path);
      if (!document) {
        return undefined;
      }
      if (document.version !== expectedVersion) {
        return conflict(document.path, expectedVersion, document.version);
      }
      const section = parseMarkdownSections(document.markdown).find((entry) => entry.sectionId === sectionId);
      if (!section) {
        return undefined;
      }
      return writeMarkdownMemory(context, {
        path: document.path,
        markdown: replaceSectionMarkdown(document.markdown, section, markdown),
        expectedVersion
      }, "markdown.section.replace");
    },
    async appendMarkdownSection(context, path, sectionId, markdown, expectedVersion) {
      const document = await this.getMarkdownDocument(context, path);
      if (!document) {
        return undefined;
      }
      if (expectedVersion !== undefined && document.version !== expectedVersion) {
        return conflict(document.path, expectedVersion, document.version);
      }
      const section = parseMarkdownSections(document.markdown).find((entry) => entry.sectionId === sectionId);
      if (!section) {
        return undefined;
      }
      return writeMarkdownMemory(context, {
        path: document.path,
        markdown: appendToSectionMarkdown(document.markdown, section, markdown),
        expectedVersion
      }, "markdown.section.append");
    },
    async searchMarkdownExact(context, query) {
      const needle = query.toLowerCase();
      return [...markdownDocuments.values()]
        .filter((document) => document.userId === context.userId)
        .filter((document) => [document.path, document.title ?? "", document.markdown].some((value) => value.toLowerCase().includes(needle)))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 50)
        .map((document) => ({
          path: document.path,
          name: document.basename,
          type: "file" as const,
          version: document.version,
          updatedAt: document.updatedAt
        }));
    },
    async searchMarkdownSemantic(context, input) {
      const prefix = input.pathPrefix ? normalizeMarkdownDirectory(input.pathPrefix) : "/";
      const chunksByPoint = new Map<string, RagDocumentChunkRecord>();
      for (const chunks of markdownChunks.values()) {
        for (const chunk of chunks) {
          chunksByPoint.set(chunk.qdrantPointId, chunk);
        }
      }
      return input.pointIds
        .map((pointId) => {
          const chunk = chunksByPoint.get(pointId);
          const document = chunk
            ? [...markdownDocuments.values()].find((entry) => {
              return entry.userId === context.userId
                && entry.id === chunk.documentId
                && entry.version === chunk.documentVersion
                && markdownPathMatchesPrefix(entry.path, prefix);
            })
            : undefined;
          if (!chunk || !document) {
            return undefined;
          }
          return {
            path: document.path,
            version: document.version,
            sectionId: chunk.sectionId,
            headingPath: chunk.headingPath,
            chunkIndex: chunk.chunkIndex,
            score: input.scoresByPointId[pointId] ?? 0,
            excerpt: chunk.content.replace(/\s+/g, " ").trim().slice(0, 320)
          };
        })
        .filter((row): row is NonNullable<typeof row> => row !== undefined)
        .slice(0, Math.max(1, Math.min(input.limit ?? 10, 25)));
    },
    async searchMarkdownHeadings(context, input) {
      const prefix = input.pathPrefix ? normalizeMarkdownDirectory(input.pathPrefix) : "/";
      const query = input.query?.trim().toLowerCase();
      const maxDepth = input.maxDepth === undefined ? undefined : Math.max(0, Math.min(input.maxDepth, 6));
      const matches: MarkdownHeadingMatch[] = [];
      for (const document of [...markdownDocuments.values()].sort((a, b) => a.path.localeCompare(b.path))) {
        if (document.userId !== context.userId || !markdownPathMatchesPrefix(document.path, prefix)) {
          continue;
        }
        for (const section of markdownSections.get(document.id) ?? []) {
          if (maxDepth !== undefined && section.level > maxDepth) {
            continue;
          }
          const haystack = `${section.heading} ${section.sectionId}`.toLowerCase();
          if (query && !haystack.includes(query)) {
            continue;
          }
          matches.push({
            path: document.path,
            version: document.version,
            sectionId: section.sectionId,
            heading: section.heading,
            headingPath: section.headingPath,
            level: section.level,
            lineStart: section.lineStart,
            lineEnd: section.lineEnd
          });
        }
      }
      return matches.slice(0, 100);
    },
    async grepMarkdown(context, input) {
      const prefix = input.pathPrefix ? normalizeMarkdownDirectory(input.pathPrefix) : "/";
      const matcher = input.regex ? new RegExp(input.pattern, input.caseSensitive ? "" : "i") : undefined;
      const needle = input.caseSensitive ? input.pattern : input.pattern.toLowerCase();
      const contextLines = Math.max(0, Math.min(input.contextLines ?? 0, 5));
      const limit = Math.max(1, Math.min(input.limit ?? 50, 100));
      const matches: Array<{ path: string; line: number; text: string; before: string[]; after: string[] }> = [];
      for (const document of [...markdownDocuments.values()].sort((a, b) => a.path.localeCompare(b.path))) {
        if (document.userId !== context.userId || !markdownPathMatchesPrefix(document.path, prefix)) {
          continue;
        }
        const lines = document.markdown.split("\n");
        lines.forEach((line, index) => {
          if (matches.length >= limit) {
            return;
          }
          const hit = matcher ? matcher.test(line) : (input.caseSensitive ? line : line.toLowerCase()).includes(needle);
          if (hit) {
            matches.push({
              path: document.path,
              line: index + 1,
              text: line,
              before: lines.slice(Math.max(0, index - contextLines), index),
              after: lines.slice(index + 1, index + 1 + contextLines)
            });
          }
        });
      }
      return matches;
    },
    async getMarkdownIndexStatus(context, path) {
      const prefix = path ? normalizeMarkdownDirectory(path) : "/";
      return [...markdownDocuments.values()]
        .filter((document) => document.userId === context.userId && markdownPathMatchesPrefix(document.path, prefix))
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((document): MarkdownIndexStatus => ({
          path: document.path,
          version: document.version,
          indexStatus: document.indexStatus,
          pendingJobs: markdownIndexJobs.filter((job) => {
            return job.userId === context.userId && job.documentId === document.id && job.status === "pending";
          }).length
        }));
    },
    async reindexMarkdownPath(context, path) {
      const prefix = normalizeMarkdownDirectory(path);
      for (const document of markdownDocuments.values()) {
        if (document.userId === context.userId && markdownPathMatchesPrefix(document.path, prefix)) {
          pushRagJob(context, document, "index_markdown");
        }
      }
      return this.getMarkdownIndexStatus(context, path);
    },
    async ensureUserRagIndex(context) {
      const collection = qdrantCollectionForUser(context.userId);
      ragCollections.set(context.userId, collection);
      return collection;
    },
    async enqueueRagJob(context, documentId, jobType) {
      const document = [...markdownDocuments.values()].find((entry) => entry.userId === context.userId && entry.id === documentId);
      return pushRagJob(context, document ?? {
        id: documentId,
        version: 0,
        contentHash: ""
      }, jobType);
    },
    async claimRagIndexJobs(limit, now) {
      const claimed: RagIndexJobRecord[] = [];
      for (const job of markdownIndexJobs) {
        if (claimed.length >= limit) {
          break;
        }
        const staleClaim = job.status === "claimed"
          && job.startedAt !== null
          && Date.parse(job.startedAt) < now.getTime() - 5 * 60_000;
        if ((job.status === "pending" && Date.parse(job.availableAt) <= now.getTime()) || staleClaim) {
          job.status = "claimed";
          job.attempts += 1;
          job.startedAt = nowIso();
          claimed.push({ ...job });
        }
      }
      return claimed;
    },
    async listRagIndexJobs(context, includeAllUsers = false, statuses) {
      const statusSet = statuses && statuses.length > 0 ? new Set(statuses) : null;
      return markdownIndexJobs
        .filter((job) => (includeAllUsers || job.userId === context.userId) && (!statusSet || statusSet.has(job.status)))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 200)
        .map((job) => ({ ...job }));
    },
    async retryRagIndexJob(context, jobId, includeAllUsers = false) {
      const job = markdownIndexJobs.find((entry) => {
        return entry.id === jobId
          && (includeAllUsers || entry.userId === context.userId)
          && ["failed", "dead"].includes(entry.status);
      });
      if (!job) {
        return undefined;
      }
      job.status = "pending";
      job.availableAt = nowIso();
      job.startedAt = null;
      job.completedAt = null;
      job.lastError = null;
      pushAudit(context, "rag.index_job.retry", "rag_index_job", job.id, {
        target_user_id: job.userId,
        document_id: job.documentId,
        job_type: job.jobType,
        attempts: job.attempts
      });
      return { ...job };
    },
    async completeRagIndexJob(jobId) {
      const job = markdownIndexJobs.find((entry) => entry.id === jobId);
      if (job) {
        job.status = "completed";
        job.completedAt = nowIso();
      }
    },
    async failRagIndexJob(jobId, error, retryAtValue) {
      const job = markdownIndexJobs.find((entry) => entry.id === jobId);
      if (job) {
        job.status = retryAtValue ? "pending" : "failed";
        job.lastError = error;
        if (retryAtValue) {
          job.availableAt = retryAtValue.toISOString();
        }
      }
    },
    async markRagIndexJobDead(jobId, error) {
      const job = markdownIndexJobs.find((entry) => entry.id === jobId);
      if (job) {
        job.status = "dead";
        job.lastError = error;
        job.completedAt = nowIso();
      }
    },
    async replaceDocumentChunks(context, documentId, chunks, _indexedDocument) {
      const now = nowIso();
      const records = chunks.map((chunk): RagDocumentChunkRecord => ({
        ...chunk,
        userId: context.userId,
        documentId,
        indexedAt: chunk.indexedAt ?? now,
        createdAt: now
      }));
      markdownChunks.set(`${context.userId}:${documentId}`, records);
      for (const [key, document] of markdownDocuments.entries()) {
        if (document.userId === context.userId && document.id === documentId) {
          markdownDocuments.set(key, {
            ...document,
            indexStatus: "indexed"
          });
        }
      }
      return records;
    },
    async listChunksForDocument(context, documentId) {
      return markdownChunks.get(`${context.userId}:${documentId}`) ?? [];
    },
    async listRagUserIndexHealth(context, includeAllUsers = false) {
      return [...ragHealth.values()]
        .filter((entry) => includeAllUsers || entry.userId === context.userId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 200);
    },
    async updateRagIndexHealth(userId, input) {
      const now = nowIso();
      const existing = ragHealth.get(userId);
      const chunks = [...markdownChunks.values()].flat().filter((chunk) => chunk.userId === userId);
      const record: RagUserIndexHealthRecord = {
        userId,
        qdrantCollection: existing?.qdrantCollection ?? qdrantCollectionForUser(userId),
        collectionExists: input.collectionExists ?? existing?.collectionExists ?? false,
        qdrantPointCount: input.qdrantPointCount ?? existing?.qdrantPointCount ?? null,
        healthStatus: input.healthStatus ?? existing?.healthStatus ?? "unknown",
        lastError: input.lastError ?? null,
        embeddingModel: input.embeddingModel ?? existing?.embeddingModel ?? "text-embedding-3-small",
        embeddingDimensions: input.embeddingDimensions ?? existing?.embeddingDimensions ?? 1536,
        lastCollectionCheckAt: now,
        lastReconciliationStartedAt: input.reconciliationStartedAt ?? existing?.lastReconciliationStartedAt ?? null,
        lastReconciliationCompletedAt: input.reconciliationCompletedAt ?? existing?.lastReconciliationCompletedAt ?? null,
        expectedDocumentCount: [...markdownDocuments.values()].filter((document) => document.userId === userId).length,
        expectedChunkCount: chunks.length,
        updatedAt: now
      };
      ragHealth.set(userId, record);
    },
    async createAgentMcpSession(context, input) {
      const session: AgentMcpSession = {
        id: randomUUID(),
        token: randomUUID(),
        userId: context.userId,
        runId: input.runId ?? null,
        expiresAt: new Date(Date.now() + (input.ttlSeconds ?? 900) * 1000).toISOString(),
        allowedTools: input.allowedTools ?? null
      };
      agentMcpSessions.set(session.token, session);
      pushAudit(context, "mcp.session.create", "agent_mcp_session", session.id, {
        run_id: session.runId,
        allowed_tools: session.allowedTools
      });
      return session;
    },
    async resolveAgentMcpSession(token, runId) {
      if (!token) {
        return undefined;
      }
      const session = agentMcpSessions.get(token);
      if (!session || Date.parse(session.expiresAt) <= Date.now()) {
        return undefined;
      }
      if (session.runId && session.runId !== runId) {
        return undefined;
      }
      return contextForAgentSession(session);
    },
    async listConnectors(context: RequestContext): Promise<ConnectorRecord[]> {
      return [...connectors.values()]
        .filter((connector) => connector.userId === context.userId)
        .sort((a, b) => a.kind.localeCompare(b.kind));
    },
    async getConnector(context: RequestContext, kind: ConnectorKind): Promise<ConnectorRecord | undefined> {
      return [...connectors.values()].find((connector) => connector.userId === context.userId && connector.kind === kind);
    },
    async upsertConnector(context: RequestContext, input: ConnectorInput): Promise<ConnectorRecord> {
      const existing = await this.getConnector(context, input.kind);
      const now = nowIso();
      const record: ConnectorRecord = {
        id: existing?.id ?? randomUUID(),
        userId: context.userId,
        kind: input.kind,
        status: input.status,
        config: input.config,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };
      connectors.set(record.id, record);
      pushAudit(context, "connector.upsert", "connector", record.id, {
        kind: record.kind,
        status: record.status
      });
      return record;
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
      if (run.taskId) {
        pushTaskEvent(context, run.taskId, "agent_run.create", {
          model_tier: input.modelTier,
          model_id: input.modelId,
          summary: `Agent run started with ${input.modelId}.`
        });
      }
      return run;
    },
    async listAgentRuns(context, includeAllUsers = false) {
      return [...runs.values()]
        .filter((run) => includeAllUsers || run.userId === context.userId)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, 200);
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
        if (run.taskId) {
          pushTaskEvent(context, run.taskId, `agent_run.${status}`, {
            run_id: runId,
            failure_message: failureMessage,
            summary: failureMessage ? `Agent run ${status}: ${failureMessage}` : `Agent run ${status}.`
          });
        }
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
      const run = input.runId ? runs.get(input.runId) : undefined;
      if (run?.taskId) {
        pushTaskEvent(context, run.taskId, `tool_call.${input.status}`, {
          run_id: input.runId ?? null,
          tool_name: input.toolName,
          validation_error: input.validationError ?? null,
          result: input.result ?? {},
          summary: input.validationError
            ? `${input.toolName} failed validation: ${input.validationError}`
            : `${input.toolName} tool call ${input.status}.`
        });
      }
      return toolCall;
    },
    async listToolCalls(context, includeAllUsers = false) {
      return [...toolCalls.values()]
        .filter((toolCall) => includeAllUsers || toolCall.userId === context.userId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 200);
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
    async deleteSender(context, address) {
      const key = `${context.userId}:${address.toLowerCase()}`;
      const deleted = senderStatuses.delete(key);
      if (deleted) {
        pushAudit(context, "sender.status.delete", "sender", address, {});
      }
      return deleted;
    },
    async recordInboundMessage(context, input, classification) {
      const key = `${context.userId}:${input.providerMessageId}`;
      const existing = inboundProviderIds.get(key);
      if (existing) {
        const message = inboundMessages.get(existing);
        if (!message) {
          return {
            ...input,
            id: existing,
            userId: context.userId,
            classification,
            handlingAction: null,
            taskId: null,
            taskEventId: null,
            agentRunId: null,
            outboundMessageId: null,
            createdAt: nowIso(),
            duplicate: true
          };
        }
        return { ...message, duplicate: true };
      }
      const id = randomUUID();
      const message: InboundMessageRecord = {
        ...input,
        id,
        userId: context.userId,
        classification,
        handlingAction: null,
        taskId: null,
        taskEventId: null,
        agentRunId: null,
        outboundMessageId: null,
        subject: input.subject ?? null,
        receivedAt: input.receivedAt ?? null,
        source: input.source ?? "imap",
        createdAt: nowIso()
      };
      inboundProviderIds.set(key, id);
      inboundMessages.set(id, message);
      pushAudit(context, "message.inbound.record", "message", id, { classification });
      return { ...message, duplicate: false };
    },
    async listInboundMessages(context) {
      return [...inboundMessages.values()]
        .filter((message) => message.userId === context.userId)
        .sort((a, b) => {
          const aDate = a.receivedAt ?? a.createdAt;
          const bDate = b.receivedAt ?? b.createdAt;
          return bDate.localeCompare(aDate) || b.createdAt.localeCompare(a.createdAt);
        });
    },
    async getInboundMessage(context, messageId) {
      const message = inboundMessages.get(messageId);
      return message && message.userId === context.userId ? message : undefined;
    },
    async updateInboundMessageHandling(context, messageId, handling) {
      const message = inboundMessages.get(messageId);
      if (!message || message.userId !== context.userId) {
        return undefined;
      }
      const updated: InboundMessageRecord = {
        ...message,
        handlingAction: handling.action,
        taskId: handling.taskId ?? null,
        taskEventId: handling.taskEventId ?? null,
        agentRunId: handling.agentRunId ?? null,
        outboundMessageId: handling.outboundMessageId ?? null
      };
      inboundMessages.set(messageId, updated);
      pushAudit(context, "message.inbound.handled", "message", messageId, {
        action: handling.action,
        task_id: handling.taskId ?? null,
        task_event_id: handling.taskEventId ?? null,
        agent_run_id: handling.agentRunId ?? null,
        outbound_message_id: handling.outboundMessageId ?? null
      });
      return updated;
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
    async listUsersWithWork(statuses = ["pending", "approved"], now = new Date()) {
      const userIds = new Set<string>();
      for (const message of outboundMessages.values()) {
        if (statuses.includes(message.status)) {
          userIds.add(message.userId);
        }
      }
      for (const task of tasks.values()) {
        const isDue = task.dueAt === null || Date.parse(task.dueAt) <= now.getTime();
        if (task.status === "pending" && isDue) {
          userIds.add(task.userId);
        }
      }
      for (const connector of connectors.values()) {
        if (connector.kind === "imap" && connector.status === "enabled") {
          userIds.add(connector.userId);
        }
      }
      return [...userIds]
        .map((userId) => users.get(userId))
        .filter((user): user is AuthenticatedUser => Boolean(user))
        .sort((a, b) => a.email.localeCompare(b.email));
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
    },
    async createApproval(context, input: ApprovalInput) {
      const now = nowIso();
      const approval: ApprovalRecord = {
        ...input,
        id: randomUUID(),
        userId: context.userId,
        status: "pending",
        sourceRunId: input.sourceRunId ?? null,
        sourceRef: input.sourceRef ?? null,
        requestedBy: input.requestedBy ?? context.actorType,
        decidedBy: null,
        decidedAt: null,
        createdAt: now,
        updatedAt: now
      };
      approvals.set(approval.id, approval);
      pushAudit(context, "approval.requested", "approval", approval.id, {
        action_type: approval.actionType,
        risk_level: approval.riskLevel,
        source_run_id: approval.sourceRunId,
        source_ref: approval.sourceRef
      });
      return approval;
    },
    async listApprovals(context, statuses) {
      return [...approvals.values()]
        .filter((approval) => approval.userId === context.userId)
        .filter((approval) => !statuses || statuses.length === 0 || statuses.includes(approval.status))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async getApproval(context, approvalId) {
      const approval = approvals.get(approvalId);
      return approval && approval.userId === context.userId ? approval : undefined;
    },
    async updateApprovalStatus(context, approvalId, status, decidedBy = null) {
      const approval = approvals.get(approvalId);
      if (!approval || approval.userId !== context.userId) {
        return undefined;
      }
      const updated: ApprovalRecord = {
        ...approval,
        status,
        decidedBy: ["approved", "rejected", "expired"].includes(status) ? decidedBy : approval.decidedBy,
        decidedAt: ["approved", "rejected", "expired"].includes(status) ? nowIso() : approval.decidedAt,
        updatedAt: nowIso()
      };
      approvals.set(approvalId, updated);
      pushAudit(context, `approval.${status}`, "approval", approvalId, {
        action_type: updated.actionType,
        risk_level: updated.riskLevel
      });
      return updated;
    },
    async updateApprovalPayload(context, approvalId, proposedPayload, summary) {
      const approval = approvals.get(approvalId);
      if (!approval || approval.userId !== context.userId || approval.status !== "pending") {
        return undefined;
      }
      const updated: ApprovalRecord = {
        ...approval,
        proposedPayload,
        summary: summary ?? approval.summary,
        updatedAt: nowIso()
      };
      approvals.set(approvalId, updated);
      pushAudit(context, "approval.edited", "approval", approvalId, {
        action_type: updated.actionType
      });
      return updated;
    }
  };
}
