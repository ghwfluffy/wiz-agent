import { cpus, type CpuInfo } from "node:os";
import type { Settings } from "../config/settings.js";
import type {
  AgentStore,
  InboundMessageRecord,
  OutboundMessageRecord,
  RequestContext,
  TaskRecord
} from "../domain/types.js";
import {
  GuardrailExceededError,
  recordGuardrailExceeded,
  runtimeSafetyPolicy
} from "../security/safetyPolicy.js";

export const OWNER_SCHEDULED_MESSAGE_RECURRENCE = "owner-requested scheduled message/v1";

export const MAX_RUNTIME_CPU_MODEL_CHARS = 200;

const OWNER_SCHEDULED_MESSAGE_PROMPT_PREFIX = "OWNER_SCHEDULED_MESSAGE_V1\n";

export type OwnerMessageDestination = {
  channel: "email" | "sms" | "mms";
  toAddr: string;
  source: "inbound_owner_message" | "owner-contact";
};

export type ScheduledOwnerMessagePayload = {
  body: string;
  subject?: string | null;
};

type RuntimeCpuInfo = Pick<CpuInfo, "model">;

export function runtimeCpuModel(cpuInfo?: readonly RuntimeCpuInfo[]): string | null {
  let detectedCpuInfo = cpuInfo;
  if (!detectedCpuInfo) {
    try {
      detectedCpuInfo = cpus();
    } catch {
      return null;
    }
  }
  for (const cpu of detectedCpuInfo) {
    const model = cpu.model
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_RUNTIME_CPU_MODEL_CHARS)
      .trim();
    if (model) {
      return model;
    }
  }
  return null;
}

export function runtimeCpuOwnerMessage(cpuModel: string | null = runtimeCpuModel()): string {
  return cpuModel
    ? `The AI assistant is running on CPU: ${cpuModel}.`
    : "The AI assistant is running on a CPU whose model could not be determined from this runtime.";
}

function configString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function channelFromSource(source: string | null | undefined): "email" | "sms" | "mms" {
  if (source === "sms") {
    return "sms";
  }
  if (source === "mms") {
    return "mms";
  }
  return "email";
}

export async function assertOwnerVisibleOutboundBudget(options: {
  context: RequestContext;
  store: AgentStore;
  settings?: Settings;
  source: string;
  enforceBudget?: boolean;
}): Promise<void> {
  if (options.enforceBudget === false) {
    return;
  }
  const safety = runtimeSafetyPolicy(options.settings);
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const count = await options.store.countOwnerVisibleOutboundMessagesSince(options.context, since);
  if (count < safety.maxOwnerVisibleOutboundMessagesPerUserPerDay) {
    return;
  }
  const details = {
    count,
    limit: safety.maxOwnerVisibleOutboundMessagesPerUserPerDay,
    window_start: since.toISOString(),
    window_seconds: 24 * 60 * 60,
    source: options.source,
    scope: "autonomous_owner_visible_outbound"
  };
  await recordGuardrailExceeded({
    store: options.store,
    context: options.context,
    guardrail: "maxOwnerVisibleOutboundMessagesPerUserPerDay",
    entityType: "outbound_message",
    details
  });
  throw new GuardrailExceededError(
    "maxOwnerVisibleOutboundMessagesPerUserPerDay",
    "Autonomous owner-visible outbound message guardrail exceeded.",
    details
  );
}

export async function resolveOwnerMessageDestination(options: {
  context: RequestContext;
  store: AgentStore;
  replyToMessage?: Pick<InboundMessageRecord, "fromAddr" | "source" | "subject" | "conversationThreadId">;
  preferredChannel?: "email" | "sms" | "mms";
  requirePreferredChannel?: boolean;
}): Promise<OwnerMessageDestination | undefined> {
  const fromAddr = options.replyToMessage?.fromAddr?.trim();
  if (fromAddr && fromAddr.includes("@")) {
    return {
      channel: channelFromSource(options.replyToMessage?.source),
      toAddr: fromAddr,
      source: "inbound_owner_message"
    };
  }

  const ownerContact = await options.store.getConnector(options.context, "owner-contact");
  if (ownerContact?.status !== "enabled") {
    return undefined;
  }
  const destinations: Record<"email" | "sms" | "mms", string | undefined> = {
    email: configString(ownerContact.config, "email"),
    sms: configString(ownerContact.config, "sms_gateway"),
    mms: configString(ownerContact.config, "mms_gateway")
  };
  const preferred = options.preferredChannel;
  if (preferred && destinations[preferred]) {
    return { channel: preferred, toAddr: destinations[preferred], source: "owner-contact" };
  }
  if (preferred && options.requirePreferredChannel) {
    return undefined;
  }
  for (const channel of ["sms", "mms", "email"] as const) {
    if (destinations[channel]) {
      return { channel, toAddr: destinations[channel], source: "owner-contact" };
    }
  }
  return undefined;
}

export async function queueOwnerVisibleMessage(options: {
  context: RequestContext;
  store: AgentStore;
  settings?: Settings;
  replyToMessage?: Pick<InboundMessageRecord, "fromAddr" | "source" | "subject" | "conversationThreadId">;
  source: string;
  ownerInitiated?: boolean;
  subject?: string | null;
  body: string;
  conversationThreadId?: string | null;
  preferredChannel?: "email" | "sms" | "mms";
  requirePreferredChannel?: boolean;
}): Promise<{
  message?: OutboundMessageRecord;
  destination?: OwnerMessageDestination;
  reason?: "owner_reply_destination_unavailable";
}> {
  const destination = await resolveOwnerMessageDestination(options);
  if (!destination) {
    return { reason: "owner_reply_destination_unavailable" };
  }
  await assertOwnerVisibleOutboundBudget({
    context: options.context,
    store: options.store,
    settings: options.settings,
    source: options.source,
    enforceBudget: options.ownerInitiated !== true && options.source !== "scheduled_owner_message"
  });
  const message = await options.store.queueOutboundMessage(options.context, {
    channel: destination.channel,
    status: "pending",
    toAddr: destination.toAddr,
    subject: options.subject ?? null,
    bodyText: options.body,
    conversationThreadId: options.conversationThreadId ?? options.replyToMessage?.conversationThreadId ?? null
  });
  return { message, destination };
}

export function scheduledOwnerMessagePrompt(payload: ScheduledOwnerMessagePayload): string {
  return `${OWNER_SCHEDULED_MESSAGE_PROMPT_PREFIX}${JSON.stringify({
    body: payload.body,
    subject: payload.subject ?? null
  })}`;
}

export function parseScheduledOwnerMessageTask(task: TaskRecord): ScheduledOwnerMessagePayload | undefined {
  if (task.recurrencePolicy !== OWNER_SCHEDULED_MESSAGE_RECURRENCE) {
    return undefined;
  }
  if (!task.prompt.startsWith(OWNER_SCHEDULED_MESSAGE_PROMPT_PREFIX)) {
    return undefined;
  }
  const raw = task.prompt.slice(OWNER_SCHEDULED_MESSAGE_PROMPT_PREFIX.length);
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (typeof parsed.body !== "string" || !parsed.body.trim()) {
    return undefined;
  }
  return {
    body: parsed.body,
    subject: typeof parsed.subject === "string" && parsed.subject.trim() ? parsed.subject : null
  };
}
