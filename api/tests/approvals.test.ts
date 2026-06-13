import { describe, expect, it } from "vitest";
import { MockModelClient } from "../src/agent/modelClient.js";
import { runAgentTask } from "../src/agent/runAgentTask.js";
import { LocalToolClient } from "../src/agent/toolClient.js";
import { processInboundMessage } from "../src/connectors/inboundProcessor.js";
import { loadSettings } from "../src/config/settings.js";
import { createMemoryStore } from "../src/domain/store.js";
import type { RequestContext } from "../src/domain/types.js";
import { buildApp } from "../src/http/app.js";
import { SignedIntegrationTokenProvider } from "../src/integrations/tokenProvider.js";
import { executeApprovedCrossAppApproval } from "../src/scheduler/approvalExecutor.js";
import { SlidingWindowRateLimiter } from "../src/security/senderPolicy.js";

function cookieHeader(sessionId: string): string {
  return `agent_session=${sessionId}`;
}

async function testContext(env: Record<string, string> = {}): Promise<{
  context: RequestContext;
  store: ReturnType<typeof createMemoryStore>;
  settings: ReturnType<typeof loadSettings>;
}> {
  const settings = loadSettings({
    APP_ENV: "test",
    AUTH_MODE: "standalone",
    DEV_USER_ID: "owner",
    DEV_USER_EMAIL: "owner@example.test",
    ...env
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

  it("executes approved cross-app writes with a scoped signed token and redacts stored results", async () => {
    const { context, store, settings } = await testContext({
      DEV_USER_ID: "oauth:central-oauth:owner-subject",
      GOALS_API_BASE_URL: "https://goals.example.test/api/",
      AGENT_INTEGRATION_TOKEN_SECRET: "test-signing-secret"
    });
    const approval = await store.createApproval(context, {
      actionType: "cross_app_write_action",
      proposedPayload: {
        action_id: "goals.create_goal",
        path_params: {},
        query: {},
        body: { title: "Phase 02" }
      },
      riskLevel: "high",
      summary: "Create goal",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    await store.updateApprovalStatus(context, approval.id, "approved", context.userId);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://goals.example.test/api/goals");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ title: "Phase 02" });
      const authorization = new Headers(init?.headers).get("authorization") ?? "";
      expect(authorization).toMatch(/^Bearer agent-v1\./);
      const payload = JSON.parse(Buffer.from(authorization.split(".")[1] ?? "", "base64url").toString("utf8"));
      expect(payload).toMatchObject({
        aud: "goals",
        scope: "goals.create_goal",
        sub: "owner-subject"
      });
      return Response.json({
        id: "goal-1",
        title: "Phase 02",
        access_token: "secret-token",
        nested: { session_cookie: "secret-cookie" }
      }, { status: 201 });
    });

    const result = await executeApprovedCrossAppApproval({
      context,
      store,
      settings,
      approvalId: approval.id,
      tokenProvider: new SignedIntegrationTokenProvider(settings),
      fetchImpl: fetchMock
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      executionStatus: "succeeded",
      executionResult: {
        status: 201,
        data: {
          id: "goal-1",
          title: "Phase 02",
          access_token: "[redacted]",
          nested: { session_cookie: "[redacted]" }
        }
      }
    });
    await expect(store.listAudit(context, false)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "approval.execution.succeeded",
        entityId: approval.id,
        details: expect.objectContaining({
          result: expect.objectContaining({
            data: expect.objectContaining({ access_token: "[redacted]" })
          })
        })
      })
    ]));
  });

  it("fails closed for read, unknown, and directory-only cross-app approvals", async () => {
    const { context, store, settings } = await testContext({ GOALS_API_BASE_URL: "https://goals.example.test" });
    const cases = [
      { action_id: "goals.list_goals", error: "integration_action_not_write" },
      { action_id: "apartment_gate.open_gate", error: "unknown_integration_action" },
      { action_id: "not.registered", error: "unknown_integration_action" }
    ];
    for (const entry of cases) {
      const approval = await store.createApproval(context, {
        actionType: "cross_app_write_action",
        proposedPayload: { action_id: entry.action_id },
        riskLevel: "high",
        summary: "Unsafe action",
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      });
      await store.updateApprovalStatus(context, approval.id, "approved", context.userId);
      const fetchMock = vi.fn();

      const result = await executeApprovedCrossAppApproval({
        context,
        store,
        settings,
        approvalId: approval.id,
        tokenProvider: { tokenFor: async () => "token" },
        fetchImpl: fetchMock
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result).toMatchObject({ executionStatus: "failed", executionError: entry.error });
    }
  });

  it("prevents duplicate cross-app approval execution", async () => {
    const { context, store, settings } = await testContext({
      DEV_USER_ID: "oauth:central-oauth:owner-subject",
      GOALS_API_BASE_URL: "https://goals.example.test",
      AGENT_INTEGRATION_TOKEN_SECRET: "test-signing-secret"
    });
    const approval = await store.createApproval(context, {
      actionType: "cross_app_write_action",
      proposedPayload: { action_id: "goals.create_goal", body: { title: "One time" } },
      riskLevel: "high",
      summary: "Create goal",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    await store.updateApprovalStatus(context, approval.id, "approved", context.userId);
    const fetchMock = vi.fn(async () => Response.json({ ok: true }, { status: 201 }));
    const tokenProvider = new SignedIntegrationTokenProvider(settings);

    await executeApprovedCrossAppApproval({ context, store, settings, approvalId: approval.id, tokenProvider, fetchImpl: fetchMock });
    const duplicate = await executeApprovedCrossAppApproval({ context, store, settings, approvalId: approval.id, tokenProvider, fetchImpl: fetchMock });

    expect(duplicate).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(store.getApproval(context, approval.id)).resolves.toMatchObject({ executionStatus: "succeeded" });
  });

  it("does not execute expired or rejected cross-app approvals", async () => {
    const { context, store, settings } = await testContext({ GOALS_API_BASE_URL: "https://goals.example.test" });
    const expired = await store.createApproval(context, {
      actionType: "cross_app_write_action",
      proposedPayload: { action_id: "goals.create_goal", body: { title: "Too late" } },
      riskLevel: "high",
      summary: "Expired",
      expiresAt: new Date(Date.now() - 60_000).toISOString()
    });
    await store.updateApprovalStatus(context, expired.id, "approved", context.userId);
    const rejected = await store.createApproval(context, {
      actionType: "cross_app_write_action",
      proposedPayload: { action_id: "goals.create_goal", body: { title: "Rejected" } },
      riskLevel: "high",
      summary: "Rejected",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    await store.updateApprovalStatus(context, rejected.id, "rejected", context.userId);
    const fetchMock = vi.fn();

    const expiredResult = await executeApprovedCrossAppApproval({
      context,
      store,
      settings,
      approvalId: expired.id,
      tokenProvider: { tokenFor: async () => "token" },
      fetchImpl: fetchMock
    });
    const rejectedResult = await executeApprovedCrossAppApproval({
      context,
      store,
      settings,
      approvalId: rejected.id,
      tokenProvider: { tokenFor: async () => "token" },
      fetchImpl: fetchMock
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(expiredResult).toMatchObject({ executionStatus: "failed", executionError: "approval_expired" });
    expect(rejectedResult).toBeUndefined();
  });

  it("records a visible failure when integration token config is unavailable", async () => {
    const { context, store, settings } = await testContext({ GOALS_API_BASE_URL: "https://goals.example.test" });
    const approval = await store.createApproval(context, {
      actionType: "cross_app_write_action",
      proposedPayload: { action_id: "goals.create_goal", body: { title: "No token" } },
      riskLevel: "high",
      summary: "Create goal",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    await store.updateApprovalStatus(context, approval.id, "approved", context.userId);
    const fetchMock = vi.fn();

    const result = await executeApprovedCrossAppApproval({
      context,
      store,
      settings,
      approvalId: approval.id,
      tokenProvider: new SignedIntegrationTokenProvider(settings),
      fetchImpl: fetchMock
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      executionStatus: "failed",
      executionError: "missing_user_integration_token"
    });
  });

  it("records a failed execution when the cross-app request throws", async () => {
    const { context, store, settings } = await testContext({
      DEV_USER_ID: "oauth:central-oauth:owner-subject",
      GOALS_API_BASE_URL: "https://goals.example.test",
      AGENT_INTEGRATION_TOKEN_SECRET: "test-signing-secret"
    });
    const approval = await store.createApproval(context, {
      actionType: "cross_app_write_action",
      proposedPayload: { action_id: "goals.create_goal", body: { title: "Network failure" } },
      riskLevel: "high",
      summary: "Create goal",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    await store.updateApprovalStatus(context, approval.id, "approved", context.userId);

    const result = await executeApprovedCrossAppApproval({
      context,
      store,
      settings,
      approvalId: approval.id,
      tokenProvider: new SignedIntegrationTokenProvider(settings),
      fetchImpl: async () => {
        throw new Error("integration unavailable");
      }
    });

    expect(result).toMatchObject({
      executionStatus: "failed",
      executionError: "integration unavailable"
    });
    await expect(store.getApproval(context, approval.id)).resolves.toMatchObject({
      executionStatus: "failed",
      executionError: "integration unavailable"
    });
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
