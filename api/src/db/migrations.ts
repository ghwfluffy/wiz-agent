export const COLLAPSE_TENANT_TO_USER_MIGRATION_ID = "0002_collapse_tenant_to_user";
export const MEMORY_MARKDOWN_BACKFILL_MIGRATION_ID = "0003_memory_markdown_backfill";
export const MCP_TOOL_ALLOWLIST_MIGRATION_ID = "0004_mcp_tool_allowlist";
export const TASK_SCHEDULE_CONTEXT_MIGRATION_ID = "0005_task_schedule_context";
export const APPROVAL_POLICY_MIGRATION_ID = "0006_approval_policy";
export const APPROVAL_EXECUTION_MIGRATION_ID = "0007_approval_execution";
export const CONVERSATION_THREADING_MIGRATION_ID = "0008_conversation_threading";
export const SANITIZED_INBOUND_IMAGES_MIGRATION_ID = "0009_sanitized_inbound_images";
export const OUTBOUND_CONVERSATION_THREAD_MIGRATION_ID = "0010_outbound_conversation_thread";
export const WEB_RESEARCH_SESSIONS_MIGRATION_ID = "0011_web_research_sessions";
export const OUTBOUND_PROACTIVE_ORIGIN_MIGRATION_ID = "0012_outbound_proactive_origin";
export const RAG_JOB_COALESCING_MIGRATION_ID = "0013_rag_job_coalescing";
export const OUTBOUND_DEDUPE_KEY_MIGRATION_ID = "0014_outbound_dedupe_key";
export const MARKDOWN_SECTION_COMPACTION_MIGRATION_ID = "0015_markdown_section_compaction";

const tenantOwnedTables = [
  "identities",
  "sessions",
  "oauth_state_records",
  "connectors",
  "conversations",
  "messages",
  "tasks",
  "task_events",
  "approvals",
  "senders",
  "memory_documents",
  "memory_revisions",
  "outbound_messages",
  "attachments",
  "links",
  "article_snapshots",
  "agent_runs",
  "tool_calls",
  "audit_log"
];

const dropTenantColumnsSql = tenantOwnedTables
  .map((table) => `ALTER TABLE ${table} DROP COLUMN IF EXISTS tenant_id CASCADE;`)
  .join("\n");

export const COLLAPSE_TENANT_TO_USER_SQL = `
DROP INDEX IF EXISTS idx_tasks_tenant_user_status_due;
DROP INDEX IF EXISTS idx_audit_log_tenant_user_created;
DROP INDEX IF EXISTS idx_agent_runs_tenant_user_started;

${dropTenantColumnsSql}

DROP TABLE IF EXISTS tenant_memberships CASCADE;
DROP TABLE IF EXISTS tenants CASCADE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'senders'::regclass
      AND contype = 'u'
      AND conkey = (
        SELECT array_agg(attnum ORDER BY attnum)
        FROM pg_attribute
        WHERE attrelid = 'senders'::regclass
          AND attname IN ('user_id', 'address')
      )
  ) THEN
    ALTER TABLE senders ADD CONSTRAINT senders_user_id_address_unique UNIQUE (user_id, address);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'memory_documents'::regclass
      AND contype = 'u'
      AND conkey = (
        SELECT array_agg(attnum ORDER BY attnum)
        FROM pg_attribute
        WHERE attrelid = 'memory_documents'::regclass
          AND attname IN ('user_id', 'slug')
      )
  ) THEN
    ALTER TABLE memory_documents ADD CONSTRAINT memory_documents_user_id_slug_unique UNIQUE (user_id, slug);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_tasks_user_status_due ON tasks(user_id, status, due_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_user_created ON audit_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_user_started ON agent_runs(user_id, started_at DESC);
`;

export const MEMORY_MARKDOWN_BACKFILL_SQL = `
CREATE TABLE IF NOT EXISTS agent_mcp_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES agent_runs(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_agent_mcp_sessions_token ON agent_mcp_sessions(token_hash) WHERE revoked_at IS NULL;

INSERT INTO markdown_documents
  (id, user_id, path, basename, title, markdown, content_hash, version, index_status, created_at, updated_at)
SELECT
  md5(random()::text || clock_timestamp()::text),
  m.user_id,
  CASE
    WHEN m.slug = 'personal-profile' THEN '/personal/profile.md'
    WHEN m.slug = 'newsletter-preferences' THEN '/preferences/newsletters.md'
    WHEN m.slug = 'agent-schedule' THEN '/assistant/schedule.md'
    WHEN m.slug ~ '^newsletters-[0-9]{4}-[0-9]{2}-[0-9]{2}-.+$'
      THEN '/newsletters/' || substring(m.slug from '^newsletters-([0-9]{4}-[0-9]{2}-[0-9]{2})-.+$') || '/' ||
           regexp_replace(m.slug, '^newsletters-[0-9]{4}-[0-9]{2}-[0-9]{2}-', '') || '.md'
    ELSE '/legacy/' || m.slug || '.md'
  END AS path,
  CASE
    WHEN m.slug = 'personal-profile' THEN 'profile.md'
    WHEN m.slug = 'newsletter-preferences' THEN 'newsletters.md'
    WHEN m.slug = 'agent-schedule' THEN 'schedule.md'
    WHEN m.slug ~ '^newsletters-[0-9]{4}-[0-9]{2}-[0-9]{2}-.+$'
      THEN regexp_replace(m.slug, '^newsletters-[0-9]{4}-[0-9]{2}-[0-9]{2}-', '') || '.md'
    ELSE m.slug || '.md'
  END AS basename,
  m.title,
  m.body,
  md5(m.body),
  1,
  'pending',
  m.created_at,
  m.updated_at
FROM memory_documents m
ON CONFLICT (user_id, path) DO NOTHING;

INSERT INTO rag_index_jobs
  (id, user_id, document_id, requested_version, requested_content_hash, job_type)
SELECT
  md5(random()::text || clock_timestamp()::text),
  d.user_id,
  d.id,
  d.version,
  d.content_hash,
  'index_markdown'
FROM markdown_documents d
WHERE d.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM rag_index_jobs j
    WHERE j.user_id = d.user_id
      AND j.document_id = d.id
      AND j.requested_version = d.version
      AND j.job_type = 'index_markdown'
  );
`;

export const MCP_TOOL_ALLOWLIST_SQL = `
ALTER TABLE agent_mcp_sessions
  ADD COLUMN IF NOT EXISTS allowed_tools_json JSONB;
`;

export const TASK_SCHEDULE_CONTEXT_SQL = `
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS schedule_context_json JSONB NOT NULL DEFAULT '{}'::jsonb;
`;

export const APPROVAL_POLICY_SQL = `
ALTER TABLE approvals
  ADD COLUMN IF NOT EXISTS source_run_id TEXT,
  ADD COLUMN IF NOT EXISTS source_ref TEXT,
  ADD COLUMN IF NOT EXISTS risk_level TEXT NOT NULL DEFAULT 'high',
  ADD COLUMN IF NOT EXISTS summary TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_approvals_user_status_created ON approvals(user_id, status, created_at DESC);
`;

export const APPROVAL_EXECUTION_SQL = `
ALTER TABLE approvals
  ADD COLUMN IF NOT EXISTS execution_status TEXT NOT NULL DEFAULT 'not_applicable',
  ADD COLUMN IF NOT EXISTS execution_result_json JSONB,
  ADD COLUMN IF NOT EXISTS execution_error TEXT,
  ADD COLUMN IF NOT EXISTS executed_at TIMESTAMPTZ;

UPDATE approvals
SET execution_status = 'pending'
WHERE status = 'approved'
  AND action_type = 'cross_app_write_action'
  AND execution_status = 'not_applicable';

CREATE INDEX IF NOT EXISTS idx_approvals_cross_app_execution ON approvals(user_id, execution_status, created_at)
  WHERE status = 'approved' AND action_type = 'cross_app_write_action';
`;

export const CONVERSATION_THREADING_SQL = `
CREATE TABLE IF NOT EXISTS conversation_threads (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  last_owner_intent_summary TEXT,
  unresolved_question TEXT,
  linked_task_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  linked_message_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  linked_memory_paths_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversation_threads_user_status_updated
  ON conversation_threads(user_id, status, updated_at DESC);
`;

export const SANITIZED_INBOUND_IMAGES_SQL = `
ALTER TABLE attachments
  ADD COLUMN IF NOT EXISTS message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS filename TEXT,
  ADD COLUMN IF NOT EXISTS content BYTEA;

CREATE INDEX IF NOT EXISTS idx_attachments_message
  ON attachments(user_id, message_id, created_at)
  WHERE message_id IS NOT NULL;
`;

export const OUTBOUND_CONVERSATION_THREAD_SQL = `
ALTER TABLE outbound_messages
  ADD COLUMN IF NOT EXISTS conversation_thread_id TEXT REFERENCES conversation_threads(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_outbound_messages_conversation_thread
  ON outbound_messages(user_id, conversation_thread_id, created_at)
  WHERE conversation_thread_id IS NOT NULL;
`;

export const WEB_RESEARCH_SESSIONS_SQL = `
CREATE TABLE IF NOT EXISTS web_research_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_session_id TEXT REFERENCES web_research_sessions(id) ON DELETE SET NULL,
  conversation_thread_id TEXT REFERENCES conversation_threads(id) ON DELETE SET NULL,
  source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  source_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  outbound_message_id TEXT REFERENCES outbound_messages(id) ON DELETE SET NULL,
  query TEXT NOT NULL,
  purpose TEXT NOT NULL,
  source_markdown_paths_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  bundle_json JSONB NOT NULL,
  risk_level TEXT NOT NULL,
  taint TEXT NOT NULL DEFAULT 'external_web',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_web_research_sessions_user_created
  ON web_research_sessions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_web_research_sessions_thread_created
  ON web_research_sessions(user_id, conversation_thread_id, created_at DESC)
  WHERE conversation_thread_id IS NOT NULL;
`;

export const OUTBOUND_PROACTIVE_ORIGIN_SQL = `
ALTER TABLE outbound_messages
  ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS is_proactive BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_outbound_messages_user_proactive_created
  ON outbound_messages(user_id, is_proactive, created_at DESC);
`;

export const RAG_JOB_COALESCING_SQL = `
DELETE FROM rag_index_jobs j
WHERE j.job_type = 'index_markdown'
  AND j.status IN ('pending', 'claimed')
  AND NOT EXISTS (
    SELECT 1
    FROM markdown_documents d
    WHERE d.id = j.document_id
      AND d.user_id = j.user_id
      AND d.deleted_at IS NULL
      AND d.version = j.requested_version
      AND d.content_hash = j.requested_content_hash
  );

UPDATE rag_index_jobs
SET status = 'pending',
    started_at = NULL,
    available_at = now()
WHERE status = 'claimed';

WITH ranked_active_jobs AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY user_id, document_id, job_type,
             COALESCE(requested_version, -1), COALESCE(requested_content_hash, '')
           ORDER BY created_at DESC, id DESC
         ) AS duplicate_rank
  FROM rag_index_jobs
  WHERE status IN ('pending', 'claimed')
)
DELETE FROM rag_index_jobs j
USING ranked_active_jobs ranked
WHERE j.id = ranked.id
  AND ranked.duplicate_rank > 1;

INSERT INTO rag_index_jobs
  (id, user_id, document_id, requested_version, requested_content_hash, job_type)
SELECT
  md5(random()::text || clock_timestamp()::text),
  d.user_id,
  d.id,
  d.version,
  d.content_hash,
  'index_markdown'
FROM markdown_documents d
WHERE d.deleted_at IS NULL
  AND (
    d.index_status <> 'indexed'
    OR d.indexed_version IS DISTINCT FROM d.version
    OR d.indexed_content_hash IS DISTINCT FROM d.content_hash
  )
  AND NOT EXISTS (
    SELECT 1
    FROM rag_index_jobs j
    WHERE j.user_id = d.user_id
      AND j.document_id = d.id
      AND j.job_type = 'index_markdown'
      AND j.requested_version = d.version
      AND j.requested_content_hash = d.content_hash
      AND j.status IN ('pending', 'claimed')
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_rag_index_jobs_active_document_request
  ON rag_index_jobs(
    user_id,
    document_id,
    job_type,
    COALESCE(requested_version, -1),
    COALESCE(requested_content_hash, '')
  )
  WHERE status IN ('pending', 'claimed');
`;

export const OUTBOUND_DEDUPE_KEY_SQL = `
ALTER TABLE outbound_messages
  ADD COLUMN IF NOT EXISTS dedupe_key TEXT,
  ADD COLUMN IF NOT EXISTS delivery_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_delivery_attempt_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_outbound_messages_user_dedupe_key
  ON outbound_messages(user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_outbound_messages_delivery_retry
  ON outbound_messages(user_id, status, next_delivery_attempt_at)
  WHERE status IN ('pending', 'approved');
`;

export const MARKDOWN_SECTION_COMPACTION_SQL = `
LOCK TABLE markdown_documents IN SHARE MODE;
LOCK TABLE markdown_sections IN ACCESS EXCLUSIVE MODE;

CREATE TEMP TABLE current_markdown_sections_snapshot
ON COMMIT DROP
AS
SELECT sections.*
FROM markdown_documents documents
JOIN markdown_sections sections
  ON sections.user_id = documents.user_id
 AND sections.document_id = documents.id
 AND sections.document_version = documents.version
WHERE documents.deleted_at IS NULL;

TRUNCATE TABLE markdown_sections;

INSERT INTO markdown_sections
  (id, user_id, document_id, document_version, section_id, parent_section_id, heading,
   heading_path, level, line_start, line_end, content_hash, created_at)
SELECT
  id, user_id, document_id, document_version, section_id, parent_section_id, heading,
  heading_path, level, line_start, line_end, content_hash, created_at
FROM current_markdown_sections_snapshot;

INSERT INTO rag_index_jobs
  (id, user_id, document_id, requested_version, requested_content_hash, job_type)
SELECT
  md5(random()::text || clock_timestamp()::text || documents.id),
  documents.user_id,
  documents.id,
  documents.version,
  documents.content_hash,
  'index_markdown'
FROM markdown_documents documents
WHERE documents.deleted_at IS NULL
  AND documents.index_status = 'pending'
  AND NOT EXISTS (
    SELECT 1
    FROM rag_index_jobs jobs
    WHERE jobs.user_id = documents.user_id
      AND jobs.document_id = documents.id
      AND jobs.job_type = 'index_markdown'
      AND jobs.requested_version = documents.version
      AND jobs.requested_content_hash = documents.content_hash
      AND jobs.status IN ('pending', 'claimed')
  )
ON CONFLICT DO NOTHING;
`;
