import type { Settings } from "../config/settings.js";
import type { AgentStore, RequestContext } from "../domain/types.js";

const SENSITIVE_DETAIL_KEY_PATTERN = /(?:password|passwd|pwd|secret|token|api[_\s-]?key|access[_\s-]?key|private[_\s-]?key|credential|authorization|bearer|cookie|session)/i;
const SENSITIVE_DETAIL_TEXT_PATTERN = /\b(?:password|passwd|pwd|secret|token|api\s*key|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization|bearer|cookie|session)\b/i;
const MAX_SAFETY_DETAIL_STRING_LENGTH = 500;
const MAX_SAFETY_DETAIL_ARRAY_ITEMS = 20;
const MAX_SAFETY_DETAIL_DEPTH = 4;
const RESERVED_GUARDRAIL_DETAIL_KEYS = new Set(["guardrail", "status", "reason", "message"]);

export type RuntimeSafetyPolicy = {
  maxAgentRunsPerUserPerBurstWindow: number;
  agentRunBurstWindowSeconds: number;
  maxAutonomousRunsPerWorkerTick: number;
  maxToolCallsPerRun: number;
  maxOwnerVisibleOutboundMessagesPerUserPerDay: number;
  outboundMessagesPerWorkerTick: number;
  maxUntrustedReviewNotificationsPerSenderPerDay: number;
  maxNewsletterDocumentsPerInterestCheck: number;
  repairAttemptLimit: number;
  maxPromptExcerptChars: number;
  maxContextExcerptChars: number;
};

export const DEFAULT_RUNTIME_SAFETY_POLICY: RuntimeSafetyPolicy = {
  maxAgentRunsPerUserPerBurstWindow: 60,
  agentRunBurstWindowSeconds: 600,
  maxAutonomousRunsPerWorkerTick: 10,
  maxToolCallsPerRun: 10,
  maxOwnerVisibleOutboundMessagesPerUserPerDay: 10,
  outboundMessagesPerWorkerTick: 1,
  maxUntrustedReviewNotificationsPerSenderPerDay: 5,
  maxNewsletterDocumentsPerInterestCheck: 25,
  repairAttemptLimit: 1,
  maxPromptExcerptChars: 500,
  maxContextExcerptChars: 1000
};

function positive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.trunc(value) : fallback;
}

function nonNegative(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value >= 0 ? Math.trunc(value) : fallback;
}

export function runtimeSafetyPolicy(settings?: Partial<Settings>, aiConfig?: {
  maxToolCalls?: number;
  repairAttemptLimit?: number;
}): RuntimeSafetyPolicy {
  return {
    maxAgentRunsPerUserPerBurstWindow: positive(settings?.agentMaxRunsPerUserPerBurstWindow, DEFAULT_RUNTIME_SAFETY_POLICY.maxAgentRunsPerUserPerBurstWindow),
    agentRunBurstWindowSeconds: positive(settings?.agentRunBurstWindowSeconds, DEFAULT_RUNTIME_SAFETY_POLICY.agentRunBurstWindowSeconds),
    maxAutonomousRunsPerWorkerTick: positive(settings?.agentMaxAutonomousRunsPerWorkerTick, DEFAULT_RUNTIME_SAFETY_POLICY.maxAutonomousRunsPerWorkerTick),
    maxToolCallsPerRun: aiConfig?.maxToolCalls !== undefined
      ? nonNegative(aiConfig.maxToolCalls, DEFAULT_RUNTIME_SAFETY_POLICY.maxToolCallsPerRun)
      : positive(settings?.agentMaxToolCalls, DEFAULT_RUNTIME_SAFETY_POLICY.maxToolCallsPerRun),
    maxOwnerVisibleOutboundMessagesPerUserPerDay: positive(settings?.agentMaxOwnerVisibleOutboundMessagesPerUserPerDay, DEFAULT_RUNTIME_SAFETY_POLICY.maxOwnerVisibleOutboundMessagesPerUserPerDay),
    outboundMessagesPerWorkerTick: positive(settings?.agentOutboundMessagesPerWorkerTick, DEFAULT_RUNTIME_SAFETY_POLICY.outboundMessagesPerWorkerTick),
    maxUntrustedReviewNotificationsPerSenderPerDay: positive(settings?.inboundMaxUntrustedReviewNotificationsPerSenderPerDay, DEFAULT_RUNTIME_SAFETY_POLICY.maxUntrustedReviewNotificationsPerSenderPerDay),
    maxNewsletterDocumentsPerInterestCheck: positive(settings?.agentMaxNewsletterDocumentsPerInterestCheck, DEFAULT_RUNTIME_SAFETY_POLICY.maxNewsletterDocumentsPerInterestCheck),
    repairAttemptLimit: nonNegative(aiConfig?.repairAttemptLimit ?? settings?.agentRepairAttemptLimit, DEFAULT_RUNTIME_SAFETY_POLICY.repairAttemptLimit),
    maxPromptExcerptChars: positive(settings?.agentMaxPromptExcerptChars, DEFAULT_RUNTIME_SAFETY_POLICY.maxPromptExcerptChars),
    maxContextExcerptChars: positive(settings?.agentMaxContextExcerptChars, DEFAULT_RUNTIME_SAFETY_POLICY.maxContextExcerptChars)
  };
}

export class GuardrailExceededError extends Error {
  public readonly details: Record<string, unknown>;

  constructor(
    public readonly guardrail: keyof RuntimeSafetyPolicy | string,
    message: string,
    details: Record<string, unknown>
  ) {
    super(message);
    this.name = "GuardrailExceededError";
    this.details = sanitizeGuardrailErrorDetails(details);
  }
}

function sanitizeSafetyDetailValue(value: unknown, depth: number): unknown {
  if (depth >= MAX_SAFETY_DETAIL_DEPTH) {
    return "[redacted]";
  }
  if (typeof value === "string") {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (!normalized) {
      return "";
    }
    if (SENSITIVE_DETAIL_TEXT_PATTERN.test(normalized)) {
      return "[redacted]";
    }
    return normalized.slice(0, MAX_SAFETY_DETAIL_STRING_LENGTH);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_SAFETY_DETAIL_ARRAY_ITEMS)
      .map((item) => sanitizeSafetyDetailValue(item, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        SENSITIVE_DETAIL_KEY_PATTERN.test(key)
          ? "[redacted]"
          : sanitizeSafetyDetailValue(nested, depth + 1)
      ])
    );
  }
  return null;
}

export function sanitizeSafetyAuditDetails(details?: Record<string, unknown> | null): Record<string, unknown> {
  if (!details) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(details).map(([key, value]) => [
      key,
      SENSITIVE_DETAIL_KEY_PATTERN.test(key)
        ? "[redacted]"
        : sanitizeSafetyDetailValue(value, 0)
    ])
  );
}

function sanitizeGuardrailErrorDetails(details: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitizeSafetyAuditDetails(details);
  for (const key of RESERVED_GUARDRAIL_DETAIL_KEYS) {
    delete sanitized[key];
  }
  return sanitized;
}

export async function recordGuardrailExceeded(options: {
  store: AgentStore;
  context: Pick<RequestContext, "userId" | "actorType" | "requestId">;
  guardrail: string;
  entityType?: string | null;
  entityId?: string | null;
  details?: Record<string, unknown>;
}): Promise<void> {
  await options.store.recordAudit(
    options.context,
    "guardrail.exceeded",
    options.entityType ?? null,
    options.entityId ?? null,
    {
      ...sanitizeSafetyAuditDetails(options.details),
      guardrail: options.guardrail
    }
  );
}

export function guardrailResult(error: GuardrailExceededError): Record<string, unknown> {
  return {
    ...sanitizeSafetyAuditDetails(error.details),
    status: "guardrail_exceeded",
    reason: error.guardrail,
    message: error.message
  };
}
