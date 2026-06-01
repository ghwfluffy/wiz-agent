import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { OpenAIModelClient, type AgentModelClient } from "./agent/modelClient.js";
import type { AuthenticatedUser, Session } from "./auth/session.js";
import { loadSettings, type Settings } from "./config/settings.js";
import { createPool } from "./db/pool.js";
import { createPostgresStore } from "./domain/store.js";
import type { AgentStore, RequestContext } from "./domain/types.js";
import { daemonOnce as runSchedulerOnce } from "./scheduler/taskQueue.js";
import type { MailTransport } from "./connectors/smtpSender.js";
import { imapErrorDetails, processImapInbox } from "./connectors/imapPoller.js";
import { SlidingWindowRateLimiter } from "./security/senderPolicy.js";

const WORKER_INTERVAL_MS = 20_000;
const OUTBOUND_BATCH_LIMIT = 1;
const INBOUND_BATCH_LIMIT = 10;
const INBOUND_TIMEOUT_MS = 15_000;
const inboundRateLimiter = new SlidingWindowRateLimiter(10, 60 * 60 * 1000);

function workerSession(user: AuthenticatedUser): Session {
  const now = new Date();
  return {
    id: `worker:${randomUUID()}`,
    user,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString()
  };
}

export function workerContext(user: AuthenticatedUser): RequestContext {
  return {
    userId: user.id,
    actorType: "system",
    permissions: ["user", "system"],
    requestId: `worker-${randomUUID()}`,
    session: workerSession(user)
  };
}

export async function workerTick(options: {
  store: AgentStore;
  settings: Settings;
  modelClient?: AgentModelClient;
  mailTransport?: MailTransport;
  imapProcessor?: typeof processImapInbox;
  now?: Date;
}): Promise<{
  users: number;
  claimedTasks: number;
  ranTasks: number;
  outboundAttempted: number;
  outboundSent: number;
  outboundFailed: number;
  inboundAttempted: number;
  inboundRecorded: number;
  inboundFailed: number;
}> {
  const users = await options.store.listUsersWithWork(["pending", "approved"], options.now);
  const totals = {
    users: users.length,
    claimedTasks: 0,
    ranTasks: 0,
    outboundAttempted: 0,
    outboundSent: 0,
    outboundFailed: 0,
    inboundAttempted: 0,
    inboundRecorded: 0,
    inboundFailed: 0
  };
  let remainingOutbound = OUTBOUND_BATCH_LIMIT;
  for (const user of users) {
    const context = workerContext(user);
    const result = await runSchedulerOnce({
      store: options.store,
      context,
      settings: options.settings,
      modelClient: options.modelClient,
      mailTransport: options.mailTransport,
      outboundLimit: remainingOutbound,
      now: options.now
    });
    remainingOutbound = Math.max(0, remainingOutbound - result.outboundAttempted);
    totals.claimedTasks += result.claimedTasks;
    totals.ranTasks += result.ranTasks;
    totals.outboundAttempted += result.outboundAttempted;
    totals.outboundSent += result.outboundSent;
    totals.outboundFailed += result.outboundFailed;

    try {
      const inbound = await withTimeout((options.imapProcessor ?? processImapInbox)({
        store: options.store,
        context,
        settings: options.settings,
        rateLimiter: inboundRateLimiter,
        modelClient: options.modelClient,
        limit: INBOUND_BATCH_LIMIT
      }), INBOUND_TIMEOUT_MS, "IMAP processing timed out.");
      totals.inboundAttempted += inbound.attempted;
      totals.inboundRecorded += inbound.recorded;
      totals.inboundFailed += inbound.failed;
    } catch (error) {
      totals.inboundFailed += 1;
      const details = imapErrorDetails(error);
      await options.store.recordAudit(context, "worker.imap_error", "connector", "imap", details);
      logWorker("worker_imap_error", {
        user_id: user.id,
        ...details
      });
    }
  }
  return totals;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}

function logWorker(event: string, details: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({
    event,
    app: "ai-assistant",
    timestamp: new Date().toISOString(),
    ...details
  }));
}

export function startWorker(): ReturnType<typeof setInterval> {
  const settings = loadSettings();
  const pool = createPool(settings);
  const store = createPostgresStore(pool);
  const modelClient = settings.agentOpenaiApiKey
    ? OpenAIModelClient.fromSettings(settings)
    : undefined;

  async function tick(): Promise<void> {
    try {
      const result = await workerTick({
        store,
        settings,
        modelClient
      });
      logWorker("worker_tick", {
        auth_mode: settings.authMode,
        interval_ms: WORKER_INTERVAL_MS,
        outbound_batch_limit: OUTBOUND_BATCH_LIMIT,
        inbound_batch_limit: INBOUND_BATCH_LIMIT,
        ...result
      });
    } catch (error) {
      logWorker("worker_error", {
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  void tick();
  return setInterval(() => {
    void tick();
  }, WORKER_INTERVAL_MS);
}

export function isWorkerEntrypoint(metaUrl: string, argvPath: string | undefined): boolean {
  if (!argvPath) {
    return false;
  }
  return metaUrl === pathToFileURL(resolve(argvPath)).href;
}

if (isWorkerEntrypoint(import.meta.url, process.argv[1])) {
  startWorker();
}
