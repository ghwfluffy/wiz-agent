import { z } from "zod";

const SettingsSchema = z.object({
  appEnv: z.string().default("development"),
  appVersion: z.string().default("0.1.0"),
  authMode: z.enum(["standalone", "oauth"]).default("standalone"),
  authBaseUrl: z.string().default("/auth"),
  appBasePath: z.string().default(""),
  publicUrl: z.string().default("http://localhost:8081"),
  sessionCookieName: z.string().default("agent_session"),
  sessionCookiePath: z.string().default("/"),
  sessionDurationMinutes: z.coerce.number().int().positive().default(1440),
  devTenantId: z.string().default("dev-tenant"),
  devTenantName: z.string().default("Development Tenant"),
  devUserId: z.string().default("dev-user"),
  devUserEmail: z.string().email().default("dev@example.test"),
  devUserDisplayName: z.string().default("Development User"),
  devUserIsAdmin: z.coerce.boolean().default(true)
});

export type Settings = z.infer<typeof SettingsSchema>;

export function normalizeBasePath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "/") {
    return "";
  }

  const prefixed = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return prefixed.endsWith("/") ? prefixed.slice(0, -1) : prefixed;
}

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  return SettingsSchema.parse({
    appEnv: env.APP_ENV,
    appVersion: env.APP_VERSION,
    authMode: env.AUTH_MODE,
    authBaseUrl: normalizeBasePath(env.AUTH_BASE_URL ?? "/auth"),
    appBasePath: normalizeBasePath(env.APP_BASE_PATH ?? ""),
    publicUrl: env.PUBLIC_URL,
    sessionCookieName: env.SESSION_COOKIE_NAME,
    sessionCookiePath: env.SESSION_COOKIE_PATH,
    sessionDurationMinutes: env.SESSION_DURATION_MINUTES,
    devTenantId: env.DEV_TENANT_ID,
    devTenantName: env.DEV_TENANT_NAME,
    devUserId: env.DEV_USER_ID,
    devUserEmail: env.DEV_USER_EMAIL,
    devUserDisplayName: env.DEV_USER_DISPLAY_NAME,
    devUserIsAdmin: env.DEV_USER_IS_ADMIN
  });
}
