export const COLLAPSE_TENANT_TO_USER_MIGRATION_ID = "0002_collapse_tenant_to_user";

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
