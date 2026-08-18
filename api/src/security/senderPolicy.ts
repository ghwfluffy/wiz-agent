import type { Settings } from "../config/settings.js";
import { classifyOwnerMessageIntent, type OwnerIntentEnvelope } from "../agent/ownerIntentClassifier.js";
import type {
  AgentStore,
  InboundHandlingResult,
  InboundMessageInput,
  InboundMessageRecord,
  OutboundMessageRecord,
  RequestContext,
  SenderClassification
} from "../domain/types.js";
import { integrateTrustedMessageIntoMemory } from "../memory/personalMemory.js";
import { handleOwnerApprovalCommand } from "./approvalPolicy.js";
import { appendNewsletterKnowledge, handleOwnerNewsletterReply } from "./newsletterPolicy.js";

export function normalizeAddress(value: string): string {
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
  return [
    `Untrusted sender ${normalizeAddress(message.fromAddr)} sent "${subject}".`,
    `Summary: ${firstLine || "No body text."}`,
    "Reply YES to trust as a newsletter, NO to block, or ONCE to review only this message."
  ].join(" ");
}

function configString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function resolveOwnerReviewTarget(options: {
  context: RequestContext;
  settings: Settings;
  store: AgentStore;
}): Promise<{ channel: "email" | "sms" | "mms"; toAddr: string; source: "owner-contact" | "settings" } | undefined> {
  const ownerContact = await options.store.getConnector(options.context, "owner-contact");
  if (ownerContact?.status === "enabled") {
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
  }
  if (options.settings.agentUntrustedReviewSms.trim()) {
    return { channel: "sms", toAddr: options.settings.agentUntrustedReviewSms.trim(), source: "settings" };
  }
  return undefined;
}

export async function queueOwnerReviewNotification(options: {
  context: RequestContext;
  settings: Settings;
  store: AgentStore;
  message: InboundMessageInput;
}): Promise<OutboundMessageRecord | undefined> {
  const target = await resolveOwnerReviewTarget(options);
  if (!target) {
    return undefined;
  }
  return options.store.queueOutboundMessage(options.context, {
    channel: target.channel,
    status: "pending",
    toAddr: target.toAddr,
    bodyText: summarizeUntrustedMessage(options.message),
    origin: "sender_review_notification",
    isProactive: false
  });
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
  if (storedStatus === "owner") {
    return "owner";
  }
  if (storedStatus === "blocked") {
    return "blocked";
  }
  if (storedStatus === "newsletter") {
    return "newsletter";
  }
  if (storedStatus === "trusted") {
    return "trusted";
  }
  return "untrusted";
}

async function ownerHandlingStartEvidence(options: {
  context: RequestContext;
  store: AgentStore;
  message: InboundMessageRecord;
}): Promise<{
  started: boolean;
  linkedThreadId: string | null;
  linkedFields: string[];
}> {
  const linkedFields = [
    ["conversation_thread_id", options.message.conversationThreadId],
    ["task_id", options.message.taskId],
    ["task_event_id", options.message.taskEventId],
    ["agent_run_id", options.message.agentRunId],
    ["outbound_message_id", options.message.outboundMessageId]
  ]
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0)
    .map(([name]) => name);
  if (linkedFields.length > 0) {
    return {
      started: true,
      linkedThreadId: options.message.conversationThreadId,
      linkedFields
    };
  }

  // The production owner runner creates or links the conversation thread before
  // it asks the model to act. That durable message link is therefore the earliest
  // available boundary proving a retry could duplicate an owner-authorized side effect.
  const linkedThread = (await options.store.listConversationThreads(options.context, undefined, 100))
    .find((thread) => thread.linkedMessageIds.includes(options.message.id));
  return {
    started: Boolean(linkedThread),
    linkedThreadId: linkedThread?.id ?? null,
    linkedFields
  };
}

export async function handleInboundMessage(
  options: {
    context: RequestContext;
    settings: Settings;
    store: AgentStore;
    message: InboundMessageInput;
    rateLimiter: InboundRateLimiter;
    ownerAgentRunner?: (message: InboundMessageRecord, ownerIntent: OwnerIntentEnvelope) => Promise<{
      runId?: string;
      conversationThreadId?: string;
      taskId?: string;
      taskEventId?: string;
      outboundMessageId?: string;
    }>;
    memoryIntegrator?: (message: InboundMessageRecord) => Promise<{
      integrated: boolean;
      updatedSlugs: string[];
      mode: string;
    }>;
  }
): Promise<InboundHandlingResult> {
  let classification = await classifySender({
    context: options.context,
    settings: options.settings,
    store: options.store,
    fromAddr: options.message.fromAddr
  });
  const recorded = await options.store.recordInboundMessage(options.context, options.message, classification);
  if (recorded.duplicate) {
    if (recorded.handlingAction === null && recorded.classification === "owner") {
      const startEvidence = await ownerHandlingStartEvidence({
        context: options.context,
        store: options.store,
        message: recorded
      });
      if (startEvidence.started) {
        await options.store.recordAudit(
          options.context,
          "message.inbound.recovery_required",
          "message",
          recorded.id,
          {
            classification: recorded.classification,
            provider_message_id: recorded.providerMessageId,
            reason: "owner_processing_start_is_ambiguous",
            linked_thread_id: startEvidence.linkedThreadId,
            linked_fields: startEvidence.linkedFields
          }
        );
        return {
          classification: recorded.classification,
          action: "duplicate",
          messageId: recorded.id
        };
      }
    }
    const resumablePartial = recorded.handlingAction === null
      && ["owner", "trusted", "newsletter"].includes(recorded.classification);
    if (resumablePartial) {
      classification = recorded.classification;
      await options.store.recordAudit(options.context, "message.inbound.resume", "message", recorded.id, {
        classification: recorded.classification,
        provider_message_id: recorded.providerMessageId
      });
    } else {
      return {
        classification: recorded.classification,
        action: "duplicate",
        messageId: recorded.id
      };
    }
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
  if (classification === "trusted") {
    await (options.memoryIntegrator ?? ((message) => integrateTrustedMessageIntoMemory({
      store: options.store,
      context: options.context,
      message
    })))(recorded);
  }
  if (classification === "owner") {
    const newsletterReply = await handleOwnerNewsletterReply({
      store: options.store,
      context: options.context,
      message: recorded
    });
    if (newsletterReply) {
      return newsletterReply;
    }
    const approvalReply = await handleOwnerApprovalCommand({
      store: options.store,
      context: options.context,
      bodyText: recorded.bodyText
    });
    if (approvalReply.handled) {
      await options.store.updateInboundMessageHandling(options.context, recorded.id, {
        action: "approval_decided"
      });
      return {
        classification,
        action: "approval_decided",
        messageId: recorded.id
      };
    }
    const ownerIntent = classifyOwnerMessageIntent(recorded);
    await options.store.recordAudit(options.context, "message.owner_intent.classified", "message", recorded.id, {
      intent: ownerIntent.intent,
      confidence: ownerIntent.confidence,
      evidence: ownerIntent.evidence,
      source: recorded.source ?? "imap",
      classifier: "deterministic-owner-intent-v1"
    });
    const agentResult = await options.ownerAgentRunner?.(recorded, ownerIntent);
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
      conversationThreadId: agentResult?.conversationThreadId ?? null,
      taskId: agentResult?.taskId ?? null,
      taskEventId: taskEventId ?? null,
      agentRunId: agentResult?.runId ?? null,
      outboundMessageId: agentResult?.outboundMessageId ?? null
    });
    return {
      classification,
      action: "routed_to_agent",
      messageId: recorded.id,
      conversationThreadId: agentResult?.conversationThreadId,
      taskId: agentResult?.taskId,
      taskEventId,
      agentRunId: agentResult?.runId,
      outboundMessageId: agentResult?.outboundMessageId
    };
  }
  if (classification === "trusted") {
    await options.store.updateInboundMessageHandling(options.context, recorded.id, {
      action: "accepted_trusted"
    });
    return {
      classification,
      action: "accepted_trusted",
      messageId: recorded.id
    };
  }
  if (classification === "newsletter") {
    await appendNewsletterKnowledge({
      store: options.store,
      context: options.context,
      message: recorded,
      reason: "trusted_newsletter"
    });
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
  const outbound = await queueOwnerReviewNotification({
    context: options.context,
    settings: options.settings,
    store: options.store,
    message: options.message
  });
  if (!outbound) {
    await options.store.updateInboundMessageHandling(options.context, recorded.id, {
      action: "queued_owner_review"
    });
    return {
      classification,
      action: "queued_owner_review",
      messageId: recorded.id
    };
  }
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
