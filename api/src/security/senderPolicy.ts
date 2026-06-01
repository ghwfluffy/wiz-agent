import type { Settings } from "../config/settings.js";
import type {
  AgentStore,
  InboundHandlingResult,
  InboundMessageInput,
  InboundMessageRecord,
  RequestContext,
  SenderClassification
} from "../domain/types.js";

function normalizeAddress(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const match = trimmed.match(/<([^>]+)>/);
  return match?.[1]?.trim().toLowerCase() ?? trimmed;
}

export type InboundRateLimiter = {
  allow(senderAddress: string, now?: Date): boolean;
};

export class SlidingWindowRateLimiter implements InboundRateLimiter {
  private readonly events = new Map<string, number[]>();

  constructor(
    private readonly maxPerKey: number,
    private readonly windowMs: number
  ) {}

  allow(senderAddress: string, now = new Date()): boolean {
    const key = normalizeAddress(senderAddress);
    const cutoff = now.getTime() - this.windowMs;
    const current = (this.events.get(key) ?? []).filter((timestamp) => timestamp >= cutoff);
    if (current.length >= this.maxPerKey) {
      this.events.set(key, current);
      return false;
    }
    current.push(now.getTime());
    this.events.set(key, current);
    return true;
  }
}

export function summarizeUntrustedMessage(message: InboundMessageInput): string {
  const subject = message.subject?.trim() || "(no subject)";
  const firstLine = message.bodyText.replace(/\s+/g, " ").trim().slice(0, 240);
  return `Untrusted sender ${normalizeAddress(message.fromAddr)} sent "${subject}". Summary: ${firstLine || "No body text."}`;
}

export async function classifySender(
  options: {
    context: RequestContext;
    settings: Settings;
    store: AgentStore;
    fromAddr: string;
  }
): Promise<SenderClassification> {
  const from = normalizeAddress(options.fromAddr);
  const owners = [...options.settings.agentOwnerEmails, ...options.settings.agentOwnerSmsEmails].map(normalizeAddress);
  if (owners.includes(from)) {
    return "owner";
  }
  const storedStatus = await options.store.getSenderStatus(options.context, from);
  if (storedStatus === "blocked") {
    return "blocked";
  }
  if (storedStatus === "newsletter") {
    return "newsletter";
  }
  return "untrusted";
}

export async function handleInboundMessage(
  options: {
    context: RequestContext;
    settings: Settings;
    store: AgentStore;
    message: InboundMessageInput;
    rateLimiter: InboundRateLimiter;
    ownerAgentRunner?: (message: InboundMessageRecord) => Promise<{
      runId?: string;
      taskId?: string;
      taskEventId?: string;
    }>;
  }
): Promise<InboundHandlingResult> {
  const classification = await classifySender({
    context: options.context,
    settings: options.settings,
    store: options.store,
    fromAddr: options.message.fromAddr
  });
  const recorded = await options.store.recordInboundMessage(options.context, options.message, classification);
  if (recorded.duplicate) {
    return {
      classification,
      action: "rate_limited",
      messageId: recorded.id
    };
  }
  if (classification === "blocked") {
    await options.store.updateInboundMessageHandling(options.context, recorded.id, {
      action: "blocked"
    });
    return {
      classification,
      action: "blocked",
      messageId: recorded.id
    };
  }
  if (classification === "owner") {
    const agentResult = await options.ownerAgentRunner?.(recorded);
    let taskEventId = agentResult?.taskEventId;
    if (agentResult?.taskId) {
      const event = await options.store.recordTaskEvent(options.context, agentResult.taskId, "message.inbound.assigned", {
        message_id: recorded.id,
        from_addr: options.message.fromAddr,
        source: options.message.source ?? "imap",
        subject: options.message.subject ?? null,
        summary: "Inbound owner message assigned to this task."
      });
      taskEventId = event.id;
    }
    await options.store.updateInboundMessageHandling(options.context, recorded.id, {
      action: "routed_to_agent",
      taskId: agentResult?.taskId ?? null,
      taskEventId: taskEventId ?? null,
      agentRunId: agentResult?.runId ?? null
    });
    return {
      classification,
      action: "routed_to_agent",
      messageId: recorded.id,
      taskId: agentResult?.taskId,
      taskEventId,
      agentRunId: agentResult?.runId
    };
  }
  if (classification === "newsletter") {
    await options.store.updateInboundMessageHandling(options.context, recorded.id, {
      action: "accepted_newsletter"
    });
    return {
      classification,
      action: "accepted_newsletter",
      messageId: recorded.id
    };
  }
  if (!options.rateLimiter.allow(options.message.fromAddr)) {
    await options.store.updateInboundMessageHandling(options.context, recorded.id, {
      action: "rate_limited"
    });
    return {
      classification,
      action: "rate_limited",
      messageId: recorded.id
    };
  }
  if (!options.settings.agentUntrustedReviewSms) {
    await options.store.updateInboundMessageHandling(options.context, recorded.id, {
      action: "queued_owner_review"
    });
    return {
      classification,
      action: "queued_owner_review",
      messageId: recorded.id
    };
  }
  const outbound = await options.store.queueOutboundMessage(options.context, {
    channel: "sms",
    status: "requires_approval",
    toAddr: options.settings.agentUntrustedReviewSms,
    bodyText: summarizeUntrustedMessage(options.message)
  });
  await options.store.updateInboundMessageHandling(options.context, recorded.id, {
    action: "queued_owner_review",
    outboundMessageId: outbound.id
  });
  return {
    classification,
    action: "queued_owner_review",
    messageId: recorded.id,
    outboundMessageId: outbound.id
  };
}
