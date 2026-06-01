import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { loadSettings, type Settings } from "../config/settings.js";
import { clearSessionCookie, writeSessionCookie } from "../auth/session.js";
import { testImapConnection } from "../connectors/imapPoller.js";
import { createPool } from "../db/pool.js";
import { createMemoryStore, createPostgresStore } from "../domain/store.js";
import type { AgentStore, ConnectorKind, ConnectorStatus, RequestContext, SenderStatus } from "../domain/types.js";
import { queueOwnerReviewNotification } from "../security/senderPolicy.js";

export type AppOptions = {
  settings?: Settings;
  store?: AgentStore;
  fetchImpl?: typeof fetch;
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
        password: password ?? null
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

export function buildApp(options: AppOptions = {}): Hono {
  const settings = options.settings ?? loadSettings();
  const store = options.store ?? createDefaultStore(settings);
  const fetcher = options.fetchImpl ?? fetch;
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

  app.get("/healthz", (context) => context.json({ status: "ok" }));

  app.get("/api/v1/status", (context) => context.json({
    status: "ok",
    app: "ai-assistant",
    version: settings.appVersion,
    auth_mode: settings.authMode,
    base_path: settings.appBasePath
  }));

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

  for (const [path, key] of [
    ["/api/v1/conversations", "conversations"],
    ["/api/v1/memory", "documents"],
    ["/api/v1/approvals", "approvals"]
  ] as const) {
    app.get(path, async (context) => {
      const authContext = await requireContext(context);
      if (authContext instanceof Response) {
        return authContext;
      }
      return context.json({ [key]: [] });
    });
  }

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
    const [tasks, outbox, audit, connectors] = await Promise.all([
      store.listTasks(authContext),
      store.listOutboundMessages(authContext),
      store.listAudit(authContext, true),
      store.listConnectors(authContext)
    ]);
    const dueTasks = tasks.filter((task) => {
      if (task.status !== "pending" || !task.dueAt) {
        return false;
      }
      return new Date(task.dueAt).getTime() <= Date.now();
    });
    const countOutbox = (status: string) => outbox.filter((message) => message.status === status).length;
    return context.json({
      generatedAt: new Date().toISOString(),
      jobs: [
        {
          name: "task-runner",
          status: "configured",
          pendingTasks: tasks.filter((task) => task.status === "pending").length,
          dueTasks: dueTasks.length,
          lastAuditAt: audit.find((event) => event.action.startsWith("agent_run."))?.createdAt ?? null
        },
        {
          name: "outbox",
          status: "configured",
          pendingMessages: countOutbox("pending"),
          approvedMessages: countOutbox("approved"),
          sendingMessages: countOutbox("sending"),
          failedMessages: countOutbox("failed"),
          lastAuditAt: audit.find((event) => event.action.startsWith("outbound."))?.createdAt ?? null
        },
        {
          name: "inbound-mailbox",
          status: connectors.find((connector) => connector.kind === "imap" && connector.status === "enabled")
            ? "configured"
            : "disabled",
          lastAuditAt: audit.find((event) => event.action.startsWith("message.inbound"))?.createdAt ?? null
        }
      ]
    });
  });

  return app;
}
