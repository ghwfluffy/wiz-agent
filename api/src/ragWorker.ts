import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadSettings } from "./config/settings.js";
import { BACKGROUND_POSTGRES_POOL_OPTIONS, createPool } from "./db/pool.js";
import { createPostgresStore } from "./domain/store.js";
import { OpenAIEmbeddingClient } from "./rag/embeddings.js";
import {
  processRagIndexJobs,
  type RagJobProgressEvent
} from "./rag/indexer.js";
import { HttpQdrantClient, type QdrantClient } from "./rag/qdrant.js";

const RAG_WORKER_INTERVAL_MS = 30_000;
const MAX_RAG_WORKER_LOG_STRING_LENGTH = 500;
const SENSITIVE_RAG_WORKER_LOG_KEY_PATTERN = /(?:password|passwd|pwd|secret|token|api[_\s-]?key|access[_\s-]?key|private[_\s-]?key|credential|authorization|bearer|cookie|session)/i;
export const RAG_WORKER_HEALTH_PATH = "/tmp/rag-worker-health.json";
export const RAG_WORKER_HEALTH_STALE_MS = 120_000;
export const RAG_WORKER_TICK_WATCHDOG_MS = 150_000;

export type RagWorkerResourceSnapshot = {
  pid: number;
  uptimeMs: number;
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  userCpuMicros: number;
  systemCpuMicros: number;
  maxRssKb: number;
  involuntaryContextSwitches: number;
  cgroupMemoryCurrentBytes?: number;
  cgroupMemoryLimitBytes?: number | null;
  cgroupOomEvents?: number;
  cgroupOomKillEvents?: number;
  cgroupCpuUsageMicros?: number;
  cgroupCpuThrottledMicros?: number;
  cgroupCpuThrottledPeriods?: number;
};

export type RagWorkerHealthRecord = {
  state: "starting" | "running" | "idle" | "degraded" | "error";
  stage: string;
  updated_at: string;
  last_success_at: string | null;
  last_failure_at: string | null;
  job_id?: string;
  attempt?: number;
  elapsed_ms?: number;
  total_chunks?: number;
  completed_chunks?: number;
  batch_index?: number;
  batch_count?: number;
  batch_size?: number;
  retryable?: boolean;
  error_code?: string;
  resources: RagWorkerResourceSnapshot;
};

let ragWorkerHealthWriteSequence = 0;

type RagJobProcessingCounts = {
  claimed: number;
  indexed: number;
  deleted: number;
  failed: number;
  dead: number;
};

async function readCgroupFile(path: string): Promise<string | undefined> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    return undefined;
  }
}

function numericCgroupValue(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function cgroupStatValue(stats: string | undefined, key: string): number | undefined {
  const line = stats?.split("\n").find((entry) => entry.startsWith(`${key} `));
  return numericCgroupValue(line?.slice(key.length + 1).trim());
}

export async function captureRagWorkerResourceSnapshot(): Promise<RagWorkerResourceSnapshot> {
  const [memoryCurrent, memoryLimit, memoryEvents, cpuStat] = await Promise.all([
    readCgroupFile("/sys/fs/cgroup/memory.current"),
    readCgroupFile("/sys/fs/cgroup/memory.max"),
    readCgroupFile("/sys/fs/cgroup/memory.events"),
    readCgroupFile("/sys/fs/cgroup/cpu.stat")
  ]);
  const memory = process.memoryUsage();
  const usage = process.resourceUsage();
  return {
    pid: process.pid,
    uptimeMs: Math.round(process.uptime() * 1000),
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
    userCpuMicros: usage.userCPUTime,
    systemCpuMicros: usage.systemCPUTime,
    maxRssKb: usage.maxRSS,
    involuntaryContextSwitches: usage.involuntaryContextSwitches,
    cgroupMemoryCurrentBytes: numericCgroupValue(memoryCurrent),
    cgroupMemoryLimitBytes: memoryLimit === "max" ? null : numericCgroupValue(memoryLimit),
    cgroupOomEvents: cgroupStatValue(memoryEvents, "oom"),
    cgroupOomKillEvents: cgroupStatValue(memoryEvents, "oom_kill"),
    cgroupCpuUsageMicros: cgroupStatValue(cpuStat, "usage_usec"),
    cgroupCpuThrottledMicros: cgroupStatValue(cpuStat, "throttled_usec"),
    cgroupCpuThrottledPeriods: cgroupStatValue(cpuStat, "nr_throttled")
  };
}

export async function writeRagWorkerHealth(
  input: Omit<RagWorkerHealthRecord, "updated_at" | "last_success_at" | "last_failure_at"> & {
    updated_at?: string;
    last_success_at?: string | null;
    last_failure_at?: string | null;
  },
  path = RAG_WORKER_HEALTH_PATH
): Promise<RagWorkerHealthRecord> {
  let priorSuccessAt: string | null = null;
  let priorFailureAt: string | null = null;
  try {
    const prior = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    priorSuccessAt = typeof prior.last_success_at === "string" ? prior.last_success_at : null;
    priorFailureAt = typeof prior.last_failure_at === "string" ? prior.last_failure_at : null;
  } catch {
    // A missing or malformed health file has no trustworthy prior outcome.
  }
  const record: RagWorkerHealthRecord = {
    state: input.state,
    stage: input.stage,
    updated_at: input.updated_at ?? new Date().toISOString(),
    last_success_at: input.last_success_at === undefined ? priorSuccessAt : input.last_success_at,
    last_failure_at: input.last_failure_at === undefined ? priorFailureAt : input.last_failure_at,
    ...(input.job_id === undefined ? {} : { job_id: input.job_id }),
    ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
    ...(input.elapsed_ms === undefined ? {} : { elapsed_ms: input.elapsed_ms }),
    ...(input.total_chunks === undefined ? {} : { total_chunks: input.total_chunks }),
    ...(input.completed_chunks === undefined ? {} : { completed_chunks: input.completed_chunks }),
    ...(input.batch_index === undefined ? {} : { batch_index: input.batch_index }),
    ...(input.batch_count === undefined ? {} : { batch_count: input.batch_count }),
    ...(input.batch_size === undefined ? {} : { batch_size: input.batch_size }),
    ...(input.retryable === undefined ? {} : { retryable: input.retryable }),
    ...(input.error_code === undefined ? {} : { error_code: input.error_code }),
    resources: input.resources
  };
  ragWorkerHealthWriteSequence += 1;
  const temporaryPath = `${path}.${process.pid}.${ragWorkerHealthWriteSequence}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  return record;
}

export function isRagWorkerHealthFresh(
  record: Pick<RagWorkerHealthRecord, "updated_at">,
  nowMs = Date.now(),
  staleAfterMs = RAG_WORKER_HEALTH_STALE_MS
): boolean {
  const updatedAtMs = Date.parse(record.updated_at);
  const ageMs = nowMs - updatedAtMs;
  return Number.isFinite(updatedAtMs) && ageMs >= 0 && ageMs < staleAfterMs;
}

export function isRagWorkerHealthOutcomeHealthy(
  record: Pick<RagWorkerHealthRecord, "state" | "last_success_at" | "last_failure_at">
): boolean {
  if (record.state !== "starting" && record.state !== "running" && record.state !== "idle") {
    return false;
  }
  if (record.last_failure_at === null) {
    return true;
  }
  const failureAtMs = Date.parse(record.last_failure_at);
  const successAtMs = record.last_success_at === null
    ? Number.NaN
    : Date.parse(record.last_success_at);
  return Number.isFinite(failureAtMs)
    && Number.isFinite(successAtMs)
    && successAtMs >= failureAtMs;
}

export async function processRagJobsWhenQdrantHealthy(options: {
  qdrant: Pick<QdrantClient, "health">;
  processJobs: () => Promise<RagJobProcessingCounts>;
}): Promise<{ qdrantOk: boolean; processed: RagJobProcessingCounts }> {
  const health = await options.qdrant.health();
  if (!health.ok) {
    return {
      qdrantOk: false,
      processed: { claimed: 0, indexed: 0, deleted: 0, failed: 0, dead: 0 }
    };
  }
  return {
    qdrantOk: true,
    processed: await options.processJobs()
  };
}

function compactRagWorkerLogText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/https?:\/\/[^\s"'<>),]+/gi, "[url]")
    .replace(
      /\b(password|passwd|pwd|secret|token|api[_\s-]?key|access[_\s-]?key|private[_\s-]?key|credential|authorization|bearer|cookie|session)\b(\s*(?:=|:|is|was)\s*)([^\s,;]+)/gi,
      "$1$2[redacted]"
    )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_RAG_WORKER_LOG_STRING_LENGTH);
}

function sanitizeRagWorkerDetails(details: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(details).map(([key, value]) => {
    if (SENSITIVE_RAG_WORKER_LOG_KEY_PATTERN.test(key)) {
      return [key, "[redacted]"];
    }
    if (typeof value === "string") {
      return [key, compactRagWorkerLogText(value)];
    }
    return [key, value];
  }));
}

function logRagWorker(event: string, details: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({
    event,
    app: "ai-assistant",
    component: "rag-worker",
    timestamp: new Date().toISOString(),
    ...sanitizeRagWorkerDetails(details)
  }));
}

export function scheduleRagWorkerTickWatchdog(options: {
  timeoutMs?: number;
  terminate?: (exitCode: number) => void;
} = {}): ReturnType<typeof setTimeout> {
  const requestedTimeoutMs = options.timeoutMs ?? RAG_WORKER_TICK_WATCHDOG_MS;
  const timeoutMs = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
    ? Math.floor(requestedTimeoutMs)
    : RAG_WORKER_TICK_WATCHDOG_MS;
  const watchdog = setTimeout(() => {
    logRagWorker("rag_worker_tick_watchdog_expired", {
      stage: "tick_watchdog_expired",
      reason_code: "tick_deadline_exceeded",
      elapsed_ms: timeoutMs
    });
    (options.terminate ?? ((exitCode: number) => process.exit(exitCode)))(1);
  }, timeoutMs);
  watchdog.unref();
  return watchdog;
}

function ragWorkerResourceLogDetails(resources: RagWorkerResourceSnapshot): Record<string, unknown> {
  return {
    process_pid: resources.pid,
    process_uptime_ms: resources.uptimeMs,
    process_rss_bytes: resources.rssBytes,
    process_heap_used_bytes: resources.heapUsedBytes,
    process_heap_total_bytes: resources.heapTotalBytes,
    process_external_bytes: resources.externalBytes,
    process_array_buffers_bytes: resources.arrayBuffersBytes,
    process_user_cpu_micros: resources.userCpuMicros,
    process_system_cpu_micros: resources.systemCpuMicros,
    process_max_rss_kb: resources.maxRssKb,
    process_involuntary_context_switches: resources.involuntaryContextSwitches,
    cgroup_memory_current_bytes: resources.cgroupMemoryCurrentBytes,
    cgroup_memory_limit_bytes: resources.cgroupMemoryLimitBytes,
    cgroup_oom_events: resources.cgroupOomEvents,
    cgroup_oom_kill_events: resources.cgroupOomKillEvents,
    cgroup_cpu_usage_micros: resources.cgroupCpuUsageMicros,
    cgroup_cpu_throttled_micros: resources.cgroupCpuThrottledMicros,
    cgroup_cpu_throttled_periods: resources.cgroupCpuThrottledPeriods
  };
}

function ragJobProgressDetails(event: RagJobProgressEvent): Omit<
  RagWorkerHealthRecord,
  "state" | "stage" | "updated_at" | "last_success_at" | "last_failure_at" | "resources"
> {
  return {
    job_id: event.jobId,
    attempt: event.attempt,
    elapsed_ms: event.elapsedMs,
    ...(event.totalChunks === undefined ? {} : { total_chunks: event.totalChunks }),
    ...(event.completedChunks === undefined ? {} : { completed_chunks: event.completedChunks }),
    ...(event.batchIndex === undefined ? {} : { batch_index: event.batchIndex }),
    ...(event.batchCount === undefined ? {} : { batch_count: event.batchCount }),
    ...(event.batchSize === undefined ? {} : { batch_size: event.batchSize }),
    ...(event.retryable === undefined ? {} : { retryable: event.retryable }),
    ...(event.errorCode === undefined ? {} : { error_code: event.errorCode })
  };
}

export async function recordRagJobProgress(
  event: RagJobProgressEvent,
  healthPath = RAG_WORKER_HEALTH_PATH
): Promise<void> {
  const resources = await captureRagWorkerResourceSnapshot();
  const details = ragJobProgressDetails(event);
  logRagWorker("rag_index_job_progress", {
    stage: event.phase,
    ...details,
    ...ragWorkerResourceLogDetails(resources)
  });
  try {
    await writeRagWorkerHealth({
      state: "running",
      stage: event.phase,
      ...details,
      resources
    }, healthPath);
  } catch {
    logRagWorker("rag_worker_health_write_error", { stage: "job_progress" });
  }
}

export async function recordRagWorkerLifecycle(input: {
  event: string;
  state: RagWorkerHealthRecord["state"];
  stage: string;
  details?: Record<string, unknown>;
  healthPath?: string;
  refreshHealth?: boolean;
  outcome?: "success" | "failure" | "preserve";
}): Promise<void> {
  const resources = await captureRagWorkerResourceSnapshot();
  logRagWorker(input.event, {
    stage: input.stage,
    ...input.details,
    ...ragWorkerResourceLogDetails(resources)
  });
  if (input.refreshHealth === false) {
    return;
  }
  const outcome = input.outcome
    ?? (input.state === "degraded" || input.state === "error" ? "failure" : "preserve");
  const outcomeAt = new Date().toISOString();
  try {
    await writeRagWorkerHealth({
      state: input.state,
      stage: input.stage,
      updated_at: outcomeAt,
      ...(outcome === "success" ? { last_success_at: outcomeAt } : {}),
      ...(outcome === "failure" ? { last_failure_at: outcomeAt } : {}),
      resources
    }, input.healthPath);
  } catch {
    logRagWorker("rag_worker_health_write_error", { stage: input.stage });
  }
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
  const pool = createPool(settings, BACKGROUND_POSTGRES_POOL_OPTIONS);
  try {
    const store = createPostgresStore(pool, settings);
    const qdrant = new HttpQdrantClient(settings);
    const embeddings = new OpenAIEmbeddingClient(settings);
    const gated = await processRagJobsWhenQdrantHealthy({
      qdrant,
      processJobs: () => processRagIndexJobs({
        store,
        qdrant,
        embeddings,
        settings,
        onProgress: recordRagJobProgress
      })
    });
    const pending = await pool.query(
      "SELECT count(*)::int AS count FROM rag_index_jobs WHERE status = 'pending' AND available_at <= now()"
    );
    return {
      qdrantOk: gated.qdrantOk,
      pendingJobs: Number(pending.rows[0]?.count ?? 0),
      ...gated.processed
    };
  } finally {
    await pool.end();
  }
}

export function startRagWorker(): ReturnType<typeof setInterval> {
  let tickInFlight = false;
  async function tick(): Promise<void> {
    if (tickInFlight) {
      await recordRagWorkerLifecycle({
        event: "rag_worker_tick_skipped",
        state: "degraded",
        stage: "tick_skipped",
        details: { reason_code: "previous_tick_still_running" },
        refreshHealth: false
      });
      return;
    }
    tickInFlight = true;
    const watchdog = scheduleRagWorkerTickWatchdog();
    try {
      await recordRagWorkerLifecycle({
        event: "rag_worker_tick_started",
        state: "running",
        stage: "tick_started"
      });
      const result = await ragWorkerTick();
      await recordRagWorkerLifecycle({
        event: "rag_worker_tick",
        state: result.qdrantOk ? "idle" : "degraded",
        stage: "tick_completed",
        details: result,
        outcome: result.qdrantOk ? "success" : "failure"
      });
    } catch (error) {
      await recordRagWorkerLifecycle({
        event: "rag_worker_error",
        state: "error",
        stage: "tick_failed",
        details: {
          message: error instanceof Error ? error.message : String(error)
        }
      });
    } finally {
      clearTimeout(watchdog);
      tickInFlight = false;
    }
  }
  void (async () => {
    await recordRagWorkerLifecycle({
      event: "rag_worker_started",
      state: "starting",
      stage: "startup"
    });
    await tick();
  })();
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
