import { z } from "zod";
import { readFileSync } from "node:fs";

const EnvBooleanSchema = z.preprocess((value) => {
  if (typeof value === "string") {
    return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  }
  return value;
}, z.boolean());

function parseList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(String).map((item) => item.trim()).filter(Boolean);
  }
  if (typeof value !== "string") {
    return [];
  }
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

const SettingsSchema = z.object({
  appEnv: z.string().default("development"),
  appVersion: z.string().default("0.1.0"),
  authMode: z.enum(["standalone", "oauth"]).default("standalone"),
  authBaseUrl: z.string().default("/auth"),
  oauthServerBaseUrl: z.string().default(""),
  oauthClientId: z.string().default("agent"),
  oauthScope: z.string().default("openid profile"),
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
  devUserIsAdmin: EnvBooleanSchema.default(true),
  agentOpenaiModelFast: z.string().default("gpt-5-mini"),
  agentOpenaiModelSmart: z.string().default("gpt-5"),
  agentOpenaiModelOrchestrator: z.string().default("gpt-5"),
  agentOpenaiModelRepair: z.string().default("gpt-5-mini"),
  agentOpenaiApiKey: z.string().default(""),
  agentOpenaiBaseUrl: z.string().url().default("https://api.openai.com/v1"),
  agentSecretDir: z.string().default("secrets"),
  agentOutboundEnabled: EnvBooleanSchema.default(false),
  agentRepairAttemptLimit: z.coerce.number().int().min(0).default(1),
  agentMaxToolCalls: z.coerce.number().int().positive().default(10),
  agentMaxRuntimeSec: z.coerce.number().int().positive().default(120),
  agentOwnerEmails: z.array(z.string()).default(["dev@example.test"]),
  agentOwnerSmsEmails: z.array(z.string()).default([]),
  agentUntrustedReviewSms: z.string().default(""),
  inboundMaxUntrustedPerSenderPerHour: z.coerce.number().int().positive().default(3),
  inboundMaxUntrustedNotificationsPerHour: z.coerce.number().int().positive().default(10),
  goalsApiBaseUrl: z.string().default(""),
  budgetApiBaseUrl: z.string().default("")
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
  const openAiKeyFromFile = env.AGENT_OPENAI_API_KEY_FILE
    ? readFileSync(env.AGENT_OPENAI_API_KEY_FILE, "utf8").trim()
    : undefined;
  const settings = SettingsSchema.parse({
    appEnv: env.APP_ENV,
    appVersion: env.APP_VERSION,
    authMode: env.AUTH_MODE,
    authBaseUrl: normalizeBasePath(env.AUTH_BASE_URL ?? "/auth"),
    oauthServerBaseUrl: env.OAUTH_SERVER_BASE_URL,
    oauthClientId: env.OAUTH_CLIENT_ID,
    oauthScope: env.OAUTH_SCOPE,
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
    devUserIsAdmin: env.DEV_USER_IS_ADMIN,
    agentOpenaiModelFast: env.AGENT_OPENAI_MODEL_FAST,
    agentOpenaiModelSmart: env.AGENT_OPENAI_MODEL_SMART,
    agentOpenaiModelOrchestrator: env.AGENT_OPENAI_MODEL_ORCHESTRATOR,
    agentOpenaiModelRepair: env.AGENT_OPENAI_MODEL_REPAIR,
    agentOpenaiApiKey: env.AGENT_OPENAI_API_KEY ?? env.OPENAI_API_KEY ?? openAiKeyFromFile,
    agentOpenaiBaseUrl: env.AGENT_OPENAI_BASE_URL,
    agentSecretDir: env.AGENT_SECRET_DIR,
    agentOutboundEnabled: env.AGENT_OUTBOUND_ENABLED,
    agentRepairAttemptLimit: env.AGENT_REPAIR_ATTEMPT_LIMIT,
    agentMaxToolCalls: env.AGENT_MAX_TOOL_CALLS,
    agentMaxRuntimeSec: env.AGENT_MAX_RUNTIME_SEC,
    agentOwnerEmails: parseList(env.AGENT_OWNER_EMAILS),
    agentOwnerSmsEmails: parseList(env.AGENT_OWNER_SMS_EMAILS),
    agentUntrustedReviewSms: env.AGENT_UNTRUSTED_REVIEW_SMS,
    inboundMaxUntrustedPerSenderPerHour: env.INBOUND_MAX_UNTRUSTED_PER_SENDER_PER_HOUR,
    inboundMaxUntrustedNotificationsPerHour: env.INBOUND_MAX_UNTRUSTED_NOTIFICATIONS_PER_HOUR,
    goalsApiBaseUrl: env.GOALS_API_BASE_URL,
    budgetApiBaseUrl: env.BUDGET_API_BASE_URL
  });
  if (settings.appEnv === "production" && settings.postgresPassword === "agent_dev_password") {
    throw new Error("Unsafe production configuration values: POSTGRES_PASSWORD");
  }
  return settings;
}
