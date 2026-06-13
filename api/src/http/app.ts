import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { OpenAIModelClient, type AgentModelClient } from "../agent/modelClient.js";
import { runOwnerWebPromptAgent } from "../agent/inboundMessageAgent.js";
import { loadSettings, type Settings } from "../config/settings.js";
import { clearSessionCookie, writeSessionCookie } from "../auth/session.js";
import { testImapConnection } from "../connectors/imapPoller.js";
import { createPool } from "../db/pool.js";
import { createMemoryStore, createPostgresStore } from "../domain/store.js";
import type {
  AgentStore,
  ConnectorKind,
  ConnectorStatus,
  MarkdownConflict,
  RequestContext,
  SenderStatus
} from "../domain/types.js";
import { decideApproval, editApproval } from "../security/approvalPolicy.js";
import { queueOwnerReviewNotification } from "../security/senderPolicy.js";
import { runtimeSafetyPolicy } from "../security/safetyPolicy.js";

export type AppOptions = {
  settings?: Settings;
  store?: AgentStore;
  fetchImpl?: typeof fetch;
  modelClient?: AgentModelClient;
};

function errorPayload(code: string, message: string, requestId: string, fieldErrors: unknown[] = []) {
  return {
    error: {
      code,
      message,
      field_errors: fieldErrors,
      request_id: requestId
    }
  };
}

function createDefaultStore(settings: Settings): AgentStore {
  if (settings.appEnv === "test") {
    return createMemoryStore();
  }
  return createPostgresStore(createPool(settings));
}

const allowedConnectorKinds = new Set<ConnectorKind>(["owner-contact", "imap", "smtp", "openai"]);
const allowedConnectorStatuses = new Set<ConnectorStatus>(["enabled", "disabled"]);
const webMcpSessionTools = [
  "list_dir",
  "tree",
  "stat_path",
  "read_file",
  "read_section",
  "search_headings",
  "grep",
  "search_exact",
  "search_semantic",
  "find_backlinks",
  "get_index_status",
  "list_memory_items",
  "search_memory_lists"
];

function stringValue(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function numberValue(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function booleanValue(input: Record<string, unknown>, key: string): boolean | undefined {
  const value = input[key];
  return typeof value === "boolean" ? value : undefined;
}

function sanitizeConnectorConfig(
  kind: ConnectorKind,
  input: Record<string, unknown>,
  existing: Record<string, unknown> = {}
): Record<string, unknown> {
  if (kind === "owner-contact") {
    return {
      name: stringValue(input, "name") ?? null,
      email: stringValue(input, "email") ?? null,
      mobile: stringValue(input, "mobile") ?? null,
      provider: stringValue(input, "provider") ?? null,
      sms_gateway: stringValue(input, "smsGateway") ?? stringValue(input, "sms_gateway") ?? null,
      mms_gateway: stringValue(input, "mmsGateway") ?? stringValue(input, "mms_gateway") ?? null
    };
  }
  if (kind === "imap") {
    const existingImap = typeof existing.imap === "object" && existing.imap !== null ? existing.imap as Record<string, unknown> : {};
    const password = stringValue(input, "password") ?? stringValue(existingImap, "password");
    return {
      username: stringValue(input, "username") ?? null,
      imap: {
        host: stringValue(input, "host") ?? null,
        port: numberValue(input, "port") ?? null,
        secure: booleanValue(input, "secure") ?? null,
        mailbox: stringValue(input, "mailbox") ?? "INBOX",
        password: password ?? null,
        last_received_at: stringValue(existingImap, "last_received_at") ?? null,
        last_uid: numberValue(existingImap, "last_uid") ?? null
      }
    };
  }
  if (kind === "smtp") {
    const existingSmtp = typeof existing.smtp === "object" && existing.smtp !== null ? existing.smtp as Record<string, unknown> : {};
    const password = stringValue(input, "password") ?? stringValue(existingSmtp, "password");
    return {
      username: stringValue(input, "username") ?? null,
      smtp: {
        host: stringValue(input, "host") ?? null,
        port: numberValue(input, "port") ?? null,
        secure: booleanValue(input, "secure") ?? null,
        from: stringValue(input, "from") ?? null,
        password: password ?? null
      }
    };
  }
  return {
    base_url: stringValue(input, "baseUrl") ?? stringValue(input, "base_url") ?? null
  };
}

function connectorResponse(connector: {
  id: string;
  userId: string;
  kind: ConnectorKind;
  status: ConnectorStatus;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}) {
  const config = structuredClone(connector.config);
  if (connector.kind === "imap") {
    const imap = typeof config.imap === "object" && config.imap !== null ? config.imap as Record<string, unknown> : {};
    const passwordSet = typeof imap.password === "string" && imap.password.trim() !== "";
    delete imap.password;
    imap.password_set = passwordSet;
    config.imap = imap;
  }
  if (connector.kind === "smtp") {
    const smtp = typeof config.smtp === "object" && config.smtp !== null ? config.smtp as Record<string, unknown> : {};
    const passwordSet = typeof smtp.password === "string" && smtp.password.trim() !== "";
    delete smtp.password;
    smtp.password_set = passwordSet;
    config.smtp = smtp;
  }
  return { ...connector, config };
}

function isMarkdownConflict(value: unknown): value is MarkdownConflict {
  return typeof value === "object" && value !== null && (value as { code?: unknown }).code === "conflict";
}

function decodePathParam(value: string): string {
  return decodeURIComponent(value);
}

function linkValue(result: Record<string, unknown> | undefined, key: string): string | null {
  const value = result?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function countByStatus<T extends { status: string }>(records: T[], status: string): number {
  return records.filter((record) => record.status === status).length;
}

export function buildApp(options: AppOptions = {}): Hono {
  const settings = options.settings ?? loadSettings();
  const store = options.store ?? createDefaultStore(settings);
  const fetcher = options.fetchImpl ?? fetch;
  const modelClient = options.modelClient ?? OpenAIModelClient.fromSettings(settings, { fetchImpl: fetcher });
  const app = new Hono();

  function appRedirect(path: string, error?: string): string {
    const safePath = path.startsWith("/") ? path : "/";
    const base = `${settings.appBasePath || ""}${safePath === "/" ? "/" : safePath}`;
    if (!error) {
      return base;
    }
    const separator = base.includes("?") ? "&" : "?";
    return `${base}${separator}oauth_error=${encodeURIComponent(error)}`;
  }

  function oauthRedirectUri(): string {
    return `${settings.publicUrl.replace(/\/$/, "")}${settings.appBasePath}/api/v1/auth/oauth/callback`;
  }

  function tokenUrlSafe(bytes = 32): string {
    return randomBytes(bytes).toString("base64url");
  }

  function pkceChallenge(verifier: string): string {
    return createHash("sha256").update(verifier, "ascii").digest("base64url");
  }

  function authAuthorizeUrl(params: Record<string, string>): string {
    const base = settings.authBaseUrl || "/";
    const separator = base.includes("?") ? "&" : "?";
    return `${base}/oauth/authorize${separator}${new URLSearchParams(params).toString()}`.replace("//oauth", "/oauth");
  }

  async function requireContext(context: import("hono").Context): Promise<RequestContext | Response> {
    const requestId = context.req.header("x-request-id") ?? randomUUID();
    const sessionId = getCookie(context, settings.sessionCookieName);
    const session = await store.getSession(sessionId);
    if (!session) {
      return context.json(errorPayload("http_401", "Not authenticated.", requestId), 401);
    }

    return {
      userId: session.user.id,
      actorType: session.user.isAdmin ? "admin" : "user",
      permissions: session.user.isAdmin ? ["user", "admin"] : ["user"],
      requestId,
      session
    };
  }

  async function requireAdmin(context: import("hono").Context): Promise<RequestContext | Response> {
    const authContext = await requireContext(context);
    if (authContext instanceof Response) {
      return authContext;
    }
    if (!authContext.session.user.isAdmin) {
      return context.json(errorPayload("http_403", "Administrator access required.", authContext.requestId), 403);
    }
    return authContext;
  }

  async function buildJobsPayload(authContext: RequestContext, includeAllUsers: boolean) {
    const [tasks, outbox, audit, connectors, approvals, ragJobs, ragHealth, runs, toolCalls, aiConfig] = await Promise.all([
      store.listTasks(authContext),
      store.listOutboundMessages(authContext),
      store.listAudit(authContext, includeAllUsers),
      store.listConnectors(authContext),
      store.listApprovals(authContext, ["pending"]),
      store.listRagIndexJobs(authContext, includeAllUsers),
      store.listRagUserIndexHealth(authContext, includeAllUsers),
      store.listAgentRuns(authContext, includeAllUsers),
      store.listToolCalls(authContext, includeAllUsers),
      store.getAiConfig()
    ]);
    const dueTasks = tasks.filter((task) => {
      if (task.status !== "pending" || !task.dueAt) {
        return false;
      }
      return new Date(task.dueAt).getTime() <= Date.now();
    });
    const failedRuns = runs.filter((run) => run.status === "failed");
    const failedToolCalls = toolCalls.filter((toolCall) => toolCall.status === "failed" || toolCall.status === "rejected");
    const qdrantProblemCount = ragHealth.filter((entry) => !["ok", "healthy"].includes(entry.healthStatus)).length;
    const safety = runtimeSafetyPolicy(settings, aiConfig);
    const recentGuardrails = audit.filter((event) => event.action === "guardrail.exceeded");
    return {
      generatedAt: new Date().toISOString(),
      budgets: {
        maxAgentRunsPerUserPerHour: safety.maxAgentRunsPerUserPerHour,
        maxAutonomousRunsPerWorkerTick: safety.maxAutonomousRunsPerWorkerTick,
        maxToolCallsPerRun: safety.maxToolCallsPerRun,
        maxRuntimeSecPerRun: aiConfig.maxRuntimeSec,
        repairAttemptLimit: safety.repairAttemptLimit,
        maxOwnerVisibleOutboundMessagesPerUserPerDay: safety.maxOwnerVisibleOutboundMessagesPerUserPerDay,
        outboundMessagesPerWorkerTick: safety.outboundMessagesPerWorkerTick,
        maxUntrustedReviewNotificationsPerSenderPerDay: safety.maxUntrustedReviewNotificationsPerSenderPerDay,
        maxNewsletterDocumentsPerInterestCheck: safety.maxNewsletterDocumentsPerInterestCheck,
        maxPromptExcerptChars: safety.maxPromptExcerptChars,
        maxContextExcerptChars: safety.maxContextExcerptChars,
        workerTickSeconds: 20,
        maxRagSearchResultsPerCall: 25,
        browserMcpSessionTtlSeconds: 900
      },
      ragIndexHealth: ragHealth,
      recentFailures: {
        agentRuns: failedRuns.slice(0, 20),
        toolCalls: failedToolCalls.slice(0, 20),
        ragJobs: ragJobs.filter((job) => job.status === "failed" || job.status === "dead").slice(0, 20),
        guardrails: recentGuardrails.slice(0, 20)
      },
      jobs: [
        {
          name: "api-health",
          status: "ok",
          lastAuditAt: audit[0]?.createdAt ?? null
        },
        {
          name: "worker-tick",
          status: audit.some((event) => event.action === "worker.imap_error") ? "degraded" : "unknown",
          lastAuditAt: audit.find((event) => event.action.startsWith("worker."))?.createdAt ?? null
        },
        {
          name: "task-runner",
          status: failedRuns.length > 0 ? "degraded" : "configured",
          pendingTasks: tasks.filter((task) => task.status === "pending").length,
          dueTasks: dueTasks.length,
          failedTasks: tasks.filter((task) => task.status === "failed").length,
          failedRuns: failedRuns.length,
          lastAuditAt: audit.find((event) => event.action.startsWith("agent_run."))?.createdAt ?? null
        },
        {
          name: "mcp-tools",
          status: recentGuardrails.some((event) => event.details.guardrail === "maxToolCallsPerRun") || failedToolCalls.length > 0 ? "degraded" : "configured",
          failedToolCalls: failedToolCalls.length,
          lastAuditAt: audit.find((event) => event.action.startsWith("mcp.") || event.action.startsWith("tool_call."))?.createdAt ?? null
        },
        {
          name: "outbox",
          status: recentGuardrails.some((event) => event.details.guardrail === "maxOwnerVisibleOutboundMessagesPerUserPerDay") || countByStatus(outbox, "failed") > 0 ? "degraded" : "configured",
          pendingMessages: countByStatus(outbox, "pending"),
          approvedMessages: countByStatus(outbox, "approved"),
          sendingMessages: countByStatus(outbox, "sending"),
          failedMessages: countByStatus(outbox, "failed"),
          lastAuditAt: audit.find((event) => event.action.startsWith("outbound."))?.createdAt ?? null
        },
        {
          name: "runaway-guardrails",
          status: recentGuardrails.length > 0 ? "attention" : "configured",
          recentTrips: recentGuardrails.length,
          lastAuditAt: recentGuardrails[0]?.createdAt ?? null
        },
        {
          name: "inbound-mailbox",
          status: connectors.find((connector) => connector.kind === "imap" && connector.status === "enabled")
            ? "configured"
            : "disabled",
          lastAuditAt: audit.find((event) => event.action.startsWith("message.inbound") || event.action === "worker.imap_error")?.createdAt ?? null
        },
        {
          name: "approvals",
          status: approvals.length > 0 ? "attention" : "ok",
          pendingApprovals: approvals.length,
          lastAuditAt: audit.find((event) => event.action.startsWith("approval."))?.createdAt ?? null
        },
        {
          name: "rag-index",
          status: countByStatus(ragJobs, "dead") > 0 || countByStatus(ragJobs, "failed") > 0 ? "degraded" : "configured",
          pendingJobs: countByStatus(ragJobs, "pending"),
          claimedJobs: countByStatus(ragJobs, "claimed"),
          failedJobs: countByStatus(ragJobs, "failed"),
          deadJobs: countByStatus(ragJobs, "dead"),
          lastAuditAt: audit.find((event) => event.action.startsWith("rag."))?.createdAt ?? null
        },
        {
          name: "qdrant-collections",
          status: qdrantProblemCount > 0 ? "degraded" : ragHealth.length > 0 ? "configured" : "unknown",
          collections: ragHealth.length,
          unhealthyCollections: qdrantProblemCount,
          lastAuditAt: audit.find((event) => event.action.startsWith("rag."))?.createdAt ?? null
        }
      ]
    };
  }

  app.get("/healthz", (context) => context.json({ status: "ok" }));

  app.get("/api/v1/status", (context) => context.json({
    status: "ok",
    app: "ai-assistant",
    version: settings.appVersion,
    auth_mode: settings.authMode,
    base_path: settings.appBasePath
  }));

  app.get("/api/v1/jobs", async (context) => {
    const authContext = await requireContext(context);
    if (authContext instanceof Response) {
      return authContext;
    }
    return context.json(await buildJobsPayload(authContext, false));
  });

  app.get("/api/v1/auth/me", async (context) => {
    const sessionId = getCookie(context, settings.sessionCookieName);
    const session = await store.getSession(sessionId);
    if (!session) {
      return context.json({
        authenticated: false,
        user: null
      });
    }

    return context.json({
      authenticated: true,
      user: session.user,
      expiresAt: session.expiresAt
    });
  });

  app.post("/api/v1/auth/dev-login", async (context) => {
    if (settings.authMode !== "standalone") {
      return context.json({
        error: {
          code: "not_found",
          message: "Development sign-in is not available."
        }
      }, 404);
    }

    const session = await store.createDevelopmentSession(
      settings,
      context.req.header("x-request-id") ?? randomUUID()
    );
    writeSessionCookie(context, settings, session);
    return context.json({
      authenticated: true,
      user: session.user,
      expiresAt: session.expiresAt
    });
  });

  app.get("/api/v1/auth/login", async (context) => {
    if (settings.authMode === "standalone") {
      return context.redirect(`${settings.appBasePath || "/"}`, 302);
    }

    const next = context.req.query("next") ?? "/";
    const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";
    const state = tokenUrlSafe(24);
    const verifier = tokenUrlSafe(32);
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    await store.createOauthState({
      state,
      codeVerifier: verifier,
      nextPath: safeNext,
      expiresAt
    });
    return context.redirect(authAuthorizeUrl({
      response_type: "code",
      client_id: settings.oauthClientId,
      redirect_uri: oauthRedirectUri(),
      scope: settings.oauthScope,
      state,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: "S256"
    }), 302);
  });

  app.get("/api/v1/auth/oauth/callback", async (context) => {
    if (settings.authMode !== "oauth") {
      return context.redirect(appRedirect("/", "oauth_not_enabled"), 302);
    }
    const requestId = context.req.header("x-request-id") ?? randomUUID();
    const code = context.req.query("code");
    const state = context.req.query("state");
    if (!code || !state) {
      return context.redirect(appRedirect("/", "oauth_callback"), 302);
    }
    const stateRecord = await store.consumeOauthState(state);
    if (!stateRecord) {
      return context.redirect(appRedirect("/", "oauth_state"), 302);
    }
    try {
      const tokenResponse = await fetcher(`${(settings.oauthServerBaseUrl || settings.authBaseUrl).replace(/\/$/, "")}/oauth/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: settings.oauthClientId,
          code,
          redirect_uri: oauthRedirectUri(),
          code_verifier: stateRecord.codeVerifier
        }).toString()
      });
      if (!tokenResponse.ok) {
        return context.redirect(appRedirect("/", "oauth_failed"), 302);
      }
      const tokenPayload = await tokenResponse.json().catch(() => null) as Record<string, unknown> | null;
      const accessToken = tokenPayload?.access_token;
      if (typeof accessToken !== "string") {
        return context.redirect(appRedirect("/", "oauth_failed"), 302);
      }
      const userinfoResponse = await fetcher(`${(settings.oauthServerBaseUrl || settings.authBaseUrl).replace(/\/$/, "")}/oauth/userinfo`, {
        headers: {
          authorization: `Bearer ${accessToken}`
        }
      });
      if (!userinfoResponse.ok) {
        return context.redirect(appRedirect("/", "oauth_failed"), 302);
      }
      const userinfo = await userinfoResponse.json().catch(() => null) as Record<string, unknown> | null;
      const subject = typeof userinfo?.sub === "string" ? userinfo.sub : "";
      const username = typeof userinfo?.preferred_username === "string" ? userinfo.preferred_username : subject;
      if (!subject || !username) {
        return context.redirect(appRedirect("/", "oauth_failed"), 302);
      }
      const session = await store.createOauthSession(settings, {
        subject,
        email: typeof userinfo?.email === "string" ? userinfo.email : `${username}@central-auth.local`,
        displayName: typeof userinfo?.name === "string" ? userinfo.name : username,
        isAdmin: userinfo?.is_admin === true,
        identityProvider: "central-oauth",
        requestId
      });
      writeSessionCookie(context, settings, session);
      return context.redirect(appRedirect(stateRecord.nextPath), 302);
    } catch {
      return context.redirect(appRedirect("/", "oauth_failed"), 302);
    }
  });

  app.post("/api/v1/auth/logout", async (context) => {
    const sessionId = getCookie(context, settings.sessionCookieName);
    await store.revokeSession(sessionId, context.req.header("x-request-id") ?? randomUUID());
    clearSessionCookie(context, settings);
    return context.json({ authenticated: false });
  });

  app.get("/api/v1/tasks", async (context) => {
    const authContext = await requireContext(context);
    if (authContext instanceof Response) {
      return authContext;
    }
    return context.json({ tasks: await store.listTasks(authContext) });
  });

  app.post("/api/v1/tasks", async (context) => {
    const authContext = await requireContext(context);
    if (authContext instanceof Response) {
      return authContext;
    }
    const payload = await context.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!payload || typeof payload.title !== "string" || typeof payload.prompt !== "string") {
      return context.json(
        errorPayload("validation_error", "Task title and prompt are required.", authContext.requestId),
        400
      );
    }
    const task = await store.createTask(authContext, {
      title: payload.title,
      prompt: payload.prompt,
      dueAt: typeof payload.dueAt === "string" ? payload.dueAt : null,
      priority: typeof payload.priority === "number" ? payload.priority : 0
    });
    return context.json(task, 201);
  });

  app.get("/api/v1/tasks/:id", async (context) => {
    const authContext = await requireContext(context);
    if (authContext instanceof Response) {
      return authContext;
    }
    const task = await store.getTask(authContext, context.req.param("id"));
    if (!task) {
      return context.json(errorPayload("http_404", "Task not found.", authContext.requestId), 404);
    }
    return context.json(task);
  });

  app.patch("/api/v1/tasks/:id", async (context) => {
    const authContext = await requireContext(context);
    if (authContext instanceof Response) {
      return authContext;
    }
    const payload = await context.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!payload) {
      return context.json(errorPayload("validation_error", "Request body is required.", authContext.requestId), 400);
    }
    if (payload.status !== undefined && !["pending", "claimed", "running", "completed", "cancelled", "failed"].includes(String(payload.status))) {
      return context.json(errorPayload("validation_error", "A valid task status is required.", authContext.requestId), 400);
    }
    const task = await store.updateTask(authContext, context.req.param("id"), {
      title: typeof payload.title === "string" ? payload.title : undefined,
      prompt: typeof payload.prompt === "string" ? payload.prompt : undefined,
      dueAt: typeof payload.dueAt === "string" || payload.dueAt === null ? payload.dueAt : undefined,
      priority: typeof payload.priority === "number" ? payload.priority : undefined,
      status: typeof payload.status === "string" ? payload.status : undefined
    });
    if (!task) {
      return context.json(errorPayload("http_404", "Task not found.", authContext.requestId), 404);
    }
    return context.json(task);
  });

  app.get("/api/v1/tasks/:id/events", async (context) => {
    const authContext = await requireContext(context);
    if (authContext instanceof Response) {
      return authContext;
    }
    const task = await store.getTask(authContext, context.req.param("id"));
    if (!task) {
      return context.json(errorPayload("http_404", "Task not found.", authContext.requestId), 404);
    }
    return context.json({ events: await store.listTaskEvents(authContext, task.id) });
  });

  app.post("/api/v1/tasks/:id/prompts", async (context) => {
    const authContext = await requireContext(context);
    if (authContext instanceof Response) {
      return authContext;
    }
    const payload = await context.req.json().catch(() => null) as Record<string, unknown> | null;
    const prompt = typeof payload?.prompt === "string" ? payload.prompt.trim() : "";
    if (!prompt) {
      return context.json(errorPayload("validation_error", "Prompt text is required.", authContext.requestId), 400);
    }
    const task = await store.getTask(authContext, context.req.param("id"));
    if (!task) {
      return context.json(errorPayload("http_404", "Task not found.", authContext.requestId), 404);
    }
    const updated = await store.updateTask(authContext, task.id, {
      prompt: `${task.prompt}\n\nFollow-up prompt:\n${prompt}`,
      status: "pending"
    });
    await store.recordTaskEvent(authContext, task.id, "task.prompt_added", {
      prompt,
      summary: "Follow-up prompt added and task returned to pending."
    });
    return context.json({
      task: updated,
      events: await store.listTaskEvents(authContext, task.id)
    });
  });

  app.get("/api/v1/conversations", async (context) => {
    const authContext = await requireContext(context);
    if (authContext instanceof Response) {
      return authContext;
    }
    return context.json({ conversations: [] });
  });

  app.get("/api/v1/approvals", async (context) => {
    const authContext = await requireContext(context);
    if (authContext instanceof Response) {
      return authContext;
    }
    const status = context.req.query("status");
    const statuses = status ? status.split(",").filter((item) =>
      ["pending", "approved", "rejected", "expired"].includes(item)
    ) as Array<"pending" | "approved" | "rejected" | "expired"> : undefined;
    return context.json({ approvals: await store.listApprovals(authContext, statuses) });
  });

  app.patch("/api/v1/approvals/:id", async (context) => {
    const authContext = await requireContext(context);
    if (authContext instanceof Response) {
      return authContext;
    }
    const payload = await context.req.json().catch(() => null) as Record<string, unknown> | null;
    const decision = payload?.decision;
    if (decision === "approve" || decision === "reject") {
      const result = await decideApproval({
        context: authContext,
        store,
        approvalId: context.req.param("id"),
        decision
      });
      if (!result) {
        return context.json(errorPayload("http_404", "Approval not found.", authContext.requestId), 404);
      }
      return context.json(result);
    }
    if (decision === "edit" && typeof payload?.text === "string" && payload.text.trim()) {
      const result = await editApproval({
        context: authContext,
        store,
        approvalId: context.req.param("id"),
        text: payload.text.trim()
      });
      if (!result) {
        return context.json(errorPayload("http_404", "Approval not found.", authContext.requestId), 404);
      }
      return context.json(result);
    }
    return context.json(errorPayload("validation_error", "Approval decision must be approve, reject, or edit.", authContext.requestId), 400);
  });

  app.post("/api/v1/approvals/stale/reject", async (context) => {
    const authContext = await requireContext(context);
    if (authContext instanceof Response) {
      return authContext;
    }
    const pending = await store.listApprovals(authContext, ["pending"]);
    const stale = pending.filter((approval) => Date.parse(approval.expiresAt) <= Date.now());
    const rejected = [];
    for (const approval of stale) {
      const result = await decideApproval({
        context: authContext,
        store,
        approvalId: approval.id,
        decision: "reject"
      });
      if (result) {
        rejected.push(result.approval);
      }
    }
    return context.json({ rejected });
  });

  app.get("/api/v1/memory", async (context) => {
    const authContext = await requireContext(context);
    if (authContext instanceof Response) {
      return authContext;
    }
    return context.json({ documents: await store.listMemoryDocuments(authContext) });
  });

  app.get("/api/v1/memory/:slug", async (context) => {
    const authContext = await requireContext(context);
    if (authContext instanceof Response) {
      return authContext;
    }
    const document = await store.getMemoryDocument(authContext, context.req.param("slug"));
    if (!document) {
      return context.json(errorPayload("http_404", "Memory document not found.", authContext.requestId), 404);
    }
    return context.json({ document });
  });

  app.post("/api/v1/agent/mcp-sessions", async (context) => {
    const authContext = await requireContext(context);
    if (authContext instanceof Response) {
      return authContext;
    }
    const payload = await context.req.json().catch(() => null) as Record<string, unknown> | null;
    const session = await store.createAgentMcpSession(authContext, {
      runId: typeof payload?.runId === "string" ? payload.runId : null,
      ttlSeconds: typeof payload?.ttlSeconds === "number" ? payload.ttlSeconds : undefined,
      allowedTools: webMcpSessionTools
    });
    return context.json({
      token: session.token,
      runId: session.runId,
      expiresAt: session.expiresAt,
      allowedTools: session.allowedTools
    }, 201);
  });

  app.post("/api/v1/agent/prompts", async (context) => {
    const authContext = await requireContext(context);
    if (authContext instanceof Response) {
      return authContext;
    }
    const payload = await context.req.json().catch(() => null) as Record<string, unknown> | null;
    const prompt = typeof payload?.prompt === "string" ? payload.prompt.trim() : "";
    if (!prompt) {
      return context.json(errorPayload("validation_error", "Prompt text is required.", authContext.requestId), 400);
    }
    const mode = typeof payload?.mode === "string" ? payload.mode : "normal";
    if (!["normal", "quick_reply", "planning"].includes(mode)) {
      return context.json(errorPayload("validation_error", "Prompt mode must be normal, quick_reply, or planning.", authContext.requestId), 400);
    }
    let contextTask;
    if (typeof payload?.contextTaskId === "string" && payload.contextTaskId.trim()) {
      contextTask = await store.getTask(authContext, payload.contextTaskId);
      if (!contextTask) {
        return context.json(errorPayload("http_404", "Context task not found.", authContext.requestId), 404);
      }
    }
    const result = await runOwnerWebPromptAgent({
      context: authContext,
      store,
      prompt,
      contextTask,
      mode: mode as "normal" | "quick_reply" | "planning",
      modelClient,
      settings,
      fetchImpl: fetcher
    });
    const links = {
      taskId: linkValue(result.executionResult, "task_id") ?? contextTask?.id ?? null,
      taskEventId: linkValue(result.executionResult, "task_event_id"),
      outboundMessageId: linkValue(result.executionResult, "outbound_message_id"),
      memoryDocumentId: linkValue(result.executionResult, "memory_document_id"),
      memorySlug: linkValue(result.executionResult, "slug"),
      clarificationRequestId: linkValue(result.executionResult, "clarification_request_id")
    };
    return context.json({
      runId: result.runId,
      status: result.status,
      selectedAction: result.toolName ?? null,
      toolStatus: result.toolStatus,
      repaired: result.repaired,
      toolResult: result.executionResult ?? null,
      links,
      failureMessage: result.failureMessage ?? null
    }, result.status === "failed" ? 500 : 200);
  });

  app.get("/api/v1/knowledge/tree", async (context) => {
    const authContext = await requireContext(context);
    if (authContext instanceof Response) {
      return authContext;
    }
    const root = context.req.query("path") ?? "/";
    const maxDepth = Math.max(0, Math.min(Number(context.req.query("maxDepth") ?? 4), 8));
    const walk = async (path: string, depth: number): Promise<unknown[]> => {
      const entries = await store.listMarkdownDirectory(authContext, path);
      return Promise.all(entries.map(async (entry) => ({
        ...entry,
        children: entry.type === "directory" && depth < maxDepth ? await walk(entry.path, depth + 1) : undefined
      })));
    };
    return context.json({ path: root, entries: await walk(root, 0) });
  });

  app.get("/api/v1/knowledge/files", async (context) => {
    const authContext = await requireContext(context);
    if (authContext instanceof Response) {
      return authContext;
    }
    return context.json({ entries: await store.listMarkdownDirectory(authContext, context.req.query("path") ?? "/") });
  });

  app.get("/api/v1/knowledge/files/:encodedPath", async (context) => {
    const authContext = await requireContext(context);
    if (authContext instanceof Response) {
      return authContext;
    }
    const document = await store.getMarkdownDocument(authContext, decodePathParam(context.req.param("encodedPath")));
    if (!document) {
      return context.json(errorPayload("http_404", "Knowledge file not found.", authContext.requestId), 404);
    }
    return context.json({ document });
  });

  app.put("/api/v1/knowledge/files/:encodedPath", async (context) => {
    const authContext = await requireContext(context);
    if (authContext instanceof Response) {
      return authContext;
    }
    const payload = await context.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!payload || typeof payload.content !== "string") {
      return context.json(errorPayload("validation_error", "File content is required.", authContext.requestId), 400);
    }
    const path = decodePathParam(context.req.param("encodedPath"));
    if (!path.startsWith("/assistant/")) {
      return context.json(errorPayload("http_403", "Only assistant instruction files can be edited from the web console.", authContext.requestId), 403);
    }
    const result = await store.writeMarkdownDocument(authContext, {
      path,
      markdown: payload.content,
      expectedVersion: typeof payload.expectedVersion === "number" ? payload.expectedVersion : undefined
    });
    if (isMarkdownConflict(result)) {
      return context.json({ error: result }, 409);
    }
    return context.json({ document: result });
  });

  app.get("/api/v1/knowledge/files/:encodedPath/sections", async (context) => {
    const authContext = await requireContext(context);
    if (authContext instanceof Response) {
      return authContext;
    }
    return context.json({
      sections: await store.listMarkdownSections(authContext, decodePathParam(context.req.param("encodedPath")))
    });
  });

  app.get("/api/v1/connectors", async (context) => {
    const authContext = await requireContext(context);
    if (authContext instanceof Response) {
      return authContext;
    }
    const connectors = await store.listConnectors(authContext);
    return context.json({ connectors: connectors.map(connectorResponse) });
  });

  app.put("/api/v1/connectors/:kind", async (context) => {
    const authContext = await requireContext(context);
    if (authContext instanceof Response) {
      return authContext;
    }
    const kind = context.req.param("kind") as ConnectorKind;
    if (!allowedConnectorKinds.has(kind)) {
      return context.json(errorPayload("validation_error", "Unknown connector kind.", authContext.requestId), 400);
    }
    const payload = await context.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!payload) {
      return context.json(errorPayload("validation_error", "Request body is required.", authContext.requestId), 400);
    }
    const status = String(payload.status ?? "enabled") as ConnectorStatus;
    if (!allowedConnectorStatuses.has(status)) {
      return context.json(errorPayload("validation_error", "Connector status must be enabled or disabled.", authContext.requestId), 400);
    }
    const configInput = typeof payload.config === "object" && payload.config !== null
      ? payload.config as Record<string, unknown>
      : payload;
    const existing = await store.getConnector(authContext, kind);
    const config = sanitizeConnectorConfig(kind, configInput, existing?.config ?? {});
    const connector = await store.upsertConnector(authContext, {
      kind,
      status,
      config
    });
    if (kind === "owner-contact" && status === "enabled") {
      for (const address of [config.email, config.sms_gateway, config.mms_gateway]) {
        if (typeof address === "string" && address.trim()) {
          await store.setSenderStatus(authContext, address, "owner");
        }
      }
    }
    return context.json(connectorResponse(connector));
  });

  app.post("/api/v1/connectors/imap/test", async (context) => {
    const authContext = await requireContext(context);
    if (authContext instanceof Response) {
      return authContext;
    }
    const result = await testImapConnection({
      store,
      context: authContext,
      settings
    });
    await store.recordAudit(authContext, result.ok ? "connector.imap_test.ok" : "connector.imap_test.failed", "connector", "imap", {
      host: result.host ?? null,
      port: result.port ?? null,
      mailbox: result.mailbox ?? null,
      unseen_count: result.unseenCount ?? null,
      error: result.error ?? null
    });
    return context.json(result);
  });

  app.get("/api/v1/messages", async (context) => {
    const authContext = await requireContext(context);
    if (authContext instanceof Response) {
      return authContext;
    }
    return context.json({ messages: await store.listInboundMessages(authContext) });
  });

  app.post("/api/v1/messages/:id/owner-review", async (context) => {
    const authContext = await requireContext(context);
    if (authContext instanceof Response) {
      return authContext;
    }
    const message = await store.getInboundMessage(authContext, context.req.param("id"));
    if (!message) {
      return context.json(errorPayload("http_404", "Inbox message not found.", authContext.requestId), 404);
    }
    if (message.classification !== "untrusted" || message.handlingAction !== "queued_owner_review") {
      return context.json(errorPayload("validation_error", "Only queued untrusted reviews can notify the owner.", authContext.requestId), 400);
    }
    if (message.outboundMessageId) {
      return context.json(errorPayload("validation_error", "This inbox message already has a linked owner review notification.", authContext.requestId), 400);
    }
    const outbound = await queueOwnerReviewNotification({
      context: authContext,
      settings,
      store,
      message
    });
    if (!outbound) {
      return context.json(errorPayload("validation_error", "Owner contact SMS, MMS, or email must be configured before sending a review notification.", authContext.requestId), 400);
    }
    const updated = await store.updateInboundMessageHandling(authContext, message.id, {
      action: "queued_owner_review",
      outboundMessageId: outbound.id
    });
    return context.json({ message: updated, outbound });
  });

  app.get("/api/v1/audit", async (context) => {
    const authContext = await requireContext(context);
    if (authContext instanceof Response) {
      return authContext;
    }
    return context.json({ events: await store.listAudit(authContext, false) });
  });

  app.get("/api/v1/outbox", async (context) => {
    const authContext = await requireContext(context);
    if (authContext instanceof Response) {
      return authContext;
    }
    return context.json({ messages: await store.listOutboundMessages(authContext) });
  });

  app.patch("/api/v1/outbox/:id", async (context) => {
    const authContext = await requireContext(context);
    if (authContext instanceof Response) {
      return authContext;
    }
    const payload = await context.req.json().catch(() => null) as Record<string, unknown> | null;
    const statusValue = payload?.status;
    if (!["pending", "approved", "cancelled"].includes(String(statusValue))) {
      return context.json(errorPayload("validation_error", "A valid outbox status is required.", authContext.requestId), 400);
    }
    const existing = (await store.listOutboundMessages(authContext)).find((candidate) => candidate.id === context.req.param("id"));
    if (existing?.approvalId && (statusValue === "approved" || statusValue === "cancelled")) {
      const result = await decideApproval({
        context: authContext,
        store,
        approvalId: existing.approvalId,
        decision: statusValue === "approved" ? "approve" : "reject"
      });
      if (!result?.outbound) {
        return context.json(errorPayload("validation_error", "Approval could not be applied.", authContext.requestId), 400);
      }
      return context.json(result.outbound);
    }
    const message = await store.updateOutboundMessageStatus(
      authContext,
      context.req.param("id"),
      statusValue as "pending" | "approved" | "cancelled"
    );
    if (!message) {
      return context.json(errorPayload("http_404", "Outbox message not found.", authContext.requestId), 404);
    }
    return context.json(message);
  });

  app.get("/api/v1/senders", async (context) => {
    const authContext = await requireContext(context);
    if (authContext instanceof Response) {
      return authContext;
    }
    return context.json({ senders: await store.listSenders(authContext) });
  });

  app.put("/api/v1/senders/:address", async (context) => {
    const authContext = await requireContext(context);
    if (authContext instanceof Response) {
      return authContext;
    }
    const address = decodeURIComponent(context.req.param("address")).trim().toLowerCase();
    const payload = await context.req.json().catch(() => null) as Record<string, unknown> | null;
    const status = payload?.status;
    const allowedStatuses = new Set(["owner", "newsletter", "trusted", "blocked", "untrusted"]);
    if (!address || !allowedStatuses.has(String(status))) {
      return context.json(
        errorPayload("validation_error", "Sender address and valid status are required.", authContext.requestId),
        400
      );
    }
    await store.setSenderStatus(authContext, address, status as SenderStatus);
    return context.json({ senders: await store.listSenders(authContext) });
  });

  app.delete("/api/v1/senders/:address", async (context) => {
    const authContext = await requireContext(context);
    if (authContext instanceof Response) {
      return authContext;
    }
    const address = decodeURIComponent(context.req.param("address")).trim().toLowerCase();
    if (!address) {
      return context.json(
        errorPayload("validation_error", "Sender address is required.", authContext.requestId),
        400
      );
    }
    const deleted = await store.deleteSender(authContext, address);
    if (!deleted) {
      return context.json(errorPayload("http_404", "Sender not found.", authContext.requestId), 404);
    }
    return context.json({ senders: await store.listSenders(authContext) });
  });

  app.get("/api/v1/admin/audit", async (context) => {
    const authContext = await requireAdmin(context);
    if (authContext instanceof Response) {
      return authContext;
    }
    return context.json({ events: await store.listAudit(authContext, true) });
  });

  app.get("/api/v1/admin/ai-config", async (context) => {
    const authContext = await requireAdmin(context);
    if (authContext instanceof Response) {
      return authContext;
    }
    return context.json(await store.getAiConfig());
  });

  app.put("/api/v1/admin/ai-config", async (context) => {
    const authContext = await requireAdmin(context);
    if (authContext instanceof Response) {
      return authContext;
    }
    const payload = await context.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!payload) {
      return context.json(errorPayload("validation_error", "Request body is required.", authContext.requestId), 400);
    }
    const current = await store.getAiConfig();
    return context.json(await store.updateAiConfig(authContext, {
      fastModel: typeof payload.fastModel === "string" ? payload.fastModel : current.fastModel,
      smartModel: typeof payload.smartModel === "string" ? payload.smartModel : current.smartModel,
      orchestratorModel: typeof payload.orchestratorModel === "string"
        ? payload.orchestratorModel
        : current.orchestratorModel,
      repairModel: typeof payload.repairModel === "string" ? payload.repairModel : current.repairModel,
      maxToolCalls: typeof payload.maxToolCalls === "number" ? payload.maxToolCalls : current.maxToolCalls,
      maxRuntimeSec: typeof payload.maxRuntimeSec === "number" ? payload.maxRuntimeSec : current.maxRuntimeSec,
      repairAttemptLimit: typeof payload.repairAttemptLimit === "number"
        ? payload.repairAttemptLimit
        : current.repairAttemptLimit
    }));
  });

  app.get("/api/v1/admin/jobs", async (context) => {
    const authContext = await requireAdmin(context);
    if (authContext instanceof Response) {
      return authContext;
    }
    return context.json(await buildJobsPayload(authContext, true));
  });

  app.post("/api/v1/admin/rag-index-jobs/:id/retry", async (context) => {
    const authContext = await requireAdmin(context);
    if (authContext instanceof Response) {
      return authContext;
    }
    const job = await store.retryRagIndexJob(authContext, context.req.param("id"), true);
    if (!job) {
      return context.json(errorPayload("http_404", "Failed or dead RAG index job not found.", authContext.requestId), 404);
    }
    return context.json({ job });
  });

  return app;
}
