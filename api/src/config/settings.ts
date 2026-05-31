import { z } from "zod";

const EnvBooleanSchema = z.preprocess((value) => {
  if (typeof value === "string") {
    return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  }
  return value;
}, z.boolean());

const SettingsSchema = z.object({
  appEnv: z.string().default("development"),
  appVersion: z.string().default("0.1.0"),
  authMode: z.enum(["standalone", "oauth"]).default("standalone"),
  authBaseUrl: z.string().default("/auth"),
  appBasePath: z.string().default(""),
  publicUrl: z.string().default("http://localhost:18081"),
  postgresUser: z.string().default("agent"),
  postgresPassword: z.string().default("agent_dev_password"),
  postgresDb: z.string().default("agent"),
  postgresHost: z.string().default("localhost"),
  postgresPort: z.coerce.number().int().positive().default(5432),
  sessionCookieName: z.string().default("agent_session"),
  sessionCookiePath: z.string().default("/"),
  sessionDurationMinutes: z.coerce.number().int().positive().default(1440),
  devTenantId: z.string().default("dev-tenant"),
  devTenantName: z.string().default("Development Tenant"),
  devUserId: z.string().default("dev-user"),
  devUserEmail: z.string().email().default("dev@example.test"),
  devUserDisplayName: z.string().default("Development User"),
  devUserIsAdmin: EnvBooleanSchema.default(true)
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
  const settings = SettingsSchema.parse({
    appEnv: env.APP_ENV,
    appVersion: env.APP_VERSION,
    authMode: env.AUTH_MODE,
    authBaseUrl: normalizeBasePath(env.AUTH_BASE_URL ?? "/auth"),
    appBasePath: normalizeBasePath(env.APP_BASE_PATH ?? ""),
    publicUrl: env.PUBLIC_URL,
    postgresUser: env.POSTGRES_USER,
    postgresPassword: env.POSTGRES_PASSWORD,
    postgresDb: env.POSTGRES_DB,
    postgresHost: env.POSTGRES_HOST,
    postgresPort: env.POSTGRES_PORT,
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
  if (settings.appEnv === "production" && settings.postgresPassword === "agent_dev_password") {
    throw new Error("Unsafe production configuration values: POSTGRES_PASSWORD");
  }
  return settings;
}
