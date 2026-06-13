import { describe, expect, it } from "vitest";
import { loadSettings } from "../src/config/settings.js";
import { createMemoryStore } from "../src/domain/store.js";
import type { RequestContext } from "../src/domain/types.js";
import { buildMcpApp } from "../src/mcp/server.js";
import { chunkMarkdownDocument, deterministicPointId } from "../src/rag/chunking.js";
import { MockEmbeddingClient } from "../src/rag/embeddings.js";
import { processRagIndexJobs } from "../src/rag/indexer.js";
import type { QdrantClient, QdrantPoint, QdrantSearchHit } from "../src/rag/qdrant.js";
import { HttpQdrantClient, qdrantDocumentFilter } from "../src/rag/qdrant.js";

class FakeQdrantClient implements QdrantClient {
  collections = new Map<string, Map<string, QdrantPoint>>();
  failUpserts = false;

  async health(): Promise<{ ok: boolean; status?: number }> {
    return { ok: true, status: 200 };
  }

  async ensureCollection(collection: string): Promise<void> {
    if (!this.collections.has(collection)) {
      this.collections.set(collection, new Map());
    }
  }

  async upsertPoints(collection: string, points: QdrantPoint[]): Promise<void> {
    if (this.failUpserts) {
      throw new Error("qdrant unavailable");
    }
    const existing = this.collections.get(collection) ?? new Map<string, QdrantPoint>();
    for (const point of points) {
      existing.set(point.id, point);
    }
    this.collections.set(collection, existing);
  }

  async deletePointsByDocumentId(collection: string, documentId: string): Promise<void> {
    const points = this.collections.get(collection) ?? new Map<string, QdrantPoint>();
    for (const [id, point] of points.entries()) {
      if (point.payload.document_id === documentId) {
        points.delete(id);
      }
    }
  }

  async search(collection: string, _vector: number[], input: { pathPrefix?: string; limit?: number } = {}): Promise<QdrantSearchHit[]> {
    const prefix = input.pathPrefix;
    return [...(this.collections.get(collection)?.values() ?? [])]
      .filter((point) => {
        const path = String(point.payload.path ?? "");
        return !prefix || prefix === "/" || path === prefix || path.startsWith(`${prefix}/`);
      })
      .slice(0, input.limit ?? 10)
      .map((point, index) => ({ id: point.id, score: 1 - index / 10, payload: point.payload }));
  }

  async countPoints(collection: string): Promise<number> {
    return this.collections.get(collection)?.size ?? 0;
  }
}

async function testContext(userId: string): Promise<{ store: ReturnType<typeof createMemoryStore>; context: RequestContext }> {
  const store = createMemoryStore();
  const settings = loadSettings({
    APP_ENV: "test",
    AUTH_MODE: "standalone",
    DEV_USER_ID: userId,
    DEV_USER_EMAIL: `${userId}@example.test`,
    RAG_EMBEDDING_DIMENSIONS: "4"
  });
  const session = await store.createDevelopmentSession(settings, `${userId}-login`);
  return {
    store,
    context: {
      userId: session.user.id,
      actorType: "user",
      permissions: ["user"],
      requestId: `${userId}-request`,
      session
    }
  };
}

describe("RAG chunking", () => {
  it("preserves section metadata and deterministic point ids", async () => {
    const { store, context } = await testContext("owner");
    const document = await store.writeMarkdownDocument(context, {
      path: "/projects/alpha/notes.md",
      markdown: "# Alpha\nIntro.\n\n## Decision\nUse mocked embeddings."
    });
    if ("code" in document) {
      throw new Error("unexpected conflict");
    }

    const chunks = chunkMarkdownDocument(document);
    expect(chunks).toEqual([
      expect.objectContaining({
        sectionId: "alpha",
        headingPath: ["Alpha"],
        path: "/projects/alpha/notes.md",
        dir: "/projects/alpha",
        topLevel: "projects",
        filename: "notes.md",
        pathPrefixes: ["/", "/projects", "/projects/alpha", "/projects/alpha/notes.md"],
        chunkIndex: 0
      }),
      expect.objectContaining({
        sectionId: "alpha/decision",
        headingPath: ["Alpha", "Decision"],
        chunkIndex: 1
      })
    ]);
    expect(chunks[0]?.pointId).toBe(deterministicPointId("owner", document.id, document.version, 0));
    expect(chunkMarkdownDocument(document)).toEqual(chunks);
  });

  it("compiles document delete filters without collection input", () => {
    expect(qdrantDocumentFilter("doc-1")).toEqual({
      must: [{ key: "document_id", match: { value: "doc-1" } }]
    });
  });

  it("sends path-prefix filters against indexed prefix payloads", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const fetchImpl: typeof fetch = async (_url, init) => {
      requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({ result: [] }), { status: 200 });
    };
    const settings = loadSettings({ APP_ENV: "test", AUTH_MODE: "standalone", RAG_EMBEDDING_DIMENSIONS: "4" });
    const client = new HttpQdrantClient(settings, fetchImpl);

    await client.search("user_owner_rag", [0, 1, 0, 1], { pathPrefix: "/projects/alpha", limit: 3 });

    expect(requestBody).toMatchObject({
      filter: {
        must: [
          { key: "path_prefixes", match: { value: "/projects/alpha" } }
        ]
      }
    });
  });
});

describe("RAG worker", () => {
  it("reclaims stale claimed jobs after restart grace", async () => {
    const { store, context } = await testContext("owner");
    await store.writeMarkdownDocument(context, {
      path: "/assistant/restart.md",
      markdown: "# Restart\nResume indexing."
    });

    const first = await store.claimRagIndexJobs(1, new Date(Date.now() + 1000));
    expect(first).toHaveLength(1);
    const stale = await store.claimRagIndexJobs(1, new Date(Date.now() + 6 * 60_000));

    expect(stale).toEqual([
      expect.objectContaining({
        id: first[0]?.id,
        attempts: 2,
        status: "claimed"
      })
    ]);
  });

  it("indexes pending markdown jobs with mock embeddings and Qdrant", async () => {
    const { store, context } = await testContext("owner");
    await store.writeMarkdownDocument(context, {
      path: "/personal/profile.md",
      markdown: "# Profile\nLikes deterministic tests."
    });
    const qdrant = new FakeQdrantClient();
    const settings = loadSettings({ APP_ENV: "test", AUTH_MODE: "standalone", RAG_EMBEDDING_DIMENSIONS: "4" });

    await expect(processRagIndexJobs({
      store,
      qdrant,
      embeddings: new MockEmbeddingClient(),
      settings
    })).resolves.toMatchObject({ claimed: 1, indexed: 1, failed: 0 });

    const [status] = await store.getMarkdownIndexStatus(context, "/personal");
    expect(status).toMatchObject({ indexStatus: "indexed", pendingJobs: 0 });
    const points = [...([...(qdrant.collections.values())][0]?.values() ?? [])];
    expect(points).toHaveLength(1);
    expect(points[0]?.payload.path_prefixes).toEqual(["/", "/personal", "/personal/profile.md"]);
  });

  it("skips stale version jobs and indexes the current document job", async () => {
    const { store, context } = await testContext("owner");
    const first = await store.writeMarkdownDocument(context, {
      path: "/personal/profile.md",
      markdown: "# Profile\nOld version."
    });
    if ("code" in first) {
      throw new Error("unexpected conflict");
    }
    await store.writeMarkdownDocument(context, {
      path: "/personal/profile.md",
      markdown: "# Profile\nCurrent version.",
      expectedVersion: first.version
    });
    const qdrant = new FakeQdrantClient();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      RAG_EMBEDDING_DIMENSIONS: "4",
      RAG_INDEX_BATCH_SIZE: "1"
    });

    await expect(processRagIndexJobs({
      store,
      qdrant,
      embeddings: new MockEmbeddingClient(),
      settings
    })).resolves.toMatchObject({ claimed: 1, indexed: 0, failed: 0 });
    expect([...qdrant.collections.values()][0]?.size ?? 0).toBe(0);

    await expect(processRagIndexJobs({
      store,
      qdrant,
      embeddings: new MockEmbeddingClient(),
      settings
    })).resolves.toMatchObject({ claimed: 1, indexed: 1, failed: 0 });
    const point = [...([...(qdrant.collections.values())][0]?.values() ?? [])][0];
    expect(point?.payload.document_version).toBe(2);
    expect(point?.payload.excerpt).toContain("Current version.");
  });

  it("retries transient failures and marks jobs dead after the attempt limit", async () => {
    const { store, context } = await testContext("owner");
    await store.writeMarkdownDocument(context, {
      path: "/assistant/schedule.md",
      markdown: "# Schedule\nRetry this."
    });
    const qdrant = new FakeQdrantClient();
    qdrant.failUpserts = true;
    const settings = loadSettings({ APP_ENV: "test", AUTH_MODE: "standalone", RAG_EMBEDDING_DIMENSIONS: "4" });
    const embeddings = new MockEmbeddingClient();

    await expect(processRagIndexJobs({ store, qdrant, embeddings, settings })).resolves.toMatchObject({ failed: 1 });
    await expect(processRagIndexJobs({
      store,
      qdrant,
      embeddings,
      settings,
      now: new Date(Date.now() + 100_000)
    })).resolves.toMatchObject({ failed: 1 });
    await expect(processRagIndexJobs({
      store,
      qdrant,
      embeddings,
      settings,
      now: new Date(Date.now() + 100_000)
    })).resolves.toMatchObject({ dead: 1 });

    await expect(store.getMarkdownIndexStatus(context, "/assistant")).resolves.toEqual([
      expect.objectContaining({ indexStatus: "pending", pendingJobs: 0 })
    ]);
  });

  it("deletion jobs remove document points", async () => {
    const { store, context } = await testContext("owner");
    const document = await store.writeMarkdownDocument(context, {
      path: "/projects/alpha/notes.md",
      markdown: "# Alpha\nDelete me."
    });
    if ("code" in document) {
      throw new Error("unexpected conflict");
    }
    const qdrant = new FakeQdrantClient();
    const settings = loadSettings({ APP_ENV: "test", AUTH_MODE: "standalone", RAG_EMBEDDING_DIMENSIONS: "4" });
    await processRagIndexJobs({ store, qdrant, embeddings: new MockEmbeddingClient(), settings });
    expect([...qdrant.collections.values()][0]?.size).toBe(1);

    await store.deleteMarkdownPath(context, "/projects/alpha/notes.md");
    await expect(processRagIndexJobs({
      store,
      qdrant,
      embeddings: new MockEmbeddingClient(),
      settings
    })).resolves.toMatchObject({ deleted: 1 });
    expect([...qdrant.collections.values()][0]?.size).toBe(0);
  });
});

describe("MCP semantic search", () => {
  it("returns source handles for the resolved user only", async () => {
    const { store, context } = await testContext("owner");
    const otherSettings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      DEV_USER_ID: "other",
      DEV_USER_EMAIL: "other@example.test",
      RAG_EMBEDDING_DIMENSIONS: "4"
    });
    const otherSession = await store.createDevelopmentSession(otherSettings, "other-login");
    const other: RequestContext = {
      userId: otherSession.user.id,
      actorType: "user",
      permissions: ["user"],
      requestId: "other-request",
      session: otherSession
    };
    await store.writeMarkdownDocument(context, {
      path: "/projects/alpha/notes.md",
      markdown: "# Alpha\nOwner-only launch notes."
    });
    await store.writeMarkdownDocument(other, {
      path: "/projects/alpha/notes.md",
      markdown: "# Alpha\nOther user's launch notes."
    });
    const qdrant = new FakeQdrantClient();
    const settings = loadSettings({ APP_ENV: "test", AUTH_MODE: "standalone", RAG_EMBEDDING_DIMENSIONS: "4" });
    await processRagIndexJobs({ store, qdrant, embeddings: new MockEmbeddingClient(), settings });
    await processRagIndexJobs({ store, qdrant, embeddings: new MockEmbeddingClient(), settings });

    const session = await store.createAgentMcpSession(context, { ttlSeconds: 60 });
    const app = buildMcpApp({
      settings,
      store,
      qdrant,
      embeddings: new MockEmbeddingClient()
    });
    const response = await app.request("/mcp/v1/tools/search_semantic", {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        query: "launch",
        pathPrefix: "/projects",
        limit: 10,
        userId: "other"
      })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      result: {
        matches: [
          expect.objectContaining({
            path: "/projects/alpha/notes.md",
            sectionId: "alpha",
            excerpt: expect.stringContaining("Owner-only")
          })
        ],
        guidance: expect.stringContaining("Read the source file")
      }
    });
  });
});
