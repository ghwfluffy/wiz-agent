import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadSettings } from "./config/settings.js";
import { createPool } from "./db/pool.js";
import { createPostgresStore } from "./domain/store.js";
import { OpenAIEmbeddingClient } from "./rag/embeddings.js";
import { processRagIndexJobs } from "./rag/indexer.js";
import { HttpQdrantClient } from "./rag/qdrant.js";

const RAG_WORKER_INTERVAL_MS = 30_000;

function logRagWorker(event: string, details: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({
    event,
    app: "ai-assistant",
    component: "rag-worker",
    timestamp: new Date().toISOString(),
    ...details
  }));
}

export async function ragWorkerTick(): Promise<{
  qdrantOk: boolean;
  pendingJobs: number;
  claimed: number;
  indexed: number;
  deleted: number;
  failed: number;
  dead: number;
}> {
  const settings = loadSettings();
  const pool = createPool(settings);
  try {
    const store = createPostgresStore(pool);
    const qdrant = new HttpQdrantClient(settings);
    const embeddings = new OpenAIEmbeddingClient(settings);
    const [health, processed, pending] = await Promise.all([
      qdrant.health(),
      processRagIndexJobs({ store, qdrant, embeddings, settings }),
      pool.query("SELECT count(*)::int AS count FROM rag_index_jobs WHERE status = 'pending' AND available_at <= now()")
    ]);
    return {
      qdrantOk: health.ok,
      pendingJobs: Number(pending.rows[0]?.count ?? 0),
      ...processed
    };
  } finally {
    await pool.end();
  }
}

export function startRagWorker(): ReturnType<typeof setInterval> {
  async function tick(): Promise<void> {
    try {
      logRagWorker("rag_worker_tick", await ragWorkerTick());
    } catch (error) {
      logRagWorker("rag_worker_error", {
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  void tick();
  return setInterval(() => {
    void tick();
  }, RAG_WORKER_INTERVAL_MS);
}

export function isRagWorkerEntrypoint(metaUrl: string, argvPath: string | undefined): boolean {
  return Boolean(argvPath && metaUrl === pathToFileURL(resolve(argvPath)).href);
}

if (isRagWorkerEntrypoint(import.meta.url, process.argv[1])) {
  startRagWorker();
}
