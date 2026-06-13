import { describe, expect, it } from "vitest";
import type { Session } from "../src/auth/session.js";
import { loadSettings } from "../src/config/settings.js";
import { createMemoryStore } from "../src/domain/store.js";
import type { RequestContext } from "../src/domain/types.js";
import { buildApp } from "../src/http/app.js";

function cookieHeader(sessionId: string): string {
  return `agent_session=${sessionId}`;
}

function contextFor(session: Session, requestId: string): RequestContext {
  return {
    userId: session.user.id,
    actorType: session.user.isAdmin ? "admin" : "user",
    permissions: session.user.isAdmin ? ["user", "admin"] : ["user"],
    requestId,
    session
  };
}

describe("personal dashboard API", () => {
  it("returns compact user-scoped assistant insights without connector secrets", async () => {
    const store = createMemoryStore();
    const ownerSettings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      DEV_USER_ID: "owner",
      DEV_USER_EMAIL: "owner@example.test"
    });
    const otherSettings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      DEV_USER_ID: "other",
      DEV_USER_EMAIL: "other@example.test"
    });
    const app = buildApp({ settings: ownerSettings, store });
    const ownerSession = await store.createDevelopmentSession(ownerSettings, "owner-login");
    const otherSession = await store.createDevelopmentSession(otherSettings, "other-login");
    const owner = contextFor(ownerSession, "owner-dashboard-seed");
    const other = contextFor(otherSession, "other-dashboard-seed");

    const task = await store.createTask(owner, {
      title: "Review travel plan",
      prompt: "Check calendar and draft next step.",
      dueAt: new Date(Date.now() + 60_000).toISOString(),
      scheduleRationale: "Owner asked for a short follow-up before the appointment.",
      nextReviewAt: new Date(Date.now() + 30_000).toISOString()
    });
    await store.updateTask(owner, task.id, {
      waitingOn: "owner confirmation",
      ownerClarificationNeeded: true
    });
    await store.createApproval(owner, {
      actionType: "send_outbound_message",
      proposedPayload: { body_text: "Approve this concise check-in." },
      riskLevel: "medium",
      summary: "Send owner a travel-plan check-in.",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString()
    });
    const outbound = await store.queueOutboundMessage(owner, {
      channel: "sms",
      status: "pending",
      toAddr: "owner-sms@example.test",
      bodyText: "Owner-visible message",
      subject: null
    });
    await store.updateOutboundMessageStatus(owner, outbound.id, "failed", "SMTP refused the message.");
    await store.createConversationThread(owner, {
      title: "Travel planning",
      status: "waiting",
      unresolvedQuestion: "Which hotel should be used?",
      linkedTaskIds: [task.id]
    });
    await store.writeMarkdownDocument(owner, {
      path: "/assistant/decisions/2026-06.md",
      markdown: "# Assistant Decisions: 2026-06\n\n## Travel check-in\n\n- Queued a check-in because the task is due soon."
    });
    await store.writeMarkdownDocument(owner, {
      path: "/assistant/feedback/2026-06.md",
      markdown: "# Owner Feedback: 2026-06\n\n## communication feedback\n\n- Owner said to avoid early texts."
    });
    await store.writeMarkdownDocument(owner, {
      path: "/personal/lists/books.md",
      markdown: "# Books\n\n<!-- memory-list:v1 -->\n\n- [ ] The Design of Everyday Things\n  added: 2026-06-13\n- [x] Archived Book\n  archived: true"
    });
    const run = await store.createAgentRun(owner, {
      status: "running",
      modelTier: "fast",
      modelId: "mock-fast"
    });
    await store.finishAgentRun(owner, run.id, "failed", "Model returned no usable action.");
    await store.recordToolCall(owner, {
      runId: run.id,
      toolName: "create_task",
      status: "rejected",
      arguments: { title: "bad" },
      validationError: "prompt is required"
    });
    await store.recordAudit(owner, "guardrail.exceeded", "agent_run", run.id, {
      guardrail: "maxOwnerVisibleOutboundMessagesPerUserPerDay",
      count: 11,
      limit: 10,
      reason: "owner-visible outbound cap"
    });
    await store.upsertConnector(owner, {
      kind: "smtp",
      status: "enabled",
      config: { username: "owner", smtp: { host: "smtp.example.test", password: "super-secret-token" } }
    });

    await store.createTask(other, {
      title: "Other private task",
      prompt: "Must not appear."
    });
    await store.writeMarkdownDocument(other, {
      path: "/assistant/decisions/2026-06.md",
      markdown: "# Other Decisions\n\n- Must not appear."
    });

    const response = await app.request("/api/v1/dashboard", {
      headers: {
        cookie: cookieHeader(ownerSession.id)
      }
    });

    expect(response.status).toBe(200);
    const payload = await response.json() as {
      metrics: Record<string, number>;
      activeTasks: Array<{ title: string; scheduleRationale: string | null }>;
      pendingApprovals: Array<{ summary: string }>;
      recentDecisions: Array<{ excerpt: string }>;
      recentFeedback: Array<{ excerpt: string }>;
      activeThreads: Array<{ title: string; attention: string }>;
      contactCadence: { failedOutbound: number; recentOutbound: Array<{ toAddr?: string; failureMessage: string | null }> };
      personalLists: Array<{ path: string; active: number; archived: number }>;
      safety: { failedRuns: unknown[]; failedToolCalls: unknown[]; guardrails: unknown[]; failedOutbound: Array<{ toAddr?: string }> };
    };

    expect(payload.metrics.pendingApprovals).toBe(1);
    expect(payload.activeTasks).toEqual([
      expect.objectContaining({
        title: "Review travel plan",
        scheduleRationale: "Owner asked for a short follow-up before the appointment."
      })
    ]);
    expect(payload.pendingApprovals).toEqual([
      expect.objectContaining({ summary: "Send owner a travel-plan check-in." })
    ]);
    expect(payload.recentDecisions[0]?.excerpt).toContain("Queued a check-in");
    expect(payload.recentFeedback[0]?.excerpt).toContain("avoid early texts");
    expect(payload.activeThreads).toEqual([
      expect.objectContaining({
        title: "Travel planning",
        attention: "Which hotel should be used?"
      })
    ]);
    expect(payload.contactCadence.failedOutbound).toBe(1);
    expect(payload.personalLists).toEqual([
      expect.objectContaining({ path: "/personal/lists/books.md", active: 1, archived: 1 })
    ]);
    expect(payload.safety.failedRuns).toHaveLength(1);
    expect(payload.safety.failedToolCalls).toHaveLength(1);
    expect(payload.safety.guardrails).toHaveLength(1);
    expect(payload.safety.failedOutbound[0]).not.toHaveProperty("toAddr");
    expect(JSON.stringify(payload)).not.toContain("Other private task");
    expect(JSON.stringify(payload)).not.toContain("super-secret-token");
  });
});
