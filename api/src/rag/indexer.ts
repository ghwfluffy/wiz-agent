import type { Settings } from "../config/settings.js";
import type { AgentStore, MarkdownDocumentRecord, RagDocumentChunkInput, RequestContext } from "../domain/types.js";
import { chunkMarkdownDocument, chunkMarkdownDocumentWithStats } from "./chunking.js";
import type { EmbeddingClient } from "./embeddings.js";
import {
  isRetryableRagError,
  RagOperationError,
  type QdrantClient,
  type QdrantPoint
} from "./qdrant.js";

export const MAX_RAG_JOB_ATTEMPTS = 3;
export const RAG_EMBEDDING_BATCH_SIZE = 16;
export const RAG_QDRANT_UPSERT_BATCH_SIZE = 8;
export const RAG_JOB_DEADLINE_MS = 90_000;
export const MAX_RAG_SOURCE_CHARS = 250_000;
export const MAX_RAG_SOURCE_SECTIONS = 400;
export const MAX_RAG_SOURCE_CHUNKS = 256;

export type RagJobProgressPhase =
  | "job_started"
  | "attempt_limit_exceeded"
  | "collection_ready"
  | "source_loaded"
  | "stale_source_skipped"
  | "chunks_ready"
  | "old_points_deleted"
  | "embedding_batch_completed"
  | "upsert_batch_completed"
  | "chunks_persisted"
  | "index_health_updated"
  | "delete_completed"
  | "completed"
  | "retry_scheduled"
  | "dead_lettered";

export type RagJobProgressEvent = {
  jobId: string;
  attempt: number;
  phase: RagJobProgressPhase;
  elapsedMs: number;
  totalChunks?: number;
  completedChunks?: number;
  batchIndex?: number;
  batchCount?: number;
  batchSize?: number;
  retryable?: boolean;
  errorCode?: string;
};

export type RagJobProgressHandler = (event: RagJobProgressEvent) => void | Promise<void>;

type JobProgressContext = {
  jobId: string;
  attempt: number;
  startedAtMs: number;
  deadlineAtMs: number;
  clock: () => number;
  onProgress?: RagJobProgressHandler;
};

async function emitJobProgress(
  progress: JobProgressContext,
  phase: RagJobProgressPhase,
  details: Omit<Partial<RagJobProgressEvent>, "jobId" | "attempt" | "phase" | "elapsedMs"> = {}
): Promise<void> {
  if (!progress.onProgress) {
    return;
  }
  try {
    await progress.onProgress({
      jobId: progress.jobId,
      attempt: progress.attempt,
      phase,
      elapsedMs: Math.max(0, Math.round(progress.clock() - progress.startedAtMs)),
      ...details
    });
  } catch {
    // Observability must never change whether a source-of-truth job succeeds.
  }
}

function assertWithinJobDeadline(progress: JobProgressContext): void {
  if (progress.clock() >= progress.deadlineAtMs) {
    throw new RagOperationError({
      message: "RAG index job exceeded its processing deadline.",
      code: "rag_job_deadline_exceeded",
      retryable: true
    });
  }
}

function errorCode(error: unknown): string {
  return error instanceof RagOperationError ? error.code : "unclassified_error";
}

function systemContext(userId: string): RequestContext {
  return {
    userId,
    actorType: "system",
    permissions: ["system", "rag"],
    requestId: `rag:${Date.now()}`,
    session: {
      id: "rag-worker",
      user: {
        id: userId,
        email: "",
        displayName: "RAG Worker",
        timezone: "UTC",
        isAdmin: false
      },
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    }
  };
}

function retryAt(attempts: number): Date {
  const delayMs = Math.min(60_000, 1000 * 2 ** Math.max(0, attempts - 1));
  return new Date(Date.now() + delayMs);
}

function wellFormedText(value: string): string {
  return value.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "\uFFFD"
  );
}

function excerpt(text: string): string {
  const normalized = wellFormedText(text.replace(/\s+/g, " ").trim());
  return Array.from(normalized).slice(0, 320).join("");
}

function wellFormedNullableText(value: string | null): string | null {
  return value === null ? null : wellFormedText(value);
}

function wellFormedTextArray(values: string[]): string[] {
  return values.map(wellFormedText);
}

function qdrantPayload(
  document: MarkdownDocumentRecord,
  chunk: ReturnType<typeof chunkMarkdownDocument>[number],
  settings: Settings,
  indexedAt: string
): Record<string, unknown> {
  return {
    user_id: wellFormedText(document.userId),
    document_id: wellFormedText(document.id),
    document_version: document.version,
    path: wellFormedText(chunk.path),
    path_prefixes: wellFormedTextArray(chunk.pathPrefixes),
    dir: wellFormedText(chunk.dir),
    top_level: wellFormedText(chunk.topLevel),
    filename: wellFormedText(chunk.filename),
    title: wellFormedNullableText(chunk.title),
    section_id: wellFormedNullableText(chunk.sectionId),
    heading_path: wellFormedTextArray(chunk.headingPath),
    chunk_index: chunk.chunkIndex,
    content_hash: wellFormedText(chunk.contentHash),
    embedding_model: wellFormedText(settings.ragEmbeddingModel),
    indexed_at: wellFormedText(indexedAt),
    excerpt: excerpt(chunk.content)
  };
}

export async function indexMarkdownDocument(input: {
  store: AgentStore;
  qdrant: QdrantClient;
  embeddings: EmbeddingClient;
  settings: Settings;
  document: MarkdownDocumentRecord;
  jobId?: string;
  attempt?: number;
  startedAtMs?: number;
  deadlineAtMs?: number;
  clock?: () => number;
  onProgress?: RagJobProgressHandler;
}): Promise<number> {
  const { store, qdrant, embeddings, settings, document } = input;
  const clock = input.clock ?? Date.now;
  const startedAtMs = input.startedAtMs ?? clock();
  const progress: JobProgressContext = {
    jobId: input.jobId ?? "direct-index",
    attempt: input.attempt ?? 1,
    startedAtMs,
    deadlineAtMs: input.deadlineAtMs ?? startedAtMs + RAG_JOB_DEADLINE_MS,
    clock,
    onProgress: input.onProgress
  };
  const context = systemContext(document.userId);
  assertWithinJobDeadline(progress);
  if (document.markdown.length > MAX_RAG_SOURCE_CHARS) {
    throw new RagOperationError({
      message: `RAG source exceeded the ${MAX_RAG_SOURCE_CHARS}-character indexing limit.`,
      code: "rag_source_too_large",
      retryable: false
    });
  }
  const { chunks, sectionCount } = chunkMarkdownDocumentWithStats(document, {
    maxSections: MAX_RAG_SOURCE_SECTIONS,
    maxChunks: MAX_RAG_SOURCE_CHUNKS
  });
  assertWithinJobDeadline(progress);
  if (sectionCount > MAX_RAG_SOURCE_SECTIONS) {
    throw new RagOperationError({
      message: `RAG source exceeded the ${MAX_RAG_SOURCE_SECTIONS}-section indexing limit.`,
      code: "rag_source_too_many_sections",
      retryable: false
    });
  }
  if (chunks.length > MAX_RAG_SOURCE_CHUNKS) {
    throw new RagOperationError({
      message: `RAG source exceeded the ${MAX_RAG_SOURCE_CHUNKS}-chunk indexing limit.`,
      code: "rag_source_too_many_chunks",
      retryable: false
    });
  }
  await emitJobProgress(progress, "chunks_ready", { totalChunks: chunks.length });

  const collection = await store.ensureUserRagIndex(context);
  assertWithinJobDeadline(progress);
  await qdrant.ensureCollection(collection, settings.ragEmbeddingDimensions);
  assertWithinJobDeadline(progress);
  await emitJobProgress(progress, "collection_ready");

  await qdrant.deletePointsByDocumentId(collection, document.id);
  assertWithinJobDeadline(progress);
  await emitJobProgress(progress, "old_points_deleted", { totalChunks: chunks.length });

  if (chunks.length === 0) {
    await store.replaceDocumentChunks(context, document.id, [], {
      version: document.version,
      contentHash: document.contentHash
    });
    assertWithinJobDeadline(progress);
    await emitJobProgress(progress, "chunks_persisted", { totalChunks: 0, completedChunks: 0 });
    await store.updateRagIndexHealth(document.userId, {
      collectionExists: true,
      healthStatus: "ok",
      embeddingModel: settings.ragEmbeddingModel,
      embeddingDimensions: settings.ragEmbeddingDimensions
    });
    assertWithinJobDeadline(progress);
    await emitJobProgress(progress, "index_health_updated", { totalChunks: 0, completedChunks: 0 });
    return 0;
  }

  const indexedAt = new Date().toISOString();
  const embeddingBatchCount = Math.ceil(chunks.length / RAG_EMBEDDING_BATCH_SIZE);
  let completedChunks = 0;
  let upsertBatchIndex = 0;
  const upsertBatchCount = Math.ceil(chunks.length / RAG_QDRANT_UPSERT_BATCH_SIZE);
  for (let offset = 0; offset < chunks.length; offset += RAG_EMBEDDING_BATCH_SIZE) {
    assertWithinJobDeadline(progress);
    const embeddingBatch = chunks.slice(offset, offset + RAG_EMBEDDING_BATCH_SIZE);
    const vectors = await embeddings.embedTexts({
      model: settings.ragEmbeddingModel,
      dimensions: settings.ragEmbeddingDimensions,
      texts: embeddingBatch.map((chunk) => chunk.content)
    });
    if (
      vectors.length !== embeddingBatch.length
      || vectors.some((vector) => (
        vector.length !== settings.ragEmbeddingDimensions
        || vector.some((value) => !Number.isFinite(value))
      ))
    ) {
      throw new RagOperationError({
        message: "Embedding provider returned an invalid vector batch.",
        code: "embedding_batch_invalid",
        retryable: false
      });
    }
    assertWithinJobDeadline(progress);
    await emitJobProgress(progress, "embedding_batch_completed", {
      totalChunks: chunks.length,
      completedChunks: offset + embeddingBatch.length,
      batchIndex: Math.floor(offset / RAG_EMBEDDING_BATCH_SIZE) + 1,
      batchCount: embeddingBatchCount,
      batchSize: embeddingBatch.length
    });

    for (let batchOffset = 0; batchOffset < embeddingBatch.length; batchOffset += RAG_QDRANT_UPSERT_BATCH_SIZE) {
      assertWithinJobDeadline(progress);
      const qdrantChunks = embeddingBatch.slice(batchOffset, batchOffset + RAG_QDRANT_UPSERT_BATCH_SIZE);
      const qdrantVectors = vectors.slice(batchOffset, batchOffset + RAG_QDRANT_UPSERT_BATCH_SIZE);
      const points: QdrantPoint[] = qdrantChunks.map((chunk, index) => ({
        id: chunk.pointId,
        vector: qdrantVectors[index] ?? [],
        payload: qdrantPayload(document, chunk, settings, indexedAt)
      }));
      await qdrant.upsertPoints(collection, points);
      completedChunks += qdrantChunks.length;
      upsertBatchIndex += 1;
      assertWithinJobDeadline(progress);
      await emitJobProgress(progress, "upsert_batch_completed", {
        totalChunks: chunks.length,
        completedChunks,
        batchIndex: upsertBatchIndex,
        batchCount: upsertBatchCount,
        batchSize: qdrantChunks.length
      });
    }
  }

  const storedChunks: RagDocumentChunkInput[] = chunks.map((chunk) => ({
    id: chunk.pointId,
    documentVersion: document.version,
    sectionId: chunk.sectionId,
    headingPath: chunk.headingPath,
    chunkIndex: chunk.chunkIndex,
    content: chunk.content,
    contentHash: chunk.contentHash,
    qdrantPointId: chunk.pointId,
    qdrantCollection: collection,
    embeddingModel: settings.ragEmbeddingModel,
    embeddingDimensions: settings.ragEmbeddingDimensions,
    indexedAt
  }));
  await store.replaceDocumentChunks(context, document.id, storedChunks, {
    version: document.version,
    contentHash: document.contentHash
  });
  assertWithinJobDeadline(progress);
  await emitJobProgress(progress, "chunks_persisted", {
    totalChunks: chunks.length,
    completedChunks: chunks.length
  });

  assertWithinJobDeadline(progress);
  // Exact collection count is telemetry, not indexing correctness. Never replay a
  // completed document solely because this best-effort read failed.
  const pointCount = await qdrant.countPoints(collection).catch(() => null);
  await store.updateRagIndexHealth(document.userId, {
    collectionExists: true,
    qdrantPointCount: pointCount,
    healthStatus: "ok",
    lastError: null,
    embeddingModel: settings.ragEmbeddingModel,
    embeddingDimensions: settings.ragEmbeddingDimensions
  });
  await emitJobProgress(progress, "index_health_updated", {
    totalChunks: chunks.length,
    completedChunks: chunks.length
  });
  return chunks.length;
}

export async function processRagIndexJobs(input: {
  store: AgentStore;
  qdrant: QdrantClient;
  embeddings: EmbeddingClient;
  settings: Settings;
  now?: Date;
  clock?: () => number;
  onProgress?: RagJobProgressHandler;
}): Promise<{ claimed: number; indexed: number; deleted: number; failed: number; dead: number }> {
  const { store, qdrant, embeddings, settings } = input;
  const jobs = await store.claimRagIndexJobs(settings.ragIndexBatchSize, input.now ?? new Date());
  const counts = { claimed: jobs.length, indexed: 0, deleted: 0, failed: 0, dead: 0 };
  for (const job of jobs) {
    const clock = input.clock ?? Date.now;
    const startedAtMs = clock();
    const progress: JobProgressContext = {
      jobId: job.id,
      attempt: job.attempts,
      startedAtMs,
      deadlineAtMs: startedAtMs + RAG_JOB_DEADLINE_MS,
      clock,
      onProgress: input.onProgress
    };
    await emitJobProgress(progress, "job_started");

    if (job.attempts > MAX_RAG_JOB_ATTEMPTS) {
      const message = `RAG index job exceeded ${MAX_RAG_JOB_ATTEMPTS} processing attempts.`;
      await emitJobProgress(progress, "attempt_limit_exceeded", {
        retryable: false,
        errorCode: "rag_job_attempt_limit_exceeded"
      });
      await store.markRagIndexJobDead(job.id, message);
      counts.dead += 1;
      await emitJobProgress(progress, "dead_lettered", {
        retryable: false,
        errorCode: "rag_job_attempt_limit_exceeded"
      });
      continue;
    }

    try {
      assertWithinJobDeadline(progress);
      const context = systemContext(job.userId);
      if (job.jobType === "delete_markdown") {
        const collection = await store.ensureUserRagIndex(context);
        assertWithinJobDeadline(progress);
        await qdrant.ensureCollection(collection, settings.ragEmbeddingDimensions);
        assertWithinJobDeadline(progress);
        await emitJobProgress(progress, "collection_ready");
        await qdrant.deletePointsByDocumentId(collection, job.documentId);
        assertWithinJobDeadline(progress);
        await store.replaceDocumentChunks(context, job.documentId, []);
        assertWithinJobDeadline(progress);
        await store.completeRagIndexJob(job.id);
        counts.deleted += 1;
        await emitJobProgress(progress, "delete_completed");
        await emitJobProgress(progress, "completed");
        continue;
      }
      const source = await store.getMarkdownDocumentById(context, job.documentId, job.requestedVersion ?? undefined);
      assertWithinJobDeadline(progress);
      await emitJobProgress(progress, "source_loaded");
      if (!source || source.contentHash !== job.requestedContentHash || source.version !== job.requestedVersion) {
        await store.completeRagIndexJob(job.id);
        await emitJobProgress(progress, "stale_source_skipped");
        await emitJobProgress(progress, "completed");
        continue;
      }
      await indexMarkdownDocument({
        store,
        qdrant,
        embeddings,
        settings,
        document: source,
        jobId: job.id,
        attempt: job.attempts,
        startedAtMs,
        deadlineAtMs: progress.deadlineAtMs,
        clock,
        onProgress: input.onProgress
      });
      await store.completeRagIndexJob(job.id);
      counts.indexed += 1;
      await emitJobProgress(progress, "completed");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = isRetryableRagError(error);
      const code = errorCode(error);
      if (!retryable || job.attempts >= MAX_RAG_JOB_ATTEMPTS) {
        await store.markRagIndexJobDead(job.id, message);
        counts.dead += 1;
        await emitJobProgress(progress, "dead_lettered", {
          retryable,
          errorCode: code
        });
      } else {
        await store.failRagIndexJob(job.id, message, retryAt(job.attempts));
        counts.failed += 1;
        await emitJobProgress(progress, "retry_scheduled", {
          retryable: true,
          errorCode: code
        });
      }
      await store.updateRagIndexHealth(job.userId, {
        healthStatus: "error",
        lastError: message
      }).catch(() => undefined);
    }
  }
  return counts;
}
