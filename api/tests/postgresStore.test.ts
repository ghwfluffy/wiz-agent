import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createPostgresStore } from "../src/domain/store.js";
import type { RequestContext } from "../src/domain/types.js";

type QueryCall = {
  sql: string;
  values: unknown[] | undefined;
};

function testContext(): RequestContext {
  const now = new Date().toISOString();
  return {
    userId: "owner",
    actorType: "user",
    permissions: ["agent:use"],
    requestId: "request-1",
    session: {
      id: "session-1",
      user: {
        id: "owner",
        email: "owner@example.test",
        displayName: "Owner",
        isAdmin: true
      },
      createdAt: now,
      expiresAt: now
    }
  };
}

describe("postgres store", () => {
  it("serializes MCP session tool allowlists as JSONB parameters", async () => {
    const calls: QueryCall[] = [];
    const pool = {
      async query(sql: string, values?: unknown[]) {
        calls.push({ sql, values });
        return { rows: [] };
      }
    } as unknown as Pool;
    const store = createPostgresStore(pool);

    const session = await store.createAgentMcpSession(testContext(), {
      runId: "run-1",
      allowedTools: ["create_task", "list_tasks"],
      ttlSeconds: 60
    });

    expect(session.allowedTools).toEqual(["create_task", "list_tasks"]);
    const insert = calls.find((call) => call.sql.includes("INSERT INTO agent_mcp_sessions"));
    expect(insert?.values?.[4]).toBe(JSON.stringify(["create_task", "list_tasks"]));
  });
});
