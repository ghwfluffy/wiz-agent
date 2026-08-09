import { readFileSync } from "node:fs";
import { z } from "zod";
import type { AiConfig } from "../domain/types.js";

export const DEFAULT_AI_TOOL_CALLS = 50;
export const MAX_AI_TOOL_CALLS = 50;
export const DEFAULT_AI_RUNTIME_SEC = 500;
export const MAX_AI_RUNTIME_SEC = 500;
export const DEFAULT_AI_REPAIR_ATTEMPT_LIMIT = 1;
export const MAX_AI_REPAIR_ATTEMPT_LIMIT = 5;

const pathPattern = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/;
const modelIdPattern = /^[A-Za-z0-9._:/-]+$/;
const unsafeProductionHostnames = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

function nonBlank(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

const EnvBooleanSchema = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return value;
}, z.boolean());

const EmailAddressSchema = z.preprocess((value) => {
  return typeof value === "string" ? value.trim().toLowerCase() : value;
}, z.string().email());

function parseList(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const values = Array.isArray(value)
    ? value.map(String)
    : typeof value === "string"
      ? value.split(",")
      : [];
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}

function boundedInteger(minimum: number, maximum: number) {
  return z.coerce.number().int().min(minimum).max(maximum);
}

function safeUrl(value: string, options: { hostOnly?: boolean } = {}): boolean {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) {
      return false;
    }
    if (url.username || url.password) {
      return false;
    }
    if (options.hostOnly && !["", "/"].includes(url.pathname)) {
      return false;
    }
    if (options.hostOnly && (url.search || url.hash)) {
      return false;
    }
    return Boolean(url.hostname);
  } catch {
    return false;
  }
}

const HostOnlyUrlSchema = z.string().trim().url().refine((value) => safeUrl(value, { hostOnly: true }), {
  message: "must be an http(s) URL with scheme and host only"
});

const OptionalServiceUrlSchema = z.string().trim().default("").refine((value) => value === "" || safeUrl(value), {
  message: "must be an http(s) URL without embedded credentials"
});

const RequiredServiceUrlSchema = z.string().trim().url().refine((value) => safeUrl(value), {
  message: "must be an http(s) URL without embedded credentials"
});

const FilesystemPathSchema = z.string().trim().min(1).max(4096).refine((value) => !value.includes("\0"), {
  message: "must not contain null bytes"
});

const CookieNameSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/, {
  message: "must contain only letters, numbers, dots, underscores, or hyphens"
});

export const AiModelIdSchema = z.string()
  .trim()
  .min(1)
  .max(128)
  .regex(modelIdPattern, "must contain only model-id characters");

const SettingsSchema = z.object({
  appEnv: z.enum(["development", "test", "production"]).default("development"),
  appVersion: z.string().trim().min(1).max(64).default("0.1.0"),
  authMode: z.enum(["standalone", "oauth"]).default("standalone"),
  authBaseUrl: z.string().default("/auth"),
  oauthServerBaseUrl: OptionalServiceUrlSchema,
  oauthClientId: z.string().trim().min(1).max(128).default("agent"),
  oauthScope: z.string().trim().min(1).max(512).default("openid profile"),
  appBasePath: z.string().default(""),
  publicUrl: HostOnlyUrlSchema.default("http://localhost:18081"),
  postgresUser: z.string().trim().min(1).max(128).default("agent"),
  postgresPassword: z.string().min(1).max(512).default("agent_dev_password"),
  postgresDb: z.string().trim().min(1).max(128).default("agent"),
  postgresHost: z.string().trim().min(1).max(255).default("localhost"),
  postgresPort: boundedInteger(1, 65535).default(5432),
  sessionCookieName: CookieNameSchema.default("agent_session"),
  sessionCookiePath: z.string().default("/"),
  sessionDurationMinutes: boundedInteger(1, 43_200).default(1440),
  devUserId: z.string().trim().min(1).max(128).default("dev-user"),
  devUserEmail: EmailAddressSchema.default("dev@example.test"),
  devUserDisplayName: z.string().trim().min(1).max(128).default("Development User"),
  devUserIsAdmin: EnvBooleanSchema.default(true),
  agentOpenaiModelFast: AiModelIdSchema.default("gpt-5-mini"),
  agentOpenaiModelSmart: AiModelIdSchema.default("gpt-5"),
  agentOpenaiModelOrchestrator: AiModelIdSchema.default("gpt-5"),
  agentOpenaiModelRepair: AiModelIdSchema.default("gpt-5-mini"),
  agentOpenaiTranscriptionModel: AiModelIdSchema.default("gpt-4o-transcribe"),
  agentOpenaiApiKey: z.string().trim().default(""),
  agentOpenaiBaseUrl: RequiredServiceUrlSchema.default("https://api.openai.com/v1"),
  agentModelApiKey: z.string().trim().default(""),
  agentModelBaseUrl: RequiredServiceUrlSchema.default("https://api.openai.com/v1"),
  modelGatewayAlertToken: z.string().trim().default(""),
  omniDevEventToken: z.string().trim().default(""),
  agentSecretDir: FilesystemPathSchema.default("secrets"),
  agentVoiceMaxAudioBytes: boundedInteger(1, 50 * 1024 * 1024).default(25 * 1024 * 1024),
  agentOutboundEnabled: EnvBooleanSchema.default(false),
  agentRepairAttemptLimit: boundedInteger(0, MAX_AI_REPAIR_ATTEMPT_LIMIT).default(DEFAULT_AI_REPAIR_ATTEMPT_LIMIT),
  agentMaxToolCalls: boundedInteger(1, MAX_AI_TOOL_CALLS).default(DEFAULT_AI_TOOL_CALLS),
  agentMaxRuntimeSec: boundedInteger(1, MAX_AI_RUNTIME_SEC).default(DEFAULT_AI_RUNTIME_SEC),
  agentMaxRunsPerUserPerBurstWindow: boundedInteger(1, 10_000).default(60),
  agentRunBurstWindowSeconds: boundedInteger(1, 86_400).default(600),
  agentMaxAutonomousRunsPerWorkerTick: boundedInteger(1, 100).default(10),
  agentMaxOwnerVisibleOutboundMessagesPerUserPerDay: boundedInteger(1, 100).default(10),
  agentOutboundMessagesPerWorkerTick: boundedInteger(1, 100).default(1),
  agentMaxNewsletterDocumentsPerInterestCheck: boundedInteger(1, 100).default(25),
  agentMaxPromptExcerptChars: boundedInteger(1, 20_000).default(500),
  agentMaxContextExcerptChars: boundedInteger(1, 50_000).default(1000),
  agentOwnerEmails: z.array(EmailAddressSchema).default([]),
  agentOwnerSmsEmails: z.array(EmailAddressSchema).default([]),
  agentUntrustedReviewSms: z.string().trim().default(""),
  inboundMaxUntrustedPerSenderPerHour: boundedInteger(1, 10_000).default(3),
  inboundMaxUntrustedNotificationsPerHour: boundedInteger(1, 10_000).default(10),
  inboundMaxUntrustedReviewNotificationsPerSenderPerDay: boundedInteger(1, 10_000).default(5),
  agentIntegrationTokenSecret: z.string().trim().default(""),
  goalsApiBaseUrl: OptionalServiceUrlSchema,
  budgetApiBaseUrl: OptionalServiceUrlSchema,
  apartmentGateApiBaseUrl: OptionalServiceUrlSchema,
  omniDevApiBaseUrl: OptionalServiceUrlSchema,
  qdrantUrl: RequiredServiceUrlSchema.default("http://localhost:6333"),
  ragEmbeddingModel: AiModelIdSchema.default("text-embedding-3-small"),
  ragEmbeddingDimensions: boundedInteger(1, 4096).default(1536),
  ragIndexBatchSize: boundedInteger(1, 500).default(10),
  mcpServerPort: boundedInteger(1, 65535).default(8010)
});

export type Settings = z.infer<typeof SettingsSchema>;

export type AiConfigValidationResult =
  | { ok: true; config: AiConfig }
  | { ok: false; message: string };

export function normalizeBasePath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "/") {
    return "";
  }
  if (trimmed.includes("://") || trimmed.startsWith("//") || /[\s?#\\]/.test(trimmed)) {
    throw new Error("Base paths must be path prefixes, not URLs or query strings.");
  }

  const prefixed = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const normalized = prefixed.endsWith("/") ? prefixed.slice(0, -1) : prefixed;
  if (!pathPattern.test(normalized)) {
    throw new Error("Base paths contain unsupported characters.");
  }
  if (normalized.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error("Base paths must not contain dot segments.");
  }
  return normalized;
}

function normalizeCookiePath(value: string): string {
  return normalizeBasePath(value) || "/";
}

function productionHostIsUnsafe(publicUrl: string): boolean {
  const hostname = new URL(publicUrl).hostname.toLowerCase();
  return unsafeProductionHostnames.has(hostname);
}

function readSecretFile(path: string | undefined): string | undefined {
  const secretPath = nonBlank(path);
  return secretPath ? readFileSync(secretPath, "utf8").trim() : undefined;
}

export function defaultAiConfig(settings?: Partial<Settings>): AiConfig {
  const maxToolCalls = settings?.agentMaxToolCalls ?? DEFAULT_AI_TOOL_CALLS;
  return {
    fastModel: settings?.agentOpenaiModelFast ?? "gpt-5-mini",
    smartModel: settings?.agentOpenaiModelSmart ?? "gpt-5",
    orchestratorModel: settings?.agentOpenaiModelOrchestrator ?? "gpt-5",
    repairModel: settings?.agentOpenaiModelRepair ?? "gpt-5-mini",
    maxToolCalls,
    maxRuntimeSec: settings?.agentMaxRuntimeSec ?? DEFAULT_AI_RUNTIME_SEC,
    repairAttemptLimit: Math.min(
      maxToolCalls,
      settings?.agentRepairAttemptLimit ?? DEFAULT_AI_REPAIR_ATTEMPT_LIMIT
    )
  };
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) ? value : undefined;
}

function validatedModelId(value: unknown): string | undefined {
  const parsed = AiModelIdSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function validateAiConfig(config: unknown): AiConfigValidationResult {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { ok: false, message: "AI config must be an object." };
  }
  const input = config as Partial<AiConfig>;
  const models = [
    ["fastModel", input.fastModel],
    ["smartModel", input.smartModel],
    ["orchestratorModel", input.orchestratorModel],
    ["repairModel", input.repairModel]
  ] as const;
  const parsedModels = new Map<keyof Pick<AiConfig, "fastModel" | "smartModel" | "orchestratorModel" | "repairModel">, string>();
  for (const [key, value] of models) {
    const parsed = validatedModelId(value);
    if (!parsed) {
      return { ok: false, message: `${key} must be a valid model identifier.` };
    }
    parsedModels.set(key, parsed);
  }

  const maxToolCalls = finiteInteger(input.maxToolCalls);
  if (maxToolCalls === undefined || maxToolCalls < 1 || maxToolCalls > MAX_AI_TOOL_CALLS) {
    return { ok: false, message: `maxToolCalls must be an integer from 1 to ${MAX_AI_TOOL_CALLS}.` };
  }

  const maxRuntimeSec = finiteInteger(input.maxRuntimeSec);
  if (maxRuntimeSec === undefined || maxRuntimeSec < 1 || maxRuntimeSec > MAX_AI_RUNTIME_SEC) {
    return { ok: false, message: `maxRuntimeSec must be an integer from 1 to ${MAX_AI_RUNTIME_SEC}.` };
  }

  const repairAttemptLimit = finiteInteger(input.repairAttemptLimit);
  if (
    repairAttemptLimit === undefined ||
    repairAttemptLimit < 0 ||
    repairAttemptLimit > MAX_AI_REPAIR_ATTEMPT_LIMIT
  ) {
    return { ok: false, message: `repairAttemptLimit must be an integer from 0 to ${MAX_AI_REPAIR_ATTEMPT_LIMIT}.` };
  }
  if (repairAttemptLimit > maxToolCalls) {
    return { ok: false, message: "repairAttemptLimit cannot exceed maxToolCalls." };
  }

  return {
    ok: true,
    config: {
      fastModel: parsedModels.get("fastModel") ?? "",
      smartModel: parsedModels.get("smartModel") ?? "",
      orchestratorModel: parsedModels.get("orchestratorModel") ?? "",
      repairModel: parsedModels.get("repairModel") ?? "",
      maxToolCalls,
      maxRuntimeSec,
      repairAttemptLimit
    }
  };
}

function clampInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const parsed = finiteInteger(value);
  if (parsed === undefined) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, parsed));
}

export function normalizePersistedAiConfig(config: unknown, defaults: AiConfig = defaultAiConfig()): AiConfig {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return defaults;
  }
  const input = config as Partial<AiConfig>;
  const maxToolCalls = clampInteger(input.maxToolCalls, 1, MAX_AI_TOOL_CALLS, defaults.maxToolCalls);
  const repairAttemptLimit = Math.min(
    maxToolCalls,
    clampInteger(input.repairAttemptLimit, 0, MAX_AI_REPAIR_ATTEMPT_LIMIT, defaults.repairAttemptLimit)
  );
  return {
    fastModel: validatedModelId(input.fastModel) ?? defaults.fastModel,
    smartModel: validatedModelId(input.smartModel) ?? defaults.smartModel,
    orchestratorModel: validatedModelId(input.orchestratorModel) ?? defaults.orchestratorModel,
    repairModel: validatedModelId(input.repairModel) ?? defaults.repairModel,
    maxToolCalls,
    maxRuntimeSec: clampInteger(input.maxRuntimeSec, 1, MAX_AI_RUNTIME_SEC, defaults.maxRuntimeSec),
    repairAttemptLimit
  };
}

function validateProductionSettings(settings: Settings): void {
  const unsafe: string[] = [];
  if (settings.authMode === "standalone") {
    unsafe.push("AUTH_MODE");
  }
  if (!settings.oauthServerBaseUrl) {
    unsafe.push("OAUTH_SERVER_BASE_URL");
  }
  if (settings.postgresPassword === "agent_dev_password") {
    unsafe.push("POSTGRES_PASSWORD");
  }
  if (productionHostIsUnsafe(settings.publicUrl)) {
    unsafe.push("PUBLIC_URL");
  }
  if (settings.appBasePath && settings.sessionCookiePath === "/") {
    unsafe.push("SESSION_COOKIE_PATH");
  }
  if (settings.agentOwnerEmails.includes("dev@example.test")) {
    unsafe.push("AGENT_OWNER_EMAILS");
  }
  if (
    (settings.goalsApiBaseUrl || settings.budgetApiBaseUrl || settings.apartmentGateApiBaseUrl || settings.omniDevApiBaseUrl) &&
    !settings.agentIntegrationTokenSecret
  ) {
    unsafe.push("AGENT_INTEGRATION_TOKEN_SECRET");
  }
  if (settings.omniDevApiBaseUrl && settings.omniDevEventToken.length < 32) {
    unsafe.push("OMNI_DEV_EVENT_TOKEN");
  }
  if (unsafe.length > 0) {
    throw new Error(`Unsafe production configuration values: ${unsafe.join(", ")}`);
  }
}

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const openAiKeyFromFile = readSecretFile(env.AGENT_OPENAI_API_KEY_FILE);
  const modelKeyFromFile = readSecretFile(env.AGENT_MODEL_API_KEY_FILE);
  const ownerEmailEnvProvided = env.AGENT_OWNER_EMAILS !== undefined;
  const parsed = SettingsSchema.parse({
    appEnv: nonBlank(env.APP_ENV),
    appVersion: nonBlank(env.APP_VERSION),
    authMode: nonBlank(env.AUTH_MODE),
    authBaseUrl: normalizeBasePath(env.AUTH_BASE_URL ?? "/auth"),
    oauthServerBaseUrl: nonBlank(env.OAUTH_SERVER_BASE_URL),
    oauthClientId: nonBlank(env.OAUTH_CLIENT_ID),
    oauthScope: nonBlank(env.OAUTH_SCOPE),
    appBasePath: normalizeBasePath(env.APP_BASE_PATH ?? ""),
    publicUrl: nonBlank(env.PUBLIC_URL),
    postgresUser: nonBlank(env.POSTGRES_USER),
    postgresPassword: nonBlank(env.POSTGRES_PASSWORD),
    postgresDb: nonBlank(env.POSTGRES_DB),
    postgresHost: nonBlank(env.POSTGRES_HOST),
    postgresPort: nonBlank(env.POSTGRES_PORT),
    sessionCookieName: nonBlank(env.SESSION_COOKIE_NAME),
    sessionCookiePath: normalizeCookiePath(env.SESSION_COOKIE_PATH ?? "/"),
    sessionDurationMinutes: nonBlank(env.SESSION_DURATION_MINUTES),
    devUserId: nonBlank(env.DEV_USER_ID),
    devUserEmail: nonBlank(env.DEV_USER_EMAIL),
    devUserDisplayName: nonBlank(env.DEV_USER_DISPLAY_NAME),
    devUserIsAdmin: nonBlank(env.DEV_USER_IS_ADMIN),
    agentOpenaiModelFast: nonBlank(env.AGENT_OPENAI_MODEL_FAST),
    agentOpenaiModelSmart: nonBlank(env.AGENT_OPENAI_MODEL_SMART),
    agentOpenaiModelOrchestrator: nonBlank(env.AGENT_OPENAI_MODEL_ORCHESTRATOR),
    agentOpenaiModelRepair: nonBlank(env.AGENT_OPENAI_MODEL_REPAIR),
    agentOpenaiTranscriptionModel: nonBlank(env.AGENT_OPENAI_TRANSCRIPTION_MODEL),
    agentOpenaiApiKey: nonBlank(env.AGENT_OPENAI_API_KEY) ?? nonBlank(env.OPENAI_API_KEY) ?? openAiKeyFromFile,
    agentOpenaiBaseUrl: nonBlank(env.AGENT_OPENAI_BASE_URL),
    agentModelApiKey: nonBlank(env.AGENT_MODEL_API_KEY) ?? modelKeyFromFile
      ?? nonBlank(env.AGENT_OPENAI_API_KEY) ?? nonBlank(env.OPENAI_API_KEY) ?? openAiKeyFromFile,
    agentModelBaseUrl: nonBlank(env.AGENT_MODEL_BASE_URL) ?? nonBlank(env.AGENT_OPENAI_BASE_URL),
    modelGatewayAlertToken: nonBlank(env.MODEL_GATEWAY_ALERT_TOKEN) ?? readSecretFile(env.MODEL_GATEWAY_ALERT_TOKEN_FILE),
    omniDevEventToken: nonBlank(env.OMNI_DEV_EVENT_TOKEN) ?? readSecretFile(env.OMNI_DEV_EVENT_TOKEN_FILE),
    agentSecretDir: nonBlank(env.AGENT_SECRET_DIR),
    agentVoiceMaxAudioBytes: nonBlank(env.AGENT_VOICE_MAX_AUDIO_BYTES),
    agentOutboundEnabled: nonBlank(env.AGENT_OUTBOUND_ENABLED),
    agentRepairAttemptLimit: nonBlank(env.AGENT_REPAIR_ATTEMPT_LIMIT),
    agentMaxToolCalls: nonBlank(env.AGENT_MAX_TOOL_CALLS),
    agentMaxRuntimeSec: nonBlank(env.AGENT_MAX_RUNTIME_SEC),
    agentMaxRunsPerUserPerBurstWindow: nonBlank(env.AGENT_MAX_RUNS_PER_USER_PER_BURST_WINDOW ?? env.AGENT_MAX_RUNS_PER_USER_PER_HOUR),
    agentRunBurstWindowSeconds: nonBlank(env.AGENT_RUN_BURST_WINDOW_SECONDS),
    agentMaxAutonomousRunsPerWorkerTick: nonBlank(env.AGENT_MAX_AUTONOMOUS_RUNS_PER_WORKER_TICK),
    agentMaxOwnerVisibleOutboundMessagesPerUserPerDay: nonBlank(env.AGENT_MAX_OWNER_VISIBLE_OUTBOUND_MESSAGES_PER_USER_PER_DAY),
    agentOutboundMessagesPerWorkerTick: nonBlank(env.AGENT_OUTBOUND_MESSAGES_PER_WORKER_TICK),
    agentMaxNewsletterDocumentsPerInterestCheck: nonBlank(env.AGENT_MAX_NEWSLETTER_DOCUMENTS_PER_INTEREST_CHECK),
    agentMaxPromptExcerptChars: nonBlank(env.AGENT_MAX_PROMPT_EXCERPT_CHARS),
    agentMaxContextExcerptChars: nonBlank(env.AGENT_MAX_CONTEXT_EXCERPT_CHARS),
    agentOwnerEmails: parseList(env.AGENT_OWNER_EMAILS),
    agentOwnerSmsEmails: parseList(env.AGENT_OWNER_SMS_EMAILS),
    agentUntrustedReviewSms: nonBlank(env.AGENT_UNTRUSTED_REVIEW_SMS),
    inboundMaxUntrustedPerSenderPerHour: nonBlank(env.INBOUND_MAX_UNTRUSTED_PER_SENDER_PER_HOUR),
    inboundMaxUntrustedNotificationsPerHour: nonBlank(env.INBOUND_MAX_UNTRUSTED_NOTIFICATIONS_PER_HOUR),
    inboundMaxUntrustedReviewNotificationsPerSenderPerDay: nonBlank(env.INBOUND_MAX_UNTRUSTED_REVIEW_NOTIFICATIONS_PER_SENDER_PER_DAY),
    agentIntegrationTokenSecret: nonBlank(env.AGENT_INTEGRATION_TOKEN_SECRET),
    goalsApiBaseUrl: nonBlank(env.GOALS_API_BASE_URL),
    budgetApiBaseUrl: nonBlank(env.BUDGET_API_BASE_URL),
    apartmentGateApiBaseUrl: nonBlank(env.APARTMENT_GATE_API_BASE_URL),
    omniDevApiBaseUrl: nonBlank(env.OMNI_DEV_API_BASE_URL),
    qdrantUrl: nonBlank(env.QDRANT_URL),
    ragEmbeddingModel: nonBlank(env.RAG_EMBEDDING_MODEL),
    ragEmbeddingDimensions: nonBlank(env.RAG_EMBEDDING_DIMENSIONS),
    ragIndexBatchSize: nonBlank(env.RAG_INDEX_BATCH_SIZE),
    mcpServerPort: nonBlank(env.MCP_SERVER_PORT)
  });
  const settings: Settings = {
    ...parsed,
    agentOwnerEmails: parsed.agentOwnerEmails.length > 0
      ? parsed.agentOwnerEmails
      : !ownerEmailEnvProvided && parsed.appEnv !== "production"
        ? [parsed.devUserEmail]
        : []
  };
  if (settings.agentRepairAttemptLimit > settings.agentMaxToolCalls) {
    throw new Error("AGENT_REPAIR_ATTEMPT_LIMIT cannot exceed AGENT_MAX_TOOL_CALLS.");
  }
  if (settings.appEnv === "production") {
    validateProductionSettings(settings);
  }
  return settings;
}
