import { describe, expect, it } from "vitest";
import {
  COLLAPSE_TENANT_TO_USER_MIGRATION_ID,
  COLLAPSE_TENANT_TO_USER_SQL,
  MEMORY_MARKDOWN_BACKFILL_MIGRATION_ID,
  MEMORY_MARKDOWN_BACKFILL_SQL,
  MCP_TOOL_ALLOWLIST_MIGRATION_ID,
  MCP_TOOL_ALLOWLIST_SQL
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
    expect(INITIAL_SCHEMA_SQL).toContain("allowed_tools_json JSONB");
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
});
