import { createHash, randomUUID } from "node:crypto";
import type { Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import type { Settings } from "../config/settings.js";

export type AuthenticatedUser = {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
};

export type Session = {
  id: string;
  user: AuthenticatedUser;
  createdAt: string;
  expiresAt: string;
};

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
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

export function createSessionFromSettings(settings: Settings): Session {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + settings.sessionDurationMinutes * 60_000);
  return {
    id: randomUUID(),
    user: {
      id: settings.devUserId,
      email: settings.devUserEmail,
      displayName: settings.devUserDisplayName,
      isAdmin: settings.devUserIsAdmin
    },
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString()
  };
}
