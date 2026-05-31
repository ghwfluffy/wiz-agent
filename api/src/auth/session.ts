import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import type { Settings } from "../config/settings.js";

export type AuthenticatedUser = {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
};

export type Tenant = {
  id: string;
  name: string;
};

export type Session = {
  id: string;
  user: AuthenticatedUser;
  tenant: Tenant;
  createdAt: string;
  expiresAt: string;
};

export type SessionStore = {
  createDevelopmentSession(settings: Settings): Session;
  get(sessionId: string | undefined): Session | undefined;
  delete(sessionId: string | undefined): void;
};

export function createMemorySessionStore(): SessionStore {
  const sessions = new Map<string, Session>();

  return {
    createDevelopmentSession(settings: Settings): Session {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + settings.sessionDurationMinutes * 60_000);
      const session: Session = {
        id: randomUUID(),
        user: {
          id: settings.devUserId,
          email: settings.devUserEmail,
          displayName: settings.devUserDisplayName,
          isAdmin: settings.devUserIsAdmin
        },
        tenant: {
          id: settings.devTenantId,
          name: settings.devTenantName
        },
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString()
      };
      sessions.set(session.id, session);
      return session;
    },
    get(sessionId: string | undefined): Session | undefined {
      if (!sessionId) {
        return undefined;
      }
      const session = sessions.get(sessionId);
      if (!session) {
        return undefined;
      }
      if (Date.parse(session.expiresAt) <= Date.now()) {
        sessions.delete(sessionId);
        return undefined;
      }
      return session;
    },
    delete(sessionId: string | undefined): void {
      if (sessionId) {
        sessions.delete(sessionId);
      }
    }
  };
}

export function writeSessionCookie(context: Context, settings: Settings, session: Session): void {
  setCookie(context, settings.sessionCookieName, session.id, {
    httpOnly: true,
    path: settings.sessionCookiePath,
    sameSite: "lax",
    secure: settings.appEnv === "production",
    expires: new Date(session.expiresAt)
  });
}

export function clearSessionCookie(context: Context, settings: Settings): void {
  deleteCookie(context, settings.sessionCookieName, {
    path: settings.sessionCookiePath
  });
}
