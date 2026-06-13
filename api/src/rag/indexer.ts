import type { Settings } from "../config/settings.js";
import type { AgentStore, MarkdownDocumentRecord, RagDocumentChunkInput, RequestContext } from "../domain/types.js";
import { chunkMarkdownDocument } from "./chunking.js";
import type { EmbeddingClient } from "./embeddings.js";
import type { QdrantClient, QdrantPoint } from "./qdrant.js";

const MAX_JOB_ATTEMPTS = 3;

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

function excerpt(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 320);
}

function qdrantPayload(
  document: MarkdownDocumentRecord,
  chunk: ReturnType<typeof chunkMarkdownDocument>[number],
  settings: Settings,
  indexedAt: string
): Record<string, unknown> {
  return {
    user_id: document.userId,
    document_id: document.id,
    document_version: document.version,
    path: chunk.path,
    path_prefixes: chunk.pathPrefixes,
    dir: chunk.dir,
    top_level: chunk.topLevel,
    filename: chunk.filename,
    title: chunk.title,
    section_id: chunk.sectionId,
    heading_path: chunk.headingPath,
    chunk_index: chunk.chunkIndex,
    content_hash: chunk.contentHash,
    embedding_model: settings.ragEmbeddingModel,
    indexed_at: indexedAt,
    excerpt: excerpt(chunk.content)
  };
}

export async function indexMarkdownDocument(input: {
  store: AgentStore;
  qdrant: QdrantClient;
  embeddings: EmbeddingClient;
  settings: Settings;
  document: MarkdownDocumentRecord;
}): Promise<number> {
  const { store, qdrant, embeddings, settings, document } = input;
  const context = systemContext(document.userId);
  const collection = await store.ensureUserRagIndex(context);
  await qdrant.ensureCollection(collection, settings.ragEmbeddingDimensions);
  const chunks = chunkMarkdownDocument(document);
  await qdrant.deletePointsByDocumentId(collection, document.id);
  if (chunks.length === 0) {
    await store.replaceDocumentChunks(context, document.id, [], {
      version: document.version,
      contentHash: document.contentHash
    });
    await store.updateRagIndexHealth(document.userId, {
      collectionExists: true,
      healthStatus: "ok",
      embeddingModel: settings.ragEmbeddingModel,
      embeddingDimensions: settings.ragEmbeddingDimensions
    });
    return 0;
  }
  const vectors = await embeddings.embedTexts({
    model: settings.ragEmbeddingModel,
    dimensions: settings.ragEmbeddingDimensions,
    texts: chunks.map((chunk) => chunk.content)
  });
  const indexedAt = new Date().toISOString();
  const points: QdrantPoint[] = chunks.map((chunk, index) => ({
    id: chunk.pointId,
    vector: vectors[index] ?? [],
    payload: qdrantPayload(document, chunk, settings, indexedAt)
  }));
  await qdrant.upsertPoints(collection, points);
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
  const pointCount = await qdrant.countPoints(collection).catch(() => null);
  await store.updateRagIndexHealth(document.userId, {
    collectionExists: true,
    qdrantPointCount: pointCount,
    healthStatus: "ok",
    lastError: null,
    embeddingModel: settings.ragEmbeddingModel,
    embeddingDimensions: settings.ragEmbeddingDimensions
  });
  return chunks.length;
}

export async function processRagIndexJobs(input: {
  store: AgentStore;
  qdrant: QdrantClient;
  embeddings: EmbeddingClient;
  settings: Settings;
  now?: Date;
}): Promise<{ claimed: number; indexed: number; deleted: number; failed: number; dead: number }> {
  const { store, qdrant, embeddings, settings } = input;
  const jobs = await store.claimRagIndexJobs(settings.ragIndexBatchSize, input.now ?? new Date());
  const counts = { claimed: jobs.length, indexed: 0, deleted: 0, failed: 0, dead: 0 };
  for (const job of jobs) {
    try {
      const context = systemContext(job.userId);
      const collection = await store.ensureUserRagIndex(context);
      await qdrant.ensureCollection(collection, settings.ragEmbeddingDimensions);
      if (job.jobType === "delete_markdown") {
        await qdrant.deletePointsByDocumentId(collection, job.documentId);
        await store.replaceDocumentChunks(context, job.documentId, []);
        await store.completeRagIndexJob(job.id);
        counts.deleted += 1;
        continue;
      }
      const source = await store.getMarkdownDocumentById(context, job.documentId, job.requestedVersion ?? undefined);
      if (!source || source.contentHash !== job.requestedContentHash || source.version !== job.requestedVersion) {
        await store.completeRagIndexJob(job.id);
        continue;
      }
      await indexMarkdownDocument({ store, qdrant, embeddings, settings, document: source });
      await store.completeRagIndexJob(job.id);
      counts.indexed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (job.attempts >= MAX_JOB_ATTEMPTS) {
        await store.markRagIndexJobDead(job.id, message);
        counts.dead += 1;
      } else {
        await store.failRagIndexJob(job.id, message, retryAt(job.attempts));
        counts.failed += 1;
      }
      await store.updateRagIndexHealth(job.userId, {
        healthStatus: "error",
        lastError: message
      }).catch(() => undefined);
    }
  }
  return counts;
}
