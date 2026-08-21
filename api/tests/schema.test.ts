import { describe, expect, it } from "vitest";
import {
  COLLAPSE_TENANT_TO_USER_MIGRATION_ID,
  COLLAPSE_TENANT_TO_USER_SQL,
  MEMORY_MARKDOWN_BACKFILL_MIGRATION_ID,
  MEMORY_MARKDOWN_BACKFILL_SQL,
  MCP_TOOL_ALLOWLIST_MIGRATION_ID,
  MCP_TOOL_ALLOWLIST_SQL,
  APPROVAL_POLICY_MIGRATION_ID,
  APPROVAL_POLICY_SQL,
  CONVERSATION_THREADING_MIGRATION_ID,
  CONVERSATION_THREADING_SQL,
  OUTBOUND_CONVERSATION_THREAD_MIGRATION_ID,
  OUTBOUND_CONVERSATION_THREAD_SQL,
  WEB_RESEARCH_SESSIONS_MIGRATION_ID,
  WEB_RESEARCH_SESSIONS_SQL,
  OUTBOUND_PROACTIVE_ORIGIN_MIGRATION_ID,
  OUTBOUND_PROACTIVE_ORIGIN_SQL,
  RAG_JOB_COALESCING_MIGRATION_ID,
  RAG_JOB_COALESCING_SQL,
  OUTBOUND_DEDUPE_KEY_MIGRATION_ID,
  OUTBOUND_DEDUPE_KEY_SQL,
  MARKDOWN_SECTION_COMPACTION_MIGRATION_ID,
  MARKDOWN_SECTION_COMPACTION_SQL
} from "../src/db/migrations.js";
import { INITIAL_SCHEMA_SQL } from "../src/db/schema.js";

describe("initial schema", () => {
  it("defines the user-owned core tables", () => {
    for (const table of [
      "users",
      "identities",
      "sessions",
      "oauth_state_records",
      "connectors",
      "connector_secret_refs",
      "conversations",
      "conversation_threads",
      "web_research_sessions",
      "messages",
      "tasks",
      "task_events",
      "approvals",
      "senders",
      "memory_documents",
      "memory_revisions",
      "markdown_documents",
      "markdown_sections",
      "markdown_document_chunks",
      "rag_index_jobs",
      "rag_user_indexes",
      "outbound_messages",
      "attachments",
      "links",
      "article_snapshots",
      "agent_runs",
      "agent_mcp_sessions",
      "tool_calls",
      "audit_log",
      "admin_ai_config",
      "schema_migrations"
    ]) {
      expect(INITIAL_SCHEMA_SQL).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
  });

  it("does not define tenant tables or columns", () => {
    expect(INITIAL_SCHEMA_SQL).not.toContain("CREATE TABLE IF NOT EXISTS tenants");
    expect(INITIAL_SCHEMA_SQL).not.toContain("CREATE TABLE IF NOT EXISTS tenant_memberships");
    expect(INITIAL_SCHEMA_SQL).not.toContain("tenant_id");
  });

  it("keeps user ownership columns and indexes", () => {
    expect(INITIAL_SCHEMA_SQL).toContain("user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE");
    expect(INITIAL_SCHEMA_SQL).toContain("user_id TEXT REFERENCES users(id) ON DELETE SET NULL");
    expect(INITIAL_SCHEMA_SQL).toContain("UNIQUE (user_id, address)");
    expect(INITIAL_SCHEMA_SQL).toContain("UNIQUE (user_id, slug)");
    expect(INITIAL_SCHEMA_SQL).toContain("idx_tasks_user_status_due");
    expect(INITIAL_SCHEMA_SQL).toContain("idx_audit_log_user_created");
    expect(INITIAL_SCHEMA_SQL).toContain("idx_agent_runs_user_started");
    expect(INITIAL_SCHEMA_SQL).toContain("idx_agent_mcp_sessions_token");
    expect(INITIAL_SCHEMA_SQL).toContain("idx_approvals_user_status_created");
    expect(INITIAL_SCHEMA_SQL).toContain("allowed_tools_json JSONB");
    expect(INITIAL_SCHEMA_SQL).toContain("source_run_id TEXT");
    expect(INITIAL_SCHEMA_SQL).toContain("expires_at TIMESTAMPTZ");
    expect(INITIAL_SCHEMA_SQL).toContain("ADD COLUMN IF NOT EXISTS execution_status TEXT");
    expect(INITIAL_SCHEMA_SQL).toContain("idx_conversation_threads_user_status_updated");
    expect(INITIAL_SCHEMA_SQL).toContain("conversation_thread_id TEXT REFERENCES conversation_threads(id)");
    expect(INITIAL_SCHEMA_SQL).toContain("bundle_json JSONB NOT NULL");
    expect(INITIAL_SCHEMA_SQL).toContain("idx_web_research_sessions_thread_created");
    expect(INITIAL_SCHEMA_SQL).toContain("origin TEXT NOT NULL DEFAULT 'legacy'");
    expect(INITIAL_SCHEMA_SQL).toContain("is_proactive BOOLEAN NOT NULL DEFAULT false");
    expect(INITIAL_SCHEMA_SQL).toContain("dedupe_key TEXT");
    expect(INITIAL_SCHEMA_SQL).toContain("delivery_attempts INTEGER NOT NULL DEFAULT 0");
    expect(INITIAL_SCHEMA_SQL).toContain("next_delivery_attempt_at TIMESTAMPTZ");
  });

  it("defines the tenant-collapse migration", () => {
    expect(COLLAPSE_TENANT_TO_USER_MIGRATION_ID).toBe("0002_collapse_tenant_to_user");
    expect(COLLAPSE_TENANT_TO_USER_SQL).toContain("ALTER TABLE sessions DROP COLUMN IF EXISTS tenant_id CASCADE");
    expect(COLLAPSE_TENANT_TO_USER_SQL).toContain("DROP TABLE IF EXISTS tenant_memberships CASCADE");
    expect(COLLAPSE_TENANT_TO_USER_SQL).toContain("DROP TABLE IF EXISTS tenants CASCADE");
    expect(COLLAPSE_TENANT_TO_USER_SQL).toContain("idx_tasks_user_status_due");
  });

  it("defines the memory markdown backfill migration", () => {
    expect(MEMORY_MARKDOWN_BACKFILL_MIGRATION_ID).toBe("0003_memory_markdown_backfill");
    expect(MEMORY_MARKDOWN_BACKFILL_SQL).toContain("CREATE TABLE IF NOT EXISTS agent_mcp_sessions");
    expect(MEMORY_MARKDOWN_BACKFILL_SQL).toContain("WHEN m.slug = 'personal-profile' THEN '/personal/profile.md'");
    expect(MEMORY_MARKDOWN_BACKFILL_SQL).toContain("WHEN m.slug = 'newsletter-preferences' THEN '/preferences/newsletters.md'");
    expect(MEMORY_MARKDOWN_BACKFILL_SQL).toContain("ON CONFLICT (user_id, path) DO NOTHING");
    expect(MEMORY_MARKDOWN_BACKFILL_SQL).toContain("NOT EXISTS");
  });

  it("defines the MCP tool allowlist migration", () => {
    expect(MCP_TOOL_ALLOWLIST_MIGRATION_ID).toBe("0004_mcp_tool_allowlist");
    expect(MCP_TOOL_ALLOWLIST_SQL).toContain("ADD COLUMN IF NOT EXISTS allowed_tools_json JSONB");
  });

  it("defines the approval policy migration", () => {
    expect(APPROVAL_POLICY_MIGRATION_ID).toBe("0006_approval_policy");
    expect(APPROVAL_POLICY_SQL).toContain("ADD COLUMN IF NOT EXISTS source_run_id TEXT");
    expect(APPROVAL_POLICY_SQL).toContain("idx_approvals_user_status_created");
  });

  it("defines the conversation threading migration", () => {
    expect(CONVERSATION_THREADING_MIGRATION_ID).toBe("0008_conversation_threading");
    expect(CONVERSATION_THREADING_SQL).toContain("CREATE TABLE IF NOT EXISTS conversation_threads");
    expect(CONVERSATION_THREADING_SQL).toContain("linked_task_ids_json JSONB");
    expect(CONVERSATION_THREADING_SQL).toContain("idx_conversation_threads_user_status_updated");
  });

  it("defines the outbound conversation-thread migration", () => {
    expect(OUTBOUND_CONVERSATION_THREAD_MIGRATION_ID).toBe("0010_outbound_conversation_thread");
    expect(OUTBOUND_CONVERSATION_THREAD_SQL).toContain("ADD COLUMN IF NOT EXISTS conversation_thread_id TEXT");
    expect(OUTBOUND_CONVERSATION_THREAD_SQL).toContain("idx_outbound_messages_conversation_thread");
  });

  it("defines durable externally-tainted web research sessions", () => {
    expect(WEB_RESEARCH_SESSIONS_MIGRATION_ID).toBe("0011_web_research_sessions");
    expect(WEB_RESEARCH_SESSIONS_SQL).toContain("CREATE TABLE IF NOT EXISTS web_research_sessions");
    expect(WEB_RESEARCH_SESSIONS_SQL).toContain("taint TEXT NOT NULL DEFAULT 'external_web'");
    expect(WEB_RESEARCH_SESSIONS_SQL).toContain("idx_web_research_sessions_thread_created");
  });

  it("persists outbound origin and proactive classification", () => {
    expect(OUTBOUND_PROACTIVE_ORIGIN_MIGRATION_ID).toBe("0012_outbound_proactive_origin");
    expect(OUTBOUND_PROACTIVE_ORIGIN_SQL).toContain("ADD COLUMN IF NOT EXISTS origin TEXT");
    expect(OUTBOUND_PROACTIVE_ORIGIN_SQL).toContain("ADD COLUMN IF NOT EXISTS is_proactive BOOLEAN");
    expect(OUTBOUND_PROACTIVE_ORIGIN_SQL).toContain("idx_outbound_messages_user_proactive_created");
  });

  it("coalesces superseded pending RAG index jobs", () => {
    expect(RAG_JOB_COALESCING_MIGRATION_ID).toBe("0013_rag_job_coalescing");
    expect(RAG_JOB_COALESCING_SQL).toContain("DELETE FROM rag_index_jobs");
    expect(RAG_JOB_COALESCING_SQL).toContain("idx_rag_index_jobs_active_document_request");
  });

  it("adds idempotent, retryable daily outbound delivery metadata", () => {
    expect(OUTBOUND_DEDUPE_KEY_MIGRATION_ID).toBe("0014_outbound_dedupe_key");
    expect(OUTBOUND_DEDUPE_KEY_SQL).toContain("ADD COLUMN IF NOT EXISTS dedupe_key TEXT");
    expect(OUTBOUND_DEDUPE_KEY_SQL).toContain("ADD COLUMN IF NOT EXISTS delivery_attempts INTEGER");
    expect(OUTBOUND_DEDUPE_KEY_SQL).toContain("idx_outbound_messages_user_dedupe_key");
    expect(OUTBOUND_DEDUPE_KEY_SQL).toContain("idx_outbound_messages_delivery_retry");
    expect(INITIAL_SCHEMA_SQL).not.toContain("idx_outbound_messages_user_dedupe_key");
  });

  it("compacts markdown sections to current live document versions and requeues pending documents", () => {
    expect(MARKDOWN_SECTION_COMPACTION_MIGRATION_ID).toBe("0015_markdown_section_compaction");
    expect(MARKDOWN_SECTION_COMPACTION_SQL).toContain("LOCK TABLE markdown_documents IN SHARE MODE");
    expect(MARKDOWN_SECTION_COMPACTION_SQL).toContain("CREATE TEMP TABLE current_markdown_sections_snapshot");
    expect(MARKDOWN_SECTION_COMPACTION_SQL).toContain("sections.document_version = documents.version");
    expect(MARKDOWN_SECTION_COMPACTION_SQL).toContain("documents.deleted_at IS NULL");
    expect(MARKDOWN_SECTION_COMPACTION_SQL).toContain("TRUNCATE TABLE markdown_sections");
    expect(MARKDOWN_SECTION_COMPACTION_SQL).toContain("FROM current_markdown_sections_snapshot");
    expect(MARKDOWN_SECTION_COMPACTION_SQL).toContain("documents.index_status = 'pending'");
    expect(MARKDOWN_SECTION_COMPACTION_SQL).toContain("jobs.status IN ('pending', 'claimed')");
    expect(MARKDOWN_SECTION_COMPACTION_SQL).toContain("ON CONFLICT DO NOTHING");

    const snapshot = MARKDOWN_SECTION_COMPACTION_SQL.indexOf("CREATE TEMP TABLE");
    const truncate = MARKDOWN_SECTION_COMPACTION_SQL.indexOf("TRUNCATE TABLE markdown_sections");
    const restore = MARKDOWN_SECTION_COMPACTION_SQL.indexOf("FROM current_markdown_sections_snapshot", truncate);
    expect(snapshot).toBeGreaterThanOrEqual(0);
    expect(truncate).toBeGreaterThan(snapshot);
    expect(restore).toBeGreaterThan(truncate);
  });
});
