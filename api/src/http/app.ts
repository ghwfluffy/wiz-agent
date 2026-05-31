import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { randomUUID } from "node:crypto";
import { loadSettings, type Settings } from "../config/settings.js";
import { clearSessionCookie, writeSessionCookie } from "../auth/session.js";
import { createPool } from "../db/pool.js";
import { createMemoryStore, createPostgresStore } from "../domain/store.js";
import type { AgentStore, RequestContext } from "../domain/types.js";

export type AppOptions = {
  settings?: Settings;
  store?: AgentStore;
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

export function buildApp(options: AppOptions = {}): Hono {
  const settings = options.settings ?? loadSettings();
  const store = options.store ?? createDefaultStore(settings);
  const app = new Hono();

  async function requireContext(context: import("hono").Context): Promise<RequestContext | Response> {
    const requestId = context.req.header("x-request-id") ?? randomUUID();
    const sessionId = getCookie(context, settings.sessionCookieName);
    const session = await store.getSession(sessionId);
    if (!session) {
      return context.json(errorPayload("http_401", "Not authenticated.", requestId), 401);
    }

    return {
      tenantId: session.tenant.id,
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
        user: null,
        tenant: null
      });
    }

    return context.json({
      authenticated: true,
      user: session.user,
      tenant: session.tenant,
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
      tenant: session.tenant,
      expiresAt: session.expiresAt
    });
  });

  app.get("/api/v1/auth/login", (context) => {
    if (settings.authMode === "standalone") {
      return context.redirect(`${settings.appBasePath || "/"}`, 302);
    }

    return context.redirect(settings.authBaseUrl || "/", 302);
  });

  app.get("/api/v1/auth/oauth/callback", (context) => {
    const redirectBase = settings.appBasePath || "/";
    const separator = redirectBase.includes("?") ? "&" : "?";
    return context.redirect(`${redirectBase}${separator}oauth_error=oauth_not_configured`, 302);
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

  for (const [path, key] of [
    ["/api/v1/conversations", "conversations"],
    ["/api/v1/messages", "messages"],
    ["/api/v1/memory", "documents"],
    ["/api/v1/connectors", "connectors"],
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

  app.get("/api/v1/audit", async (context) => {
    const authContext = await requireContext(context);
    if (authContext instanceof Response) {
      return authContext;
    }
    return context.json({ events: await store.listAudit(authContext, false) });
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
    return context.json({ jobs: [] });
  });

  return app;
}
