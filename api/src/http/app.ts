import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { loadSettings, type Settings } from "../config/settings.js";
import {
  clearSessionCookie,
  createMemorySessionStore,
  writeSessionCookie,
  type SessionStore
} from "../auth/session.js";

export type AppOptions = {
  settings?: Settings;
  sessionStore?: SessionStore;
};

export function buildApp(options: AppOptions = {}): Hono {
  const settings = options.settings ?? loadSettings();
  const sessionStore = options.sessionStore ?? createMemorySessionStore();
  const app = new Hono();

  app.get("/healthz", (context) => context.json({ status: "ok" }));

  app.get("/api/v1/status", (context) => context.json({
    status: "ok",
    app: "ai-assistant",
    version: settings.appVersion,
    auth_mode: settings.authMode,
    base_path: settings.appBasePath
  }));

  app.get("/api/v1/auth/me", (context) => {
    const sessionId = getCookie(context, settings.sessionCookieName);
    const session = sessionStore.get(sessionId);
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

  app.post("/api/v1/auth/dev-login", (context) => {
    if (settings.authMode !== "standalone") {
      return context.json({
        error: {
          code: "not_found",
          message: "Development sign-in is not available."
        }
      }, 404);
    }

    const session = sessionStore.createDevelopmentSession(settings);
    writeSessionCookie(context, settings, session);
    return context.json({
      authenticated: true,
      user: session.user,
      tenant: session.tenant,
      expiresAt: session.expiresAt
    });
  });

  app.post("/api/v1/auth/logout", (context) => {
    const sessionId = getCookie(context, settings.sessionCookieName);
    sessionStore.delete(sessionId);
    clearSessionCookie(context, settings);
    return context.json({ authenticated: false });
  });

  return app;
}
