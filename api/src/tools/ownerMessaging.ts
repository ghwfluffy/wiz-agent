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
}): Promise<void> {
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
    source: options.source
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
    "Owner-visible outbound message daily guardrail exceeded.",
    details
  );
}

export async function resolveOwnerMessageDestination(options: {
  context: RequestContext;
  store: AgentStore;
  replyToMessage?: Pick<InboundMessageRecord, "fromAddr" | "source" | "subject">;
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
  const smsGateway = configString(ownerContact.config, "sms_gateway");
  if (smsGateway) {
    return { channel: "sms", toAddr: smsGateway, source: "owner-contact" };
  }
  const mmsGateway = configString(ownerContact.config, "mms_gateway");
  if (mmsGateway) {
    return { channel: "mms", toAddr: mmsGateway, source: "owner-contact" };
  }
  const email = configString(ownerContact.config, "email");
  if (email) {
    return { channel: "email", toAddr: email, source: "owner-contact" };
  }
  return undefined;
}

export async function queueOwnerVisibleMessage(options: {
  context: RequestContext;
  store: AgentStore;
  settings?: Settings;
  replyToMessage?: Pick<InboundMessageRecord, "fromAddr" | "source" | "subject">;
  source: string;
  subject?: string | null;
  body: string;
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
    source: options.source
  });
  const message = await options.store.queueOutboundMessage(options.context, {
    channel: destination.channel,
    status: "pending",
    toAddr: destination.toAddr,
    subject: options.subject ?? null,
    bodyText: options.body
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
