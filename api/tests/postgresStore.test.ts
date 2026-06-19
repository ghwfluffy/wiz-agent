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
    expect(insert?.values?.[1]).not.toBe(session.token);
    expect(String(insert?.values?.[1])).toMatch(/^[a-f0-9]{64}$/);
    expect(insert?.values?.[4]).toBe(JSON.stringify(["create_task", "list_tasks"]));
  });

  it("fails closed when stored MCP allowed_tools_json is malformed", async () => {
    const pool = {
      async query(sql: string) {
        if (sql.includes("FROM agent_mcp_sessions")) {
          return {
            rows: [{
              id: "mcp-session-1",
              user_id: "owner",
              run_id: null,
              allowed_tools_json: { tool: "create_task" },
              expires_at: new Date(Date.now() + 60_000)
            }],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 0 };
      }
    } as unknown as Pool;
    const store = createPostgresStore(pool);

    const context = await store.resolveAgentMcpSession("raw-token");

    expect(context?.mcpAllowedTools).toEqual([]);
  });
});
