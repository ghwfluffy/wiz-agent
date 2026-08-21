import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadSettings } from "../src/config/settings.js";
import { createMemoryStore } from "../src/domain/store.js";
import type { RequestContext } from "../src/domain/types.js";
import { buildMcpApp } from "../src/mcp/server.js";
import { chunkMarkdownDocument, deterministicPointId } from "../src/rag/chunking.js";
import { MockEmbeddingClient, OpenAIEmbeddingClient } from "../src/rag/embeddings.js";
import {
  indexMarkdownDocument,
  MAX_RAG_SOURCE_CHARS,
  MAX_RAG_SOURCE_CHUNKS,
  MAX_RAG_SOURCE_SECTIONS,
  processRagIndexJobs,
  RAG_EMBEDDING_BATCH_SIZE,
  RAG_QDRANT_UPSERT_BATCH_SIZE,
  type RagJobProgressEvent
} from "../src/rag/indexer.js";
import type { QdrantClient, QdrantPoint, QdrantSearchHit } from "../src/rag/qdrant.js";
import {
  HttpQdrantClient,
  providerHttpError,
  qdrantCollectionForUser,
  qdrantDocumentFilter,
  RAG_PROVIDER_MAX_RESPONSE_BYTES,
  RagOperationError
} from "../src/rag/qdrant.js";
import {
  isRagWorkerHealthFresh,
  isRagWorkerHealthOutcomeHealthy,
  processRagJobsWhenQdrantHealthy,
  recordRagJobProgress,
  recordRagWorkerLifecycle,
  RAG_WORKER_TICK_WATCHDOG_MS,
  scheduleRagWorkerTickWatchdog,
  type RagWorkerHealthRecord
} from "../src/ragWorker.js";

class FakeQdrantClient implements QdrantClient {
  collections = new Map<string, Map<string, QdrantPoint>>();
  failUpserts = false;
  failCounts = false;
  ensureCalls = 0;
  deleteCalls = 0;
  upsertBatchSizes: number[] = [];

  async health(): Promise<{ ok: boolean; status?: number }> {
    return { ok: true, status: 200 };
  }

  async ensureCollection(collection: string): Promise<void> {
    this.ensureCalls += 1;
    if (!this.collections.has(collection)) {
      this.collections.set(collection, new Map());
    }
  }

  async upsertPoints(collection: string, points: QdrantPoint[]): Promise<void> {
    this.upsertBatchSizes.push(points.length);
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
    this.deleteCalls += 1;
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
    if (this.failCounts) {
      throw new Error("count unavailable");
    }
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

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) {
        return true;
      }
      index += 1;
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      return true;
    }
  }
  return false;
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

  it("extracts about 1,500 heading sections with a constant number of full-document line splits", () => {
    const markdown = Array.from({ length: 1_500 }, (_, index) => `# Heading ${index}\nBody ${index}.`).join("\n");
    const document = {
      id: "large-document",
      userId: "owner",
      path: "/assistant/large.md",
      basename: "large.md",
      title: "Large",
      markdown,
      contentHash: "large-hash",
      version: 1,
      indexStatus: "pending",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    };
    const originalSplit = String.prototype.split;
    let fullDocumentLineSplits = 0;
    const splitSpy = vi.spyOn(String.prototype, "split").mockImplementation(function (separator, limit) {
      if (String(this) === markdown && separator === "\n") {
        fullDocumentLineSplits += 1;
      }
      return originalSplit.call(String(this), separator, limit);
    });

    try {
      const chunks = chunkMarkdownDocument(document);
      expect(chunks).toHaveLength(1_500);
      expect(fullDocumentLineSplits).toBe(2);
    } finally {
      splitSpy.mockRestore();
    }
  });

  it("keeps emoji boundaries and pre-existing unpaired surrogates well formed in every chunk", () => {
    const document = {
      id: "unicode-document",
      userId: "owner",
      path: "/assistant/unicode.md",
      basename: "unicode.md",
      title: null,
      markdown: `${"a".repeat(1_399)}🚀tail\n\nbad\uD800source`,
      contentHash: "unicode-hash",
      version: 1,
      indexStatus: "pending",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    };

    const chunks = chunkMarkdownDocument(document);

    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.content).toBe("a".repeat(1_399));
    expect(chunks[1]?.content).toBe("🚀tail");
    expect(chunks[2]?.content).toBe("bad\uFFFDsource");
    expect(chunks.every((chunk) => !hasLoneSurrogate(chunk.content))).toBe(true);
  });

  it("compiles document delete filters without collection input", () => {
    expect(qdrantDocumentFilter("doc-1")).toEqual({
      must: [{ key: "document_id", match: { value: "doc-1" } }]
    });
  });

  it("derives collision-resistant Qdrant collection names from user ids", () => {
    expect(qdrantCollectionForUser("owner")).toMatch(/^user_owner_[a-f0-9]{24}_rag$/);
    expect(qdrantCollectionForUser("a:b")).not.toBe(qdrantCollectionForUser("a/b"));
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
    await expect(client.search("collection", [0, 1, 0, 1], {
      pathPrefix: "/projects/../secrets",
      limit: 3
    })).rejects.toThrow("relative");
  });
});

describe("RAG provider boundaries", () => {
  it("classifies deterministic and retryable HTTP failures", () => {
    expect(providerHttpError("openai", "embeddings", 400)).toMatchObject({
      code: "openai_embeddings_http_400",
      retryable: false,
      status: 400
    });
    expect(providerHttpError("openai", "embeddings", 429)).toMatchObject({ retryable: true });
    expect(providerHttpError("qdrant", "point_upsert", 503)).toMatchObject({ retryable: true });
  });

  it("classifies missing embedding credentials as deterministic", async () => {
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      AGENT_OPENAI_API_KEY: "",
      RAG_EMBEDDING_DIMENSIONS: "4"
    });
    await expect(new OpenAIEmbeddingClient(settings).embedTexts({
      model: settings.ragEmbeddingModel,
      dimensions: 4,
      texts: ["hello"]
    })).rejects.toMatchObject({
      code: "openai_embeddings_missing_api_key",
      retryable: false
    });
  });

  it("times out while an embedding response body is stalled", async () => {
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      AGENT_OPENAI_API_KEY: "test-key",
      AGENT_OPENAI_BASE_URL: "https://provider.example.test/v1",
      RAG_EMBEDDING_DIMENSIONS: "4"
    });
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({
      start() {
        // Headers arrive, but the provider never sends or closes the body.
      }
    }), { status: 200 })) as unknown as typeof fetch;

    await expect(new OpenAIEmbeddingClient(settings, fetchImpl, 10).embedTexts({
      model: settings.ragEmbeddingModel,
      dimensions: 4,
      texts: ["hello"]
    })).rejects.toMatchObject({
      code: "openai_embeddings_timeout",
      retryable: true
    });
  });

  it("rejects an oversized streamed OpenAI embedding response deterministically", async () => {
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      AGENT_OPENAI_API_KEY: "test-key",
      AGENT_OPENAI_BASE_URL: "https://provider.example.test/v1",
      RAG_EMBEDDING_DIMENSIONS: "4"
    });
    const fetchImpl = vi.fn(async () => new Response(
      "x".repeat(RAG_PROVIDER_MAX_RESPONSE_BYTES + 1),
      { status: 200 }
    )) as unknown as typeof fetch;

    await expect(new OpenAIEmbeddingClient(settings, fetchImpl).embedTexts({
      model: settings.ragEmbeddingModel,
      dimensions: 4,
      texts: ["hello"]
    })).rejects.toMatchObject({
      code: "openai_embeddings_response_too_large",
      retryable: false
    });
  });

  it("rejects an oversized declared Qdrant JSON response before parsing", async () => {
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      QDRANT_URL: "http://qdrant.example.test",
      RAG_EMBEDDING_DIMENSIONS: "4"
    });
    const fetchImpl = vi.fn(async () => new Response("{}", {
      status: 200,
      headers: {
        "content-length": String(RAG_PROVIDER_MAX_RESPONSE_BYTES + 1)
      }
    })) as unknown as typeof fetch;

    await expect(new HttpQdrantClient(settings, fetchImpl).search(
      "collection",
      [0, 0, 0, 0]
    )).rejects.toMatchObject({
      code: "qdrant_search_response_too_large",
      retryable: false
    });
  });

  it("rejects malformed Qdrant point counts as deterministic provider data errors", async () => {
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      QDRANT_URL: "http://qdrant.example.test",
      RAG_EMBEDDING_DIMENSIONS: "4"
    });
    const malformedBodies = [
      { result: {} },
      { result: { count: "1" } },
      { result: { count: -1 } },
      { result: { count: 1.5 } },
      { result: { count: Number.MAX_SAFE_INTEGER + 1 } },
      null
    ];

    for (const body of malformedBodies) {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
      await expect(new HttpQdrantClient(settings, fetchImpl).countPoints("collection")).rejects.toMatchObject({
        code: "qdrant_point_count_malformed_response",
        retryable: false
      });
    }
  });

  it("classifies every malformed embedding data shape as deterministic", async () => {
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      AGENT_OPENAI_API_KEY: "test-key",
      AGENT_OPENAI_BASE_URL: "https://provider.example.test/v1",
      RAG_EMBEDDING_DIMENSIONS: "4"
    });
    const malformedBodies = [
      { data: {} },
      { data: [null] },
      { data: [{}] },
      { data: [{ embedding: "not-a-vector" }] },
      { data: [{ embedding: [0, 0, null, 0] }] }
    ];

    for (const body of malformedBodies) {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
      await expect(new OpenAIEmbeddingClient(settings, fetchImpl).embedTexts({
        model: settings.ragEmbeddingModel,
        dimensions: 4,
        texts: ["hello"]
      })).rejects.toMatchObject({
        code: "openai_embeddings_malformed_response",
        retryable: false
      });
    }
  });

  it("repairs unpaired surrogates before serializing embedding input", async () => {
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      AGENT_OPENAI_API_KEY: "test-key",
      AGENT_OPENAI_BASE_URL: "https://provider.example.test/v1",
      RAG_EMBEDDING_DIMENSIONS: "4"
    });
    let serializedBody = "";
    const fetchImpl: typeof fetch = async (_request, init) => {
      serializedBody = String(init?.body ?? "");
      const body = JSON.parse(serializedBody) as { input: string[] };
      return new Response(JSON.stringify({
        data: body.input.map(() => ({ embedding: [0, 0, 0, 0] }))
      }), { status: 200 });
    };

    await expect(new OpenAIEmbeddingClient(settings, fetchImpl).embedTexts({
      model: settings.ragEmbeddingModel,
      dimensions: 4,
      texts: ["before\uD800after", "valid 🚀"]
    })).resolves.toHaveLength(2);

    const serializedInput = (JSON.parse(serializedBody) as { input: string[] }).input;
    expect(serializedInput).toEqual(["before\uFFFDafter", "valid 🚀"]);
    expect(serializedInput.every((text) => !hasLoneSurrogate(text))).toBe(true);
    expect(serializedBody).not.toMatch(/\\ud[89ab][0-9a-f]{2}/i);
    expect(serializedBody).not.toMatch(/\\ud[cdef][0-9a-f]{2}/i);
  });
});

describe("RAG worker", () => {
  it("uses an unrefed bounded tick watchdog that can be cleared after completion", async () => {
    vi.useFakeTimers();
    const terminate = vi.fn();
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const cleared = scheduleRagWorkerTickWatchdog({ timeoutMs: 100, terminate });
      expect(cleared.hasRef()).toBe(false);
      clearTimeout(cleared);
      await vi.advanceTimersByTimeAsync(100);
      expect(terminate).not.toHaveBeenCalled();

      const expired = scheduleRagWorkerTickWatchdog({ timeoutMs: 100, terminate });
      expect(expired.hasRef()).toBe(false);
      await vi.advanceTimersByTimeAsync(100);

      expect(terminate).toHaveBeenCalledOnce();
      expect(terminate).toHaveBeenCalledWith(1);
      expect(consoleLog).toHaveBeenCalledOnce();
      expect(JSON.parse(String(consoleLog.mock.calls[0]?.[0]))).toMatchObject({
        event: "rag_worker_tick_watchdog_expired",
        component: "rag-worker",
        stage: "tick_watchdog_expired",
        reason_code: "tick_deadline_exceeded",
        elapsed_ms: 100
      });
      expect(RAG_WORKER_TICK_WATCHDOG_MS).toBe(150_000);
    } finally {
      consoleLog.mockRestore();
      vi.useRealTimers();
    }
  });

  it("writes an atomic fresh metadata-only job heartbeat with resource snapshots", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rag-worker-health-test-"));
    const healthPath = join(directory, "health.json");
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await recordRagJobProgress({
        jobId: "job-123",
        attempt: 2,
        phase: "upsert_batch_completed",
        elapsedMs: 321,
        totalChunks: 20,
        completedChunks: 8,
        batchIndex: 1,
        batchCount: 3,
        batchSize: 8
      }, healthPath);

      const record = JSON.parse(await readFile(healthPath, "utf8")) as RagWorkerHealthRecord;
      expect(record).toMatchObject({
        state: "running",
        stage: "upsert_batch_completed",
        last_success_at: null,
        last_failure_at: null,
        job_id: "job-123",
        attempt: 2,
        elapsed_ms: 321,
        resources: {
          pid: process.pid,
          rssBytes: expect.any(Number),
          heapUsedBytes: expect.any(Number),
          userCpuMicros: expect.any(Number)
        }
      });
      expect(isRagWorkerHealthFresh(record, Date.parse(record.updated_at) + 119_999)).toBe(true);
      expect(isRagWorkerHealthFresh(record, Date.parse(record.updated_at) + 120_000)).toBe(false);
      expect(await readdir(directory)).toEqual(["health.json"]);
      const healthBeforeSkippedTicks = await readFile(healthPath, "utf8");
      await recordRagWorkerLifecycle({
        event: "rag_worker_tick_skipped",
        state: "degraded",
        stage: "tick_skipped",
        refreshHealth: false,
        healthPath
      });
      await recordRagWorkerLifecycle({
        event: "rag_worker_tick_skipped",
        state: "degraded",
        stage: "tick_skipped",
        refreshHealth: false,
        healthPath
      });
      expect(await readFile(healthPath, "utf8")).toBe(healthBeforeSkippedTicks);

      await recordRagWorkerLifecycle({
        event: "rag_worker_error",
        state: "error",
        stage: "tick_failed",
        healthPath
      });
      const failed = JSON.parse(await readFile(healthPath, "utf8")) as RagWorkerHealthRecord;
      expect(failed.last_failure_at).toEqual(expect.any(String));
      expect(isRagWorkerHealthOutcomeHealthy(failed)).toBe(false);

      await recordRagWorkerLifecycle({
        event: "rag_worker_tick_started",
        state: "running",
        stage: "tick_started",
        healthPath
      });
      const runningAfterFailure = JSON.parse(await readFile(healthPath, "utf8")) as RagWorkerHealthRecord;
      expect(runningAfterFailure.last_failure_at).toBe(failed.last_failure_at);
      expect(runningAfterFailure.last_success_at).toBeNull();
      expect(isRagWorkerHealthOutcomeHealthy(runningAfterFailure)).toBe(false);

      await recordRagWorkerLifecycle({
        event: "rag_worker_tick",
        state: "idle",
        stage: "tick_completed",
        outcome: "success",
        healthPath
      });
      const recovered = JSON.parse(await readFile(healthPath, "utf8")) as RagWorkerHealthRecord;
      expect(isRagWorkerHealthOutcomeHealthy(recovered)).toBe(true);

      const logged = consoleLog.mock.calls
        .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
        .find((entry) => entry.event === "rag_index_job_progress");
      expect(logged).toMatchObject({
        stage: "upsert_batch_completed",
        job_id: "job-123",
        process_rss_bytes: expect.any(Number),
        process_user_cpu_micros: expect.any(Number)
      });
      expect(Object.keys(logged ?? {})).not.toEqual(expect.arrayContaining([
        "user_id",
        "path",
        "title",
        "content",
        "query",
        "vector"
      ]));
    } finally {
      consoleLog.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("leaves queued jobs unclaimed while Qdrant is unhealthy", async () => {
    const processJobs = vi.fn(async () => ({
      claimed: 1,
      indexed: 1,
      deleted: 0,
      failed: 0,
      dead: 0
    }));

    await expect(processRagJobsWhenQdrantHealthy({
      qdrant: { health: async () => ({ ok: false }) },
      processJobs
    })).resolves.toEqual({
      qdrantOk: false,
      processed: { claimed: 0, indexed: 0, deleted: 0, failed: 0, dead: 0 }
    });
    expect(processJobs).not.toHaveBeenCalled();
  });

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

  it("embeds and upserts sequential conservative batches while reporting metadata-only progress", async () => {
    const { store, context } = await testContext("owner");
    await store.writeMarkdownDocument(context, {
      path: "/assistant/batched.md",
      markdown: Array.from({ length: 41 }, (_, index) => `# Item ${index}\nDetail ${index}.`).join("\n")
    });
    const qdrant = new FakeQdrantClient();
    const mockEmbeddings = new MockEmbeddingClient();
    const embeddingBatchSizes: number[] = [];
    const embeddings = {
      async embedTexts(input: Parameters<MockEmbeddingClient["embedTexts"]>[0]) {
        embeddingBatchSizes.push(input.texts.length);
        return mockEmbeddings.embedTexts(input);
      }
    };
    const progress: RagJobProgressEvent[] = [];
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      RAG_EMBEDDING_DIMENSIONS: "4"
    });

    await expect(processRagIndexJobs({
      store,
      qdrant,
      embeddings,
      settings,
      onProgress: (event) => progress.push(event)
    })).resolves.toMatchObject({ claimed: 1, indexed: 1, failed: 0, dead: 0 });

    expect(embeddingBatchSizes).toEqual([16, 16, 9]);
    expect(Math.max(...embeddingBatchSizes)).toBeLessThanOrEqual(RAG_EMBEDDING_BATCH_SIZE);
    expect(qdrant.upsertBatchSizes).toEqual([8, 8, 8, 8, 8, 1]);
    expect(Math.max(...qdrant.upsertBatchSizes)).toBeLessThanOrEqual(RAG_QDRANT_UPSERT_BATCH_SIZE);
    expect(progress.map((event) => event.phase)).toEqual(expect.arrayContaining([
      "job_started",
      "source_loaded",
      "chunks_ready",
      "embedding_batch_completed",
      "upsert_batch_completed",
      "chunks_persisted",
      "completed"
    ]));
    expect(progress.filter((event) => event.phase === "upsert_batch_completed").at(-1)).toMatchObject({
      completedChunks: 41,
      totalChunks: 41
    });
    for (const event of progress) {
      expect(Object.keys(event)).not.toEqual(expect.arrayContaining([
        "userId",
        "path",
        "title",
        "content",
        "query",
        "vector"
      ]));
    }
  });

  it("completes indexing when the best-effort exact point count fails", async () => {
    const { store, context } = await testContext("owner");
    await store.writeMarkdownDocument(context, {
      path: "/assistant/count-telemetry.md",
      markdown: "# Count telemetry\nIndexing is already durable."
    });
    const qdrant = new FakeQdrantClient();
    qdrant.failCounts = true;
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      RAG_EMBEDDING_DIMENSIONS: "4"
    });

    await expect(processRagIndexJobs({
      store,
      qdrant,
      embeddings: new MockEmbeddingClient(),
      settings
    })).resolves.toMatchObject({ claimed: 1, indexed: 1, failed: 0, dead: 0 });
    await expect(store.getMarkdownIndexStatus(context, "/assistant/count-telemetry.md")).resolves.toEqual([
      expect.objectContaining({ indexStatus: "indexed", pendingJobs: 0 })
    ]);
  });

  it("keeps a malformed provider point count best-effort after durable indexing", async () => {
    const { store, context } = await testContext("owner");
    await store.writeMarkdownDocument(context, {
      path: "/assistant/malformed-count-telemetry.md",
      markdown: "# Count telemetry\nMalformed provider data must not replay indexing."
    });
    const fetchImpl: typeof fetch = async (request, init) => {
      const url = String(request);
      if (!init?.method || init.method === "GET") {
        return new Response("{}", { status: 200 });
      }
      if (url.includes("/points/count")) {
        return new Response(JSON.stringify({ result: { count: "not-a-count" } }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    };
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      RAG_EMBEDDING_DIMENSIONS: "4"
    });

    await expect(processRagIndexJobs({
      store,
      qdrant: new HttpQdrantClient(settings, fetchImpl),
      embeddings: new MockEmbeddingClient(),
      settings
    })).resolves.toMatchObject({ claimed: 1, indexed: 1, failed: 0, dead: 0 });
    await expect(store.getMarkdownIndexStatus(context, "/assistant/malformed-count-telemetry.md")).resolves.toEqual([
      expect.objectContaining({ indexStatus: "indexed", pendingJobs: 0 })
    ]);
    await expect(store.listRagUserIndexHealth(context)).resolves.toEqual([
      expect.objectContaining({ qdrantPointCount: null, healthStatus: "ok" })
    ]);
  });

  it("keeps truncated Qdrant excerpts well formed at an emoji boundary", async () => {
    const { store, context } = await testContext("owner");
    const document = await store.writeMarkdownDocument(context, {
      path: "/newsletters/2026-08-17/unicode.md",
      markdown: `\uD800${"a".repeat(318)}🚀tail`
    });
    if ("code" in document) {
      throw new Error("unexpected conflict");
    }
    let upsertBody = "";
    const fetchImpl: typeof fetch = async (request, init) => {
      const url = String(request);
      if (!init?.method || init.method === "GET") {
        return new Response("{}", { status: 200 });
      }
      if (url.includes("/points/delete")) {
        return new Response("{}", { status: 200 });
      }
      if (url.includes("/points?wait=true")) {
        upsertBody = String(init?.body ?? "");
        const parsed = JSON.parse(upsertBody) as { points?: Array<{ payload?: { excerpt?: unknown } }> };
        const payloadExcerpt = parsed.points?.[0]?.payload?.excerpt;
        return new Response("{}", {
          status: typeof payloadExcerpt === "string" && !hasLoneSurrogate(payloadExcerpt) ? 200 : 400
        });
      }
      if (url.includes("/points/count")) {
        return new Response(JSON.stringify({ result: { count: 1 } }), { status: 200 });
      }
      throw new Error(`Unexpected Qdrant test request: ${url}`);
    };
    const settings = loadSettings({ APP_ENV: "test", AUTH_MODE: "standalone", RAG_EMBEDDING_DIMENSIONS: "4" });

    await expect(indexMarkdownDocument({
      store,
      qdrant: new HttpQdrantClient(settings, fetchImpl),
      embeddings: new MockEmbeddingClient(),
      settings,
      document
    })).resolves.toBe(1);

    const serialized = JSON.parse(upsertBody) as { points: Array<{ payload: { excerpt: string } }> };
    const payloadExcerpt = serialized.points[0]?.payload.excerpt ?? "";
    expect(hasLoneSurrogate(payloadExcerpt)).toBe(false);
    expect(payloadExcerpt.startsWith("\uFFFD")).toBe(true);
    expect(payloadExcerpt.endsWith("🚀")).toBe(true);
    expect(Array.from(payloadExcerpt)).toHaveLength(320);
    expect(upsertBody).not.toMatch(/\\u(?:d[89ab][0-9a-f]{2}|d[cdef][0-9a-f]{2})/i);
  });

  it("repairs every source-derived Qdrant payload string before serialization", async () => {
    const { store, context } = await testContext("owner");
    const heading = "Title\uD800 emoji 🚀";
    const prefix = `# ${heading}\n`;
    const markdown = `${prefix}${"a".repeat(1_399 - prefix.length)}🚀tail`;
    const document = await store.writeMarkdownDocument(context, {
      path: "/bad\uD800/file\uD800.md",
      markdown
    });
    if ("code" in document) {
      throw new Error("unexpected conflict");
    }
    let upsertBody = "";
    const fetchImpl: typeof fetch = async (request, init) => {
      const url = String(request);
      if (!init?.method || init.method === "GET") {
        return new Response("{}", { status: 200 });
      }
      if (url.includes("/points/delete")) {
        return new Response("{}", { status: 200 });
      }
      if (url.includes("/points?wait=true")) {
        upsertBody = String(init?.body ?? "");
        return new Response("{}", { status: 200 });
      }
      if (url.includes("/points/count")) {
        return new Response(JSON.stringify({ result: { count: 2 } }), { status: 200 });
      }
      throw new Error(`Unexpected Qdrant test request: ${url}`);
    };
    const settings = loadSettings({ APP_ENV: "test", AUTH_MODE: "standalone", RAG_EMBEDDING_DIMENSIONS: "4" });

    await expect(indexMarkdownDocument({
      store,
      qdrant: new HttpQdrantClient(settings, fetchImpl),
      embeddings: new MockEmbeddingClient(),
      settings,
      document
    })).resolves.toBe(2);

    const serialized = JSON.parse(upsertBody) as {
      points: Array<{ payload: Record<string, unknown> }>;
    };
    expect(serialized.points).toHaveLength(2);
    expect(serialized.points[0]?.payload).toMatchObject({
      path: "/bad\uFFFD/file\uFFFD.md",
      path_prefixes: ["/", "/bad\uFFFD", "/bad\uFFFD/file\uFFFD.md"],
      dir: "/bad\uFFFD",
      top_level: "bad\uFFFD",
      filename: "file\uFFFD.md",
      title: "Title\uFFFD emoji 🚀",
      heading_path: ["Title\uFFFD emoji 🚀"],
      excerpt: expect.stringContaining("Title\uFFFD emoji 🚀")
    });
    const payloadStrings: string[] = [];
    const collectStrings = (value: unknown): void => {
      if (typeof value === "string") {
        payloadStrings.push(value);
      } else if (Array.isArray(value)) {
        value.forEach(collectStrings);
      } else if (value && typeof value === "object") {
        Object.values(value).forEach(collectStrings);
      }
    };
    serialized.points.forEach((point) => collectStrings(point.payload));
    expect(payloadStrings.every((value) => !hasLoneSurrogate(value))).toBe(true);
    expect(upsertBody).not.toMatch(/\\u(?:d[89ab][0-9a-f]{2}|d[cdef][0-9a-f]{2})/i);
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

  it("does not let stale indexing results mark a newer document indexed", async () => {
    const { store, context } = await testContext("owner");
    const first = await store.writeMarkdownDocument(context, {
      path: "/personal/profile.md",
      markdown: "# Profile\nOld version."
    });
    if ("code" in first) {
      throw new Error("unexpected conflict");
    }
    const second = await store.writeMarkdownDocument(context, {
      path: "/personal/profile.md",
      markdown: "# Profile\nCurrent version.",
      expectedVersion: first.version
    });
    if ("code" in second) {
      throw new Error("unexpected conflict");
    }
    const qdrant = new FakeQdrantClient();
    const settings = loadSettings({ APP_ENV: "test", AUTH_MODE: "standalone", RAG_EMBEDDING_DIMENSIONS: "4" });

    await indexMarkdownDocument({
      store,
      qdrant,
      embeddings: new MockEmbeddingClient(),
      settings,
      document: first
    });

    await expect(store.getMarkdownIndexStatus(context, "/personal")).resolves.toEqual([
      expect.objectContaining({ path: "/personal/profile.md", version: 2, indexStatus: "pending" })
    ]);
    await expect(store.listChunksForDocument(context, first.id)).resolves.toEqual([]);

    await expect(processRagIndexJobs({
      store,
      qdrant,
      embeddings: new MockEmbeddingClient(),
      settings
    })).resolves.toMatchObject({ claimed: 2, indexed: 1, failed: 0 });
    await expect(store.listChunksForDocument(context, second.id)).resolves.toEqual([
      expect.objectContaining({ documentVersion: 2, content: expect.stringContaining("Current version.") })
    ]);
    await expect(store.getMarkdownIndexStatus(context, "/personal")).resolves.toEqual([
      expect.objectContaining({ path: "/personal/profile.md", version: 2, indexStatus: "indexed" })
    ]);
  });

  it("dead-letters hard source-limit violations before any provider operation", async () => {
    const { store, context } = await testContext("owner");
    const sources = [
      {
        path: "/assistant/too-many-characters.md",
        markdown: "x".repeat(MAX_RAG_SOURCE_CHARS + 1)
      },
      {
        path: "/assistant/too-many-sections.md",
        markdown: Array.from(
          { length: MAX_RAG_SOURCE_SECTIONS + 1 },
          (_, index) => `# Section ${index}`
        ).join("\n")
      },
      {
        path: "/assistant/too-many-chunks.md",
        markdown: Array.from(
          { length: MAX_RAG_SOURCE_CHUNKS + 1 },
          (_, index) => `# Chunk ${index}`
        ).join("\n")
      }
    ];
    for (const source of sources) {
      await store.writeMarkdownDocument(context, source);
    }
    const qdrant = new FakeQdrantClient();
    const embedTexts = vi.fn(async () => [] as number[][]);
    const progress: RagJobProgressEvent[] = [];
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      RAG_EMBEDDING_DIMENSIONS: "4",
      RAG_INDEX_BATCH_SIZE: "10"
    });

    await expect(processRagIndexJobs({
      store,
      qdrant,
      embeddings: { embedTexts },
      settings,
      onProgress: (event) => progress.push(event)
    })).resolves.toMatchObject({ claimed: 3, indexed: 0, failed: 0, dead: 3 });

    expect(qdrant.ensureCalls).toBe(0);
    expect(qdrant.deleteCalls).toBe(0);
    expect(qdrant.upsertBatchSizes).toEqual([]);
    expect(embedTexts).not.toHaveBeenCalled();
    expect(progress.filter((event) => event.phase === "dead_lettered").map((event) => event.errorCode)).toEqual([
      "rag_source_too_large",
      "rag_source_too_many_sections",
      "rag_source_too_many_chunks"
    ]);
  });

  it("dead-letters a deterministic provider 400 on its first attempt", async () => {
    const { store, context } = await testContext("owner");
    await store.writeMarkdownDocument(context, {
      path: "/assistant/deterministic-provider-error.md",
      markdown: "# Provider\nReject this request."
    });
    const qdrant = new FakeQdrantClient();
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 400 })) as unknown as typeof fetch;
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      AGENT_OPENAI_API_KEY: "test-key",
      AGENT_OPENAI_BASE_URL: "https://provider.example.test/v1",
      RAG_EMBEDDING_DIMENSIONS: "4"
    });

    await expect(processRagIndexJobs({
      store,
      qdrant,
      embeddings: new OpenAIEmbeddingClient(settings, fetchImpl),
      settings
    })).resolves.toMatchObject({ claimed: 1, indexed: 0, failed: 0, dead: 1 });
    await expect(processRagIndexJobs({
      store,
      qdrant,
      embeddings: new OpenAIEmbeddingClient(settings, fetchImpl),
      settings,
      now: new Date(Date.now() + 100_000)
    })).resolves.toMatchObject({ claimed: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("dead-letters malformed embedding data on its first attempt", async () => {
    const { store, context } = await testContext("owner");
    await store.writeMarkdownDocument(context, {
      path: "/assistant/malformed-embedding-response.md",
      markdown: "# Provider\nReject malformed embedding data."
    });
    const qdrant = new FakeQdrantClient();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [null] }), {
      status: 200
    })) as unknown as typeof fetch;
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      AGENT_OPENAI_API_KEY: "test-key",
      AGENT_OPENAI_BASE_URL: "https://provider.example.test/v1",
      RAG_EMBEDDING_DIMENSIONS: "4"
    });

    await expect(processRagIndexJobs({
      store,
      qdrant,
      embeddings: new OpenAIEmbeddingClient(settings, fetchImpl),
      settings
    })).resolves.toMatchObject({ claimed: 1, indexed: 0, failed: 0, dead: 1 });
    await expect(store.listRagIndexJobs(context, false, ["dead"])).resolves.toEqual([
      expect.objectContaining({ attempts: 1, status: "dead" })
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(qdrant.upsertBatchSizes).toEqual([]);
  });

  it("retries an overall job deadline before starting provider work", async () => {
    const { store, context } = await testContext("owner");
    await store.writeMarkdownDocument(context, {
      path: "/assistant/deadline.md",
      markdown: "# Deadline\nStop between phases."
    });
    const qdrant = new FakeQdrantClient();
    const embedTexts = vi.fn(async () => [] as number[][]);
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      RAG_EMBEDDING_DIMENSIONS: "4"
    });
    let clockCalls = 0;
    const clock = () => clockCalls++ < 2 ? 0 : 100_000;

    await expect(processRagIndexJobs({
      store,
      qdrant,
      embeddings: { embedTexts },
      settings,
      clock
    })).resolves.toMatchObject({ claimed: 1, indexed: 0, failed: 1, dead: 0 });
    expect(qdrant.ensureCalls).toBe(0);
    expect(embedTexts).not.toHaveBeenCalled();
  });

  it("checks the overall deadline after an embedding batch before upsert", async () => {
    const { store, context } = await testContext("owner");
    const document = await store.writeMarkdownDocument(context, {
      path: "/assistant/batch-deadline.md",
      markdown: "# Deadline\nStop before the upsert."
    });
    if ("code" in document) {
      throw new Error("unexpected conflict");
    }
    const qdrant = new FakeQdrantClient();
    const embedTexts = vi.fn(async () => [[0, 0, 0, 0]]);
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      RAG_EMBEDDING_DIMENSIONS: "4"
    });
    let clockCalls = 0;
    const clock = () => ++clockCalls <= 6 ? 0 : 100;

    await expect(indexMarkdownDocument({
      store,
      qdrant,
      embeddings: { embedTexts },
      settings,
      document,
      startedAtMs: 0,
      deadlineAtMs: 50,
      clock
    })).rejects.toMatchObject({
      code: "rag_job_deadline_exceeded",
      retryable: true
    });
    expect(embedTexts).toHaveBeenCalledTimes(1);
    expect(qdrant.upsertBatchSizes).toEqual([]);
  });

  it("dead-letters crash-reclaimed jobs beyond the attempt limit before source or provider work", async () => {
    const { store, context } = await testContext("owner");
    await store.writeMarkdownDocument(context, {
      path: "/assistant/crash-loop.md",
      markdown: "# Crash loop\nDo not run this forever."
    });
    const base = Date.now();
    await store.claimRagIndexJobs(1, new Date(base + 6 * 60_000));
    await store.claimRagIndexJobs(1, new Date(base + 12 * 60_000));
    await store.claimRagIndexJobs(1, new Date(base + 18 * 60_000));
    const getDocument = vi.spyOn(store, "getMarkdownDocumentById");
    const qdrant = new FakeQdrantClient();
    const embedTexts = vi.fn(async () => [] as number[][]);
    const progress: RagJobProgressEvent[] = [];
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      RAG_EMBEDDING_DIMENSIONS: "4"
    });

    await expect(processRagIndexJobs({
      store,
      qdrant,
      embeddings: { embedTexts },
      settings,
      now: new Date(base + 24 * 60_000),
      onProgress: (event) => progress.push(event)
    })).resolves.toMatchObject({ claimed: 1, indexed: 0, failed: 0, dead: 1 });

    expect(getDocument).not.toHaveBeenCalled();
    expect(qdrant.ensureCalls).toBe(0);
    expect(embedTexts).not.toHaveBeenCalled();
    expect(progress).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: "attempt_limit_exceeded", attempt: 4 }),
      expect.objectContaining({ phase: "dead_lettered", errorCode: "rag_job_attempt_limit_exceeded" })
    ]));
  });

  it("processes an exhausted dead job from attempt one after a manual retry", async () => {
    const { store, context } = await testContext("owner");
    await store.writeMarkdownDocument(context, {
      path: "/assistant/manual-retry.md",
      markdown: "# Manual retry\nRun the provider again after an operator retry."
    });
    const qdrant = new FakeQdrantClient();
    qdrant.failUpserts = true;
    const mockEmbeddings = new MockEmbeddingClient();
    const embedTexts = vi.spyOn(mockEmbeddings, "embedTexts");
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      RAG_EMBEDDING_DIMENSIONS: "4"
    });
    const base = Date.now();

    await expect(processRagIndexJobs({
      store,
      qdrant,
      embeddings: mockEmbeddings,
      settings,
      now: new Date(base)
    })).resolves.toMatchObject({ claimed: 1, failed: 1, dead: 0 });
    await expect(processRagIndexJobs({
      store,
      qdrant,
      embeddings: mockEmbeddings,
      settings,
      now: new Date(base + 100_000)
    })).resolves.toMatchObject({ claimed: 1, failed: 1, dead: 0 });
    await expect(processRagIndexJobs({
      store,
      qdrant,
      embeddings: mockEmbeddings,
      settings,
      now: new Date(base + 200_000)
    })).resolves.toMatchObject({ claimed: 1, failed: 0, dead: 1 });

    const [deadJob] = await store.listRagIndexJobs(context, false, ["dead"]);
    expect(deadJob).toMatchObject({ status: "dead", attempts: 3 });
    await expect(store.retryRagIndexJob(context, deadJob!.id)).resolves.toMatchObject({
      id: deadJob!.id,
      status: "pending",
      attempts: 0
    });

    embedTexts.mockClear();
    qdrant.failUpserts = false;
    const progress: RagJobProgressEvent[] = [];
    await expect(processRagIndexJobs({
      store,
      qdrant,
      embeddings: mockEmbeddings,
      settings,
      now: new Date(base + 300_000),
      onProgress: (event) => progress.push(event)
    })).resolves.toMatchObject({ claimed: 1, indexed: 1, failed: 0, dead: 0 });

    expect(embedTexts).toHaveBeenCalledTimes(1);
    expect(progress).toContainEqual(expect.objectContaining({
      jobId: deadJob!.id,
      phase: "job_started",
      attempt: 1
    }));
    await expect(store.listRagIndexJobs(context, false, ["completed"])).resolves.toEqual([
      expect.objectContaining({ id: deadJob!.id, status: "completed", attempts: 1 })
    ]);
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
    const forbiddenSelector = await app.request("/mcp/v1/tools/search_semantic", {
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
    expect(forbiddenSelector.status).toBe(400);
    await expect(forbiddenSelector.json()).resolves.toMatchObject({
      error: { code: "mcp_validation_failed" }
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
        limit: 10
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
