import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadSettings } from "./config/settings.js";
import { createPool } from "./db/pool.js";
import { qdrantHealth } from "./rag/qdrant.js";

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
}> {
  const settings = loadSettings();
  const pool = createPool(settings);
  try {
    const [health, pending] = await Promise.all([
      qdrantHealth(settings),
      pool.query("SELECT count(*)::int AS count FROM rag_index_jobs WHERE status = 'pending' AND available_at <= now()")
    ]);
    return {
      qdrantOk: health.ok,
      pendingJobs: Number(pending.rows[0]?.count ?? 0)
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
