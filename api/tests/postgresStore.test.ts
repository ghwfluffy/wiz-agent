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

  it("replaces every stored section version with one current-version bulk insert", async () => {
    const calls: QueryCall[] = [];
    const now = new Date("2026-06-13T12:00:00.000Z");
    const markdown = "intro\n\n# Root\n\n## Child\nBody.";
    const client = {
      async query(sql: string, values?: unknown[]) {
        calls.push({ sql, values });
        if (sql.includes("SELECT * FROM markdown_documents")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("INSERT INTO markdown_documents")) {
          return {
            rows: [{
              id: "document-1",
              user_id: "owner",
              path: "/personal/profile.md",
              basename: "profile.md",
              title: "Root",
              markdown,
              content_hash: "content-hash",
              version: 1,
              index_status: "pending",
              created_at: now,
              updated_at: now
            }],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 0 };
      },
      release() {}
    };
    const pool = {
      async connect() {
        return client;
      },
      async query(sql: string, values?: unknown[]) {
        calls.push({ sql, values });
        return { rows: [], rowCount: 0 };
      }
    } as unknown as Pool;
    const store = createPostgresStore(pool);

    await store.writeMarkdownDocument(testContext(), {
      path: "/personal/profile.md",
      markdown
    });

    const sectionDelete = calls.find((call) => call.sql.includes("DELETE FROM markdown_sections"));
    expect(sectionDelete?.sql).not.toContain("document_version");
    expect(sectionDelete?.values).toEqual(["owner", "document-1"]);
    const sectionInserts = calls.filter((call) => call.sql.includes("INSERT INTO markdown_sections"));
    expect(sectionInserts).toHaveLength(1);
    expect(sectionInserts[0]?.sql).toContain("FROM unnest(");
    expect(sectionInserts[0]?.values?.[4]).toEqual(["_preamble", "root", "root/child"]);
    expect(sectionInserts[0]?.values?.[5]).toEqual([null, null, "root"]);
    expect(sectionInserts[0]?.values?.[7]).toEqual(["[]", "[\"Root\"]", "[\"Root\",\"Child\"]"]);
  });

  it("replaces document chunks with one fixed-parameter bulk insert", async () => {
    const calls: QueryCall[] = [];
    const client = {
      async query(sql: string, values?: unknown[]) {
        calls.push({ sql, values });
        return { rows: [], rowCount: 0 };
      },
      release() {}
    };
    const pool = {
      async connect() {
        return client;
      },
      async query(sql: string, values?: unknown[]) {
        calls.push({ sql, values });
        return { rows: [], rowCount: 0 };
      }
    } as unknown as Pool;
    const store = createPostgresStore(pool);

    await store.replaceDocumentChunks(testContext(), "document-1", [
      {
        id: "chunk-1",
        documentVersion: 4,
        sectionId: "root",
        headingPath: ["Root"],
        chunkIndex: 0,
        content: "first",
        contentHash: "hash-1",
        qdrantPointId: "point-1",
        qdrantCollection: "collection-1",
        embeddingModel: "embedding-model",
        embeddingDimensions: 1536,
        indexedAt: "2026-06-13T12:00:00.000Z"
      },
      {
        id: "chunk-2",
        documentVersion: 4,
        sectionId: "root/child",
        headingPath: ["Root", "Child"],
        chunkIndex: 1,
        content: "second",
        contentHash: "hash-2",
        qdrantPointId: "point-2",
        qdrantCollection: "collection-1",
        embeddingModel: "embedding-model",
        embeddingDimensions: 1536
      }
    ]);

    const chunkInserts = calls.filter((call) => call.sql.includes("INSERT INTO markdown_document_chunks"));
    expect(chunkInserts).toHaveLength(1);
    expect(chunkInserts[0]?.sql).toContain("FROM unnest(");
    expect(chunkInserts[0]?.values?.[2]).toEqual(["chunk-1", "chunk-2"]);
    expect(chunkInserts[0]?.values?.[5]).toEqual(["[\"Root\"]", "[\"Root\",\"Child\"]"]);
    expect(chunkInserts[0]?.values?.[7]).toEqual(["first", "second"]);
  });

  it("returns well-formed code-point-bounded semantic excerpts from Postgres rows", async () => {
    const content = `bad\uD800${"a".repeat(315)}🚀tail`;
    const pool = {
      async query(sql: string) {
        if (sql.includes("FROM markdown_document_chunks c")) {
          return {
            rows: [{
              path: "/assistant/unicode-excerpt.md",
              version: 1,
              section_id: "unicode-excerpt",
              heading_path: ["Unicode excerpt"],
              chunk_index: 0,
              content,
              qdrant_point_id: "unicode-point"
            }],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 0 };
      }
    } as unknown as Pool;
    const store = createPostgresStore(pool);

    const [result] = await store.searchMarkdownSemantic(testContext(), {
      pointIds: ["unicode-point"],
      scoresByPointId: { "unicode-point": 0.9 }
    });

    expect(result?.excerpt).toBe(`bad\uFFFD${"a".repeat(315)}🚀`);
    expect(Array.from(result?.excerpt ?? "")).toHaveLength(320);
    expect(result?.excerpt).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it("resets manual RAG retry attempts and audits the prior count", async () => {
    const calls: QueryCall[] = [];
    const now = new Date("2026-06-13T12:00:00.000Z");
    const pool = {
      async query(sql: string, values?: unknown[]) {
        calls.push({ sql, values });
        if (sql.includes("WITH retry_target AS")) {
          return {
            rows: [{
              id: "job-1",
              user_id: "owner",
              document_id: "document-1",
              requested_version: 4,
              requested_content_hash: "content-hash",
              job_type: "index_markdown",
              status: "pending",
              attempts: 0,
              prior_attempts: 4,
              last_error: null,
              available_at: now,
              started_at: null,
              completed_at: null,
              created_at: now
            }],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 0 };
      }
    } as unknown as Pool;
    const store = createPostgresStore(pool);
    const context = testContext();
    context.actorType = "admin";
    context.permissions = ["agent:use", "admin"];

    await expect(store.retryRagIndexJob(context, "job-1", true)).resolves.toMatchObject({
      id: "job-1",
      status: "pending",
      attempts: 0
    });

    const retry = calls.find((call) => call.sql.includes("WITH retry_target AS"));
    expect(retry?.sql).toContain("attempts = 0");
    const audit = calls.find((call) => call.sql.includes("INSERT INTO audit_log"));
    expect(audit?.values?.[6]).toMatchObject({
      requested_job_id: "job-1",
      active_job_id: "job-1",
      reused_active_job: false,
      prior_attempts: 4,
      attempts: 0
    });
  });
});
