import { describe, expect, it } from "vitest";
import { MockModelClient } from "../src/agent/modelClient.js";
import { runAgentTask } from "../src/agent/runAgentTask.js";
import { LocalToolClient } from "../src/agent/toolClient.js";
import { processInboundMessage } from "../src/connectors/inboundProcessor.js";
import { loadSettings } from "../src/config/settings.js";
import { createMemoryStore } from "../src/domain/store.js";
import type { RequestContext } from "../src/domain/types.js";
import { buildApp } from "../src/http/app.js";
import { SlidingWindowRateLimiter } from "../src/security/senderPolicy.js";

function cookieHeader(sessionId: string): string {
  return `agent_session=${sessionId}`;
}

async function testContext(): Promise<{
  context: RequestContext;
  store: ReturnType<typeof createMemoryStore>;
  settings: ReturnType<typeof loadSettings>;
}> {
  const settings = loadSettings({
    APP_ENV: "test",
    AUTH_MODE: "standalone",
    DEV_USER_ID: "owner",
    DEV_USER_EMAIL: "owner@example.test"
  });
  const store = createMemoryStore();
  const session = await store.createDevelopmentSession(settings, "approval-test-login");
  return {
    settings,
    store,
    context: {
      userId: session.user.id,
      actorType: "user",
      permissions: ["user"],
      requestId: "approval-test",
      session
    }
  };
}

describe("approval and notification policy", () => {
  it("creates an approval for high-risk outbound messages", async () => {
    const { context, store } = await testContext();
    await store.upsertConnector(context, {
      kind: "owner-contact",
      status: "enabled",
      config: { sms_gateway: "owner-sms@example.test" }
    });

    const result = await runAgentTask({
      context,
      store,
      modelClient: new MockModelClient({
        tools: [{
          toolName: "propose_outbound_message",
          arguments: { intent: "reply", body: "This needs approval." }
        }]
      }),
      request: { prompt: "Tell the owner this needs approval." },
      toolClient: new LocalToolClient()
    });

    expect(result.executionResult).toMatchObject({
      status: "queued_approval",
      approval_required: true,
      approval_id: expect.any(String)
    });
    await expect(store.listApprovals(context, ["pending"])).resolves.toEqual([
      expect.objectContaining({
        actionType: "send_outbound_message",
        riskLevel: "high",
        proposedPayload: expect.objectContaining({ body_text: "This needs approval." })
      })
    ]);
    await expect(store.listOutboundMessages(context)).resolves.toEqual([
      expect.objectContaining({
        status: "requires_approval",
        toAddr: "owner-sms@example.test"
      })
    ]);
  });

  it("queues approval instead of executing cross-app write actions", async () => {
    const { context, store } = await testContext();

    const result = await runAgentTask({
      context,
      store,
      modelClient: new MockModelClient({
        tools: [{
          toolName: "integration_action",
          arguments: {
            actionId: "goals.create_goal",
            pathParams: {},
            query: {},
            body: { title: "Phase 08" },
            userIntentSummary: "Create a new goal for Phase 08."
          }
        }]
      }),
      request: { prompt: "Create a goal." },
      toolClient: new LocalToolClient()
    });

    expect(result.executionResult).toMatchObject({
      status: "queued_approval",
      approval_required: true,
      action_id: "goals.create_goal"
    });
    await expect(store.listApprovals(context, ["pending"])).resolves.toEqual([
      expect.objectContaining({
        actionType: "cross_app_write_action",
        sourceRef: "goals.create_goal",
        proposedPayload: expect.objectContaining({ action_id: "goals.create_goal" })
      })
    ]);
  });

  it("approves the current owner approval from an SMS YES reply", async () => {
    const { context, store, settings } = await testContext();
    const approval = await store.createApproval(context, {
      actionType: "send_outbound_message",
      proposedPayload: {
        channel: "sms",
        to_addr: "owner-sms@example.test",
        body_text: "Approve me."
      },
      riskLevel: "high",
      summary: "Send SMS",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const outbound = await store.queueOutboundMessage(context, {
      channel: "sms",
      status: "requires_approval",
      toAddr: "owner-sms@example.test",
      bodyText: "Approve me.",
      approvalId: approval.id
    });
    await store.updateApprovalPayload(context, approval.id, {
      ...approval.proposedPayload,
      outbound_message_id: outbound.id
    });
    await store.setSenderStatus(context, "owner-sms@example.test", "owner");

    const result = await processInboundMessage({
      context,
      settings,
      store,
      message: {
        providerMessageId: "approval-yes-1",
        fromAddr: "owner-sms@example.test",
        toAddr: "agent@example.test",
        bodyText: "YES",
        source: "sms"
      },
      rateLimiter: new SlidingWindowRateLimiter(10, 60_000),
      modelClient: new MockModelClient()
    });

    expect(result.action).toBe("approval_decided");
    await expect(store.getApproval(context, approval.id)).resolves.toMatchObject({ status: "approved" });
    await expect(store.listOutboundMessages(context)).resolves.toEqual([
      expect.objectContaining({ id: outbound.id, status: "approved" })
    ]);
  });

  it("does not execute expired approvals", async () => {
    const { context, store, settings } = await testContext();
    const app = buildApp({ settings, store });
    const approval = await store.createApproval(context, {
      actionType: "send_outbound_message",
      proposedPayload: { body_text: "Expired." },
      riskLevel: "high",
      summary: "Expired approval",
      expiresAt: new Date(Date.now() - 60_000).toISOString()
    });

    const response = await app.request(`/api/v1/approvals/${approval.id}`, {
      method: "PATCH",
      headers: {
        cookie: cookieHeader(context.session.id),
        "content-type": "application/json"
      },
      body: JSON.stringify({ decision: "approve" })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      approval: { status: "expired" }
    });
  });

  it("records audit when approvals are rejected", async () => {
    const { context, store, settings } = await testContext();
    const app = buildApp({ settings, store });
    const approval = await store.createApproval(context, {
      actionType: "cross_app_write_action",
      proposedPayload: { action_id: "goals.create_goal" },
      riskLevel: "high",
      summary: "Create goal",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });

    const response = await app.request(`/api/v1/approvals/${approval.id}`, {
      method: "PATCH",
      headers: {
        cookie: cookieHeader(context.session.id),
        "content-type": "application/json"
      },
      body: JSON.stringify({ decision: "reject" })
    });

    expect(response.status).toBe(200);
    await expect(store.listAudit(context, false)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "approval.rejected", entityId: approval.id })
      ])
    );
  });

  it("edits outbound approval payload and audits the edit", async () => {
    const { context, store, settings } = await testContext();
    const app = buildApp({ settings, store });
    const approval = await store.createApproval(context, {
      actionType: "send_outbound_message",
      proposedPayload: {
        channel: "sms",
        to_addr: "owner-sms@example.test",
        body_text: "Original."
      },
      riskLevel: "high",
      summary: "Send SMS",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });

    const response = await app.request(`/api/v1/approvals/${approval.id}`, {
      method: "PATCH",
      headers: {
        cookie: cookieHeader(context.session.id),
        "content-type": "application/json"
      },
      body: JSON.stringify({ decision: "edit", text: "Edited." })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      approval: {
        proposedPayload: expect.objectContaining({ body_text: "Edited." })
      }
    });
    await expect(store.listAudit(context, false)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "approval.edited", entityId: approval.id })
      ])
    );
  });

  it("edits outbound approval by replacing the linked outbox record", async () => {
    const { context, store, settings } = await testContext();
    const app = buildApp({ settings, store });
    const approval = await store.createApproval(context, {
      actionType: "send_outbound_message",
      proposedPayload: {
        channel: "sms",
        to_addr: "owner-sms@example.test",
        body_text: "Original."
      },
      riskLevel: "high",
      summary: "Send SMS",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const originalOutbound = await store.queueOutboundMessage(context, {
      channel: "sms",
      status: "requires_approval",
      toAddr: "owner-sms@example.test",
      bodyText: "Original.",
      approvalId: approval.id
    });
    await store.updateApprovalPayload(context, approval.id, {
      ...approval.proposedPayload,
      outbound_message_id: originalOutbound.id
    });

    const editResponse = await app.request(`/api/v1/approvals/${approval.id}`, {
      method: "PATCH",
      headers: {
        cookie: cookieHeader(context.session.id),
        "content-type": "application/json"
      },
      body: JSON.stringify({ decision: "edit", text: "Edited." })
    });

    expect(editResponse.status).toBe(200);
    const editPayload = await editResponse.json();
    expect(editPayload.outbound.id).not.toBe(originalOutbound.id);
    expect(editPayload.outbound).toMatchObject({
      bodyText: "Edited.",
      status: "requires_approval"
    });
    expect(editPayload.approval).toMatchObject({
      proposedPayload: expect.objectContaining({
        body_text: "Edited.",
        outbound_message_id: editPayload.outbound.id
      })
    });

    const approveResponse = await app.request(`/api/v1/approvals/${approval.id}`, {
      method: "PATCH",
      headers: {
        cookie: cookieHeader(context.session.id),
        "content-type": "application/json"
      },
      body: JSON.stringify({ decision: "approve" })
    });

    expect(approveResponse.status).toBe(200);
    await expect(store.listOutboundMessages(context)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: originalOutbound.id, status: "cancelled" }),
        expect.objectContaining({ id: editPayload.outbound.id, status: "approved", bodyText: "Edited." })
      ])
    );
  });
});
