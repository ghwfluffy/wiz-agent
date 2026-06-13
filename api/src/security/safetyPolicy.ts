import type { Settings } from "../config/settings.js";
import type { AgentStore, RequestContext } from "../domain/types.js";

export type RuntimeSafetyPolicy = {
  maxAgentRunsPerUserPerHour: number;
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
  maxAgentRunsPerUserPerHour: 20,
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
    maxAgentRunsPerUserPerHour: positive(settings?.agentMaxRunsPerUserPerHour, DEFAULT_RUNTIME_SAFETY_POLICY.maxAgentRunsPerUserPerHour),
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
  constructor(
    public readonly guardrail: keyof RuntimeSafetyPolicy | string,
    message: string,
    public readonly details: Record<string, unknown>
  ) {
    super(message);
    this.name = "GuardrailExceededError";
  }
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
      guardrail: options.guardrail,
      ...(options.details ?? {})
    }
  );
}

export function guardrailResult(error: GuardrailExceededError): Record<string, unknown> {
  return {
    status: "guardrail_exceeded",
    reason: error.guardrail,
    message: error.message,
    ...error.details
  };
}
