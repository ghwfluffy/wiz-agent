import { describe, expect, it } from "vitest";
import { INITIAL_SCHEMA_SQL } from "../src/db/schema.js";

describe("initial schema", () => {
  it("defines the phase 3 core tables", () => {
    for (const table of [
      "tenants",
      "users",
      "tenant_memberships",
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
      "admin_ai_config"
    ]) {
      expect(INITIAL_SCHEMA_SQL).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
  });
});
