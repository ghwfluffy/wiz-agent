import { describe, expect, it } from "vitest";
import { COLLAPSE_TENANT_TO_USER_MIGRATION_ID, COLLAPSE_TENANT_TO_USER_SQL } from "../src/db/migrations.js";
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
      "outbound_messages",
      "attachments",
      "links",
      "article_snapshots",
      "agent_runs",
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
  });

  it("defines the tenant-collapse migration", () => {
    expect(COLLAPSE_TENANT_TO_USER_MIGRATION_ID).toBe("0002_collapse_tenant_to_user");
    expect(COLLAPSE_TENANT_TO_USER_SQL).toContain("ALTER TABLE sessions DROP COLUMN IF EXISTS tenant_id CASCADE");
    expect(COLLAPSE_TENANT_TO_USER_SQL).toContain("DROP TABLE IF EXISTS tenant_memberships CASCADE");
    expect(COLLAPSE_TENANT_TO_USER_SQL).toContain("DROP TABLE IF EXISTS tenants CASCADE");
    expect(COLLAPSE_TENANT_TO_USER_SQL).toContain("idx_tasks_user_status_due");
  });
});
