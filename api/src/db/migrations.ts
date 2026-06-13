export const COLLAPSE_TENANT_TO_USER_MIGRATION_ID = "0002_collapse_tenant_to_user";
export const MEMORY_MARKDOWN_BACKFILL_MIGRATION_ID = "0003_memory_markdown_backfill";
export const MCP_TOOL_ALLOWLIST_MIGRATION_ID = "0004_mcp_tool_allowlist";

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
