import type {
  AgentStore,
  ApprovalRecord,
  ApprovalStatus,
  OutboundMessageRecord,
  RequestContext
} from "../domain/types.js";

const APPROVAL_TTL_MS = 48 * 60 * 60 * 1000;

export type ApprovalDecisionResult = {
  approval: ApprovalRecord;
  outbound?: OutboundMessageRecord;
};

function expiresAt(): string {
  return new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
}

function compact(value: string, length: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, length);
}

function payloadString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

export async function createOutboundApproval(options: {
  context: RequestContext;
  store: AgentStore;
  runId?: string | null;
  sourceRef?: string | null;
  channel: "email" | "sms" | "mms";
  toAddr: string;
  subject?: string | null;
  bodyText: string;
}): Promise<{ approval: ApprovalRecord; outbound: OutboundMessageRecord }> {
  const proposedPayload = {
    channel: options.channel,
    to_addr: options.toAddr,
    subject: options.subject ?? null,
    body_text: options.bodyText
  };
  const approval = await options.store.createApproval(options.context, {
    sourceRunId: options.runId ?? null,
    sourceRef: options.sourceRef ?? null,
    actionType: "send_outbound_message",
    proposedPayload,
    riskLevel: "high",
    summary: `Send ${options.channel} owner message: ${compact(options.bodyText, 160)}`,
    expiresAt: expiresAt(),
    requestedBy: "agent"
  });
  const outbound = await options.store.queueOutboundMessage(options.context, {
    channel: options.channel,
    status: "requires_approval",
    toAddr: options.toAddr,
    subject: options.subject ?? null,
    bodyText: options.bodyText,
    approvalId: approval.id
  });
  const updated = await options.store.updateApprovalPayload(options.context, approval.id, {
    ...proposedPayload,
    outbound_message_id: outbound.id
  });
  return { approval: updated ?? approval, outbound };
}

export async function createCrossAppApproval(options: {
  context: RequestContext;
  store: AgentStore;
  runId?: string | null;
  actionId: string;
  proposedPayload: Record<string, unknown>;
  summary: string;
}): Promise<ApprovalRecord> {
  return options.store.createApproval(options.context, {
    sourceRunId: options.runId ?? null,
    sourceRef: options.actionId,
    actionType: "cross_app_write_action",
    proposedPayload: options.proposedPayload,
    riskLevel: "high",
    summary: compact(options.summary, 240),
    expiresAt: expiresAt(),
    requestedBy: "agent"
  });
}

export async function decideApproval(options: {
  context: RequestContext;
  store: AgentStore;
  approvalId: string;
  decision: "approve" | "reject";
}): Promise<ApprovalDecisionResult | undefined> {
  const approval = await options.store.getApproval(options.context, options.approvalId);
  if (!approval) {
    return undefined;
  }
  if (approval.status !== "pending") {
    return { approval };
  }
  if (Date.parse(approval.expiresAt) <= Date.now()) {
    const expired = await options.store.updateApprovalStatus(options.context, approval.id, "expired", options.context.userId);
    if (approval.actionType === "send_outbound_message") {
      const outboundId = payloadString(approval.proposedPayload, "outbound_message_id");
      if (outboundId) {
        await options.store.updateOutboundMessageStatus(options.context, outboundId, "cancelled");
      }
    }
    return { approval: expired ?? approval };
  }

  const status: ApprovalStatus = options.decision === "approve" ? "approved" : "rejected";
  const decided = await options.store.updateApprovalStatus(options.context, approval.id, status, options.context.userId);
  const current = decided ?? approval;
  if (approval.actionType !== "send_outbound_message") {
    return { approval: current };
  }
  const outboundId = payloadString(approval.proposedPayload, "outbound_message_id");
  if (!outboundId) {
    return { approval: current };
  }
  const outbound = await options.store.updateOutboundMessageStatus(
    options.context,
    outboundId,
    options.decision === "approve" ? "approved" : "cancelled"
  );
  return { approval: current, outbound };
}

export async function editApproval(options: {
  context: RequestContext;
  store: AgentStore;
  approvalId: string;
  text: string;
}): Promise<ApprovalDecisionResult | undefined> {
  const approval = await options.store.getApproval(options.context, options.approvalId);
  if (!approval || approval.status !== "pending") {
    return approval ? { approval } : undefined;
  }
  if (approval.actionType !== "send_outbound_message") {
    return { approval };
  }
  const payload = {
    ...approval.proposedPayload,
    body_text: options.text
  };
  const updated = await options.store.updateApprovalPayload(
    options.context,
    approval.id,
    payload,
    `Send edited owner message: ${compact(options.text, 160)}`
  );
  let current = updated ?? approval;
  const outboundId = payloadString(approval.proposedPayload, "outbound_message_id");
  let outbound: OutboundMessageRecord | undefined;
  if (outboundId) {
    const channel = payloadString(payload, "channel") as "email" | "sms" | "mms" | undefined;
    const toAddr = payloadString(payload, "to_addr");
    outbound = await options.store.updateOutboundMessageStatus(options.context, outboundId, "cancelled");
    if (channel && toAddr) {
      outbound = await options.store.queueOutboundMessage(options.context, {
        channel,
        status: "requires_approval",
        toAddr,
        subject: payloadString(payload, "subject") ?? null,
        bodyText: options.text,
        approvalId: approval.id
      });
      current = await options.store.updateApprovalPayload(options.context, approval.id, {
        ...payload,
        outbound_message_id: outbound.id
      }) ?? current;
    }
  }
  return { approval: current, outbound };
}

export function parseApprovalCommand(bodyText: string):
  | { command: "approve" }
  | { command: "reject" }
  | { command: "later" }
  | { command: "details" }
  | { command: "edit"; text: string }
  | undefined {
  const trimmed = bodyText.trim();
  const normalized = trimmed.toLowerCase().replace(/[.!?]+$/g, "");
  if (["yes", "y", "approve", "approved"].includes(normalized)) {
    return { command: "approve" };
  }
  if (["no", "n", "reject", "rejected", "cancel"].includes(normalized)) {
    return { command: "reject" };
  }
  if (["later"].includes(normalized)) {
    return { command: "later" };
  }
  if (["details", "detail"].includes(normalized)) {
    return { command: "details" };
  }
  if (normalized.startsWith("edit ")) {
    const text = trimmed.slice(trimmed.toLowerCase().indexOf("edit ") + 5).trim();
    return text ? { command: "edit", text } : undefined;
  }
  return undefined;
}

export async function handleOwnerApprovalCommand(options: {
  context: RequestContext;
  store: AgentStore;
  bodyText: string;
}): Promise<{ handled: boolean; approval?: ApprovalRecord }> {
  const command = parseApprovalCommand(options.bodyText);
  if (!command) {
    return { handled: false };
  }
  const [approval] = await options.store.listApprovals(options.context, ["pending"]);
  if (!approval) {
    return { handled: false };
  }
  if (command.command === "approve") {
    const result = await decideApproval({
      context: options.context,
      store: options.store,
      approvalId: approval.id,
      decision: "approve"
    });
    return { handled: true, approval: result?.approval ?? approval };
  }
  if (command.command === "reject") {
    const result = await decideApproval({
      context: options.context,
      store: options.store,
      approvalId: approval.id,
      decision: "reject"
    });
    return { handled: true, approval: result?.approval ?? approval };
  }
  if (command.command === "edit") {
    const result = await editApproval({
      context: options.context,
      store: options.store,
      approvalId: approval.id,
      text: command.text
    });
    return { handled: true, approval: result?.approval ?? approval };
  }
  await options.store.recordAudit(options.context, `approval.command.${command.command}`, "approval", approval.id, {
    action_type: approval.actionType
  });
  return { handled: true, approval };
}
