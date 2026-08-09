import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { OpenAIModelClient, type AgentModelClient } from "./agent/modelClient.js";
import type { AuthenticatedUser, Session } from "./auth/session.js";
import { loadSettings, type Settings } from "./config/settings.js";
import { createPool } from "./db/pool.js";
import { createPostgresStore } from "./domain/store.js";
import type { AgentStore, RequestContext } from "./domain/types.js";
import { SignedIntegrationTokenProvider } from "./integrations/tokenProvider.js";
import { daemonOnce as runSchedulerOnce } from "./scheduler/taskQueue.js";
import type { MailTransport } from "./connectors/smtpSender.js";
import { imapErrorDetails, processImapInbox } from "./connectors/imapPoller.js";
import { SlidingWindowRateLimiter } from "./security/senderPolicy.js";
import { runtimeSafetyPolicy } from "./security/safetyPolicy.js";

const WORKER_INTERVAL_MS = 20_000;
const INBOUND_BATCH_LIMIT = 10;
const INBOUND_TIMEOUT_MS = 15_000;
const MAX_WORKER_LOG_STRING_LENGTH = 500;
const MAX_WORKER_LOG_ARRAY_ITEMS = 20;
const MAX_WORKER_LOG_DEPTH = 4;
const SENSITIVE_WORKER_LOG_KEY_PATTERN = /(?:password|passwd|pwd|secret|token|api[_\s-]?key|access[_\s-]?key|private[_\s-]?key|credential|authorization|bearer|cookie|session)/i;
let inboundRateLimiter: SlidingWindowRateLimiter | undefined;
let inboundRateLimiterLimit = 0;

function reviewNotificationRateLimiter(settings: Settings): SlidingWindowRateLimiter {
  const limit = runtimeSafetyPolicy(settings).maxUntrustedReviewNotificationsPerSenderPerDay;
  if (!inboundRateLimiter || inboundRateLimiterLimit !== limit) {
    inboundRateLimiter = new SlidingWindowRateLimiter(limit, 24 * 60 * 60 * 1000);
    inboundRateLimiterLimit = limit;
  }
  return inboundRateLimiter;
}

class ImapIdleTimeout extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImapIdleTimeout";
  }
}

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
  fetchImpl?: typeof fetch;
}): Promise<{
  users: number;
  claimedTasks: number;
  ranTasks: number;
  approvalExecutionAttempted: number;
  approvalExecutionSucceeded: number;
  approvalExecutionFailed: number;
  outboundAttempted: number;
  outboundSent: number;
  outboundFailed: number;
  recoveredTasks: number;
  expiredApprovals: number;
  recoveredOutbound: number;
  recoveredApprovalExecutions: number;
  inboundAttempted: number;
  inboundRecorded: number;
  inboundFailed: number;
}> {
  const users = await options.store.listUsersWithWork(["pending", "approved"], options.now);
  const totals = {
    users: users.length,
    claimedTasks: 0,
    ranTasks: 0,
    approvalExecutionAttempted: 0,
    approvalExecutionSucceeded: 0,
    approvalExecutionFailed: 0,
    outboundAttempted: 0,
    outboundSent: 0,
    outboundFailed: 0,
    recoveredTasks: 0,
    expiredApprovals: 0,
    recoveredOutbound: 0,
    recoveredApprovalExecutions: 0,
    inboundAttempted: 0,
    inboundRecorded: 0,
    inboundFailed: 0
  };
  const safety = runtimeSafetyPolicy(options.settings);
  const integrationTokenProvider = new SignedIntegrationTokenProvider(options.settings);
  let remainingOutbound = safety.outboundMessagesPerWorkerTick;
  for (const user of users) {
    const context = workerContext(user);
    const result = await runSchedulerOnce({
      store: options.store,
      context,
      settings: options.settings,
      modelClient: options.modelClient,
      mailTransport: options.mailTransport,
      outboundLimit: remainingOutbound,
      now: options.now,
      fetchImpl: options.fetchImpl
    });
    remainingOutbound = Math.max(0, remainingOutbound - result.outboundAttempted);
    totals.claimedTasks += result.claimedTasks;
    totals.ranTasks += result.ranTasks;
    totals.approvalExecutionAttempted += result.approvalExecutionAttempted;
    totals.approvalExecutionSucceeded += result.approvalExecutionSucceeded;
    totals.approvalExecutionFailed += result.approvalExecutionFailed;
    totals.outboundAttempted += result.outboundAttempted;
    totals.outboundSent += result.outboundSent;
    totals.outboundFailed += result.outboundFailed;
    totals.recoveredTasks += result.recoveredTasks;
    totals.expiredApprovals += result.expiredApprovals;
    totals.recoveredOutbound += result.recoveredOutbound;
    totals.recoveredApprovalExecutions += result.recoveredApprovalExecutions;

    try {
      const inbound = await withTimeout((options.imapProcessor ?? processImapInbox)({
        store: options.store,
        context,
        settings: options.settings,
        rateLimiter: reviewNotificationRateLimiter(options.settings),
        modelClient: options.modelClient,
        integrationTokenProvider,
        limit: INBOUND_BATCH_LIMIT
      }), INBOUND_TIMEOUT_MS, "IMAP processing timed out.");
      totals.inboundAttempted += inbound.attempted;
      totals.inboundRecorded += inbound.recorded;
      totals.inboundFailed += inbound.failed;
    } catch (error) {
      if (error instanceof ImapIdleTimeout) {
        continue;
      } else {
        totals.inboundFailed += 1;
        const details = sanitizeWorkerDetails(imapErrorDetails(error));
        await options.store.recordAudit(context, "worker.imap_error", "connector", "imap", details);
        logWorker("worker_imap_error", {
          user_id: user.id,
          ...details
        });
      }
    }
  }
  return totals;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new ImapIdleTimeout(message)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}

function compactWorkerLogText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/https?:\/\/[^\s"'<>),]+/gi, "[url]")
    .replace(
      /\b(password|passwd|pwd|secret|token|api[_\s-]?key|access[_\s-]?key|private[_\s-]?key|credential|authorization|bearer|cookie|session)\b(\s*(?:=|:|is|was)\s*)([^\s,;]+)/gi,
      "$1$2[redacted]"
    )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_WORKER_LOG_STRING_LENGTH);
}

function sanitizeWorkerValue(value: unknown, depth = 0): unknown {
  if (depth >= MAX_WORKER_LOG_DEPTH) {
    return "[redacted]";
  }
  if (typeof value === "string") {
    return compactWorkerLogText(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_WORKER_LOG_ARRAY_ITEMS)
      .map((item) => sanitizeWorkerValue(item, depth + 1));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      SENSITIVE_WORKER_LOG_KEY_PATTERN.test(key) ? "[redacted]" : sanitizeWorkerValue(nested, depth + 1)
    ]));
  }
  return null;
}

function sanitizeWorkerDetails(details: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitizeWorkerValue(details);
  return typeof sanitized === "object" && sanitized !== null && !Array.isArray(sanitized)
    ? sanitized as Record<string, unknown>
    : {};
}

function logWorker(event: string, details: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({
    event,
    app: "ai-assistant",
    timestamp: new Date().toISOString(),
    ...sanitizeWorkerDetails(details)
  }));
}

export function startWorker(): ReturnType<typeof setInterval> {
  const settings = loadSettings();
  const pool = createPool(settings);
  const store = createPostgresStore(pool, settings);
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
        outbound_batch_limit: runtimeSafetyPolicy(settings).outboundMessagesPerWorkerTick,
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
