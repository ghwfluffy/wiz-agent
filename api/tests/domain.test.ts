import { describe, expect, it, vi } from "vitest";
import { loadSettings } from "../src/config/settings.js";
import { createMemoryStore } from "../src/domain/store.js";
import { buildApp } from "../src/http/app.js";

function cookieHeader(sessionId: string): string {
  return `agent_session=${sessionId}`;
}

describe("domain and user ownership APIs", () => {
  it("returns a stable API error envelope for unauthenticated domain requests", async () => {
    const app = buildApp({
      settings: loadSettings({ APP_ENV: "test", AUTH_MODE: "standalone" })
    });

    const response = await app.request("/api/v1/tasks", {
      headers: {
        "x-request-id": "request-1"
      }
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "http_401",
        message: "Not authenticated.",
        field_errors: [],
        request_id: "request-1"
      }
    });
  });

  it("enforces task ownership by user", async () => {
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

    const createResponse = await app.request("/api/v1/tasks", {
      method: "POST",
      headers: {
        cookie: cookieHeader(ownerSession.id),
        "content-type": "application/json"
      },
      body: JSON.stringify({
        title: "Follow up",
        prompt: "Check the inbox tomorrow."
      })
    });

    expect(createResponse.status).toBe(201);
    const task = await createResponse.json() as { id: string };

    const ownerRead = await app.request(`/api/v1/tasks/${task.id}`, {
      headers: {
        cookie: cookieHeader(ownerSession.id)
      }
    });
    expect(ownerRead.status).toBe(200);

    const otherRead = await app.request(`/api/v1/tasks/${task.id}`, {
      headers: {
        cookie: cookieHeader(otherSession.id),
        "x-request-id": "other-read"
      }
    });
    expect(otherRead.status).toBe(404);
  });

  it("fails closed for non-admin aggregate observability store reads", async () => {
    const store = createMemoryStore();
    const ownerSettings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      DEV_USER_ID: "owner",
      DEV_USER_EMAIL: "owner@example.test",
      DEV_USER_IS_ADMIN: "false"
    });
    const otherSettings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      DEV_USER_ID: "other",
      DEV_USER_EMAIL: "other@example.test",
      DEV_USER_IS_ADMIN: "false"
    });
    const adminSettings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      DEV_USER_ID: "admin",
      DEV_USER_EMAIL: "admin@example.test",
      DEV_USER_IS_ADMIN: "true"
    });
    const ownerSession = await store.createDevelopmentSession(ownerSettings, "owner-observability-login");
    const otherSession = await store.createDevelopmentSession(otherSettings, "other-observability-login");
    const adminSession = await store.createDevelopmentSession(adminSettings, "admin-observability-login");
    const owner = {
      userId: ownerSession.user.id,
      actorType: "user" as const,
      permissions: ["user"],
      requestId: "owner-observability",
      session: ownerSession
    };
    const other = {
      userId: otherSession.user.id,
      actorType: "user" as const,
      permissions: ["user"],
      requestId: "other-observability",
      session: otherSession
    };
    const admin = {
      userId: adminSession.user.id,
      actorType: "admin" as const,
      permissions: ["user", "admin"],
      requestId: "admin-observability",
      session: adminSession
    };

    await store.createTask(owner, { title: "Owner task", prompt: "Owner only." });
    await store.createTask(other, { title: "Other task", prompt: "Other only." });
    await store.upsertConnector(owner, { kind: "owner-contact", status: "enabled", config: { email: "owner@example.test" } });
    await store.upsertConnector(other, { kind: "owner-contact", status: "enabled", config: { email: "other@example.test" } });
    await store.queueOutboundMessage(owner, { channel: "email", status: "failed", toAddr: "owner@example.test", bodyText: "Owner failed." });
    await store.queueOutboundMessage(other, { channel: "email", status: "failed", toAddr: "other@example.test", bodyText: "Other failed." });
    await store.createApproval(owner, {
      actionType: "send_outbound_message",
      proposedPayload: { body_text: "Owner approval." },
      riskLevel: "low",
      summary: "Owner approval",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    await store.createApproval(other, {
      actionType: "send_outbound_message",
      proposedPayload: { body_text: "Other approval." },
      riskLevel: "low",
      summary: "Other approval",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const ownerRun = await store.createAgentRun(owner, { status: "running", modelTier: "fast", modelId: "mock-fast" });
    const otherRun = await store.createAgentRun(other, { status: "running", modelTier: "fast", modelId: "mock-fast" });
    await store.recordToolCall(owner, { runId: ownerRun.id, toolName: "list_tasks", status: "accepted", arguments: {} });
    await store.recordToolCall(other, { runId: otherRun.id, toolName: "list_tasks", status: "accepted", arguments: {} });
    await store.writeMarkdownDocument(owner, { path: "/assistant/owner.md", markdown: "# Owner" });
    await store.writeMarkdownDocument(other, { path: "/assistant/other.md", markdown: "# Other" });
    await store.recordAudit(owner, "owner.audit", "test", "owner");
    await store.recordAudit(other, "other.audit", "test", "other");

    await expect(store.listTasks(owner, true)).resolves.toEqual([
      expect.objectContaining({ userId: "owner" })
    ]);
    await expect(store.listConnectors(owner, true)).resolves.toEqual([
      expect.objectContaining({ userId: "owner" })
    ]);
    await expect(store.listOutboundMessages(owner, undefined, true)).resolves.toEqual([
      expect.objectContaining({ userId: "owner" })
    ]);
    await expect(store.listApprovals(owner, undefined, true)).resolves.toEqual([
      expect.objectContaining({ userId: "owner" })
    ]);
    await expect(store.listAgentRuns(owner, true)).resolves.toEqual([
      expect.objectContaining({ userId: "owner" })
    ]);
    await expect(store.listToolCalls(owner, true)).resolves.toEqual([
      expect.objectContaining({ userId: "owner" })
    ]);
    await expect(store.listRagIndexJobs(owner, true)).resolves.toEqual([
      expect.objectContaining({ userId: "owner" })
    ]);
    const ownerAudit = await store.listAudit(owner, true);
    expect(ownerAudit.some((event) => event.userId === "other")).toBe(false);
    const adminRuns = await store.listAgentRuns(admin, true);
    expect(adminRuns).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: "owner" }),
      expect.objectContaining({ userId: "other" })
    ]));
  });

  it("records task events and accepts follow-up prompts for the current user", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone"
    });
    const app = buildApp({ settings, store });
    const session = await store.createDevelopmentSession(settings, "task-events-login");

    const createResponse = await app.request("/api/v1/tasks", {
      method: "POST",
      headers: {
        cookie: cookieHeader(session.id),
        "content-type": "application/json"
      },
      body: JSON.stringify({
        title: "Investigate inbox",
        prompt: "Read the latest owner message."
      })
    });
    const task = await createResponse.json() as { id: string };

    const promptResponse = await app.request(`/api/v1/tasks/${task.id}/prompts`, {
      method: "POST",
      headers: {
        cookie: cookieHeader(session.id),
        "content-type": "application/json"
      },
      body: JSON.stringify({
        prompt: "Also draft the reply but do not send it yet."
      })
    });

    expect(promptResponse.status).toBe(200);
    await expect(promptResponse.json()).resolves.toMatchObject({
      task: {
        status: "pending",
        prompt: expect.stringContaining("Also draft the reply")
      },
      events: expect.arrayContaining([
        expect.objectContaining({
          eventType: "task.prompt_added",
          summary: "Follow-up prompt added and task returned to pending."
        }),
        expect.objectContaining({
          eventType: "task.created"
        })
      ])
    });

    const eventsResponse = await app.request(`/api/v1/tasks/${task.id}/events`, {
      headers: {
        cookie: cookieHeader(session.id)
      }
    });
    expect(eventsResponse.status).toBe(200);
    await expect(eventsResponse.json()).resolves.toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({ eventType: "task.prompt_added" })
      ])
    });
  });

  it("rejects invalid task request payloads before domain writes", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone"
    });
    const app = buildApp({ settings, store });
    const session = await store.createDevelopmentSession(settings, "task-validation-login");
    const headers = {
      cookie: cookieHeader(session.id),
      "content-type": "application/json",
      "x-request-id": "task-validation"
    };

    const blank = await app.request("/api/v1/tasks", {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "   ",
        prompt: "Do something."
      })
    });
    expect(blank.status).toBe(400);
    await expect(blank.json()).resolves.toMatchObject({
      error: {
        code: "validation_error",
        request_id: "task-validation"
      }
    });

    const badDueAt = await app.request("/api/v1/tasks", {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Bad date",
        prompt: "Do something.",
        dueAt: "nextish"
      })
    });
    expect(badDueAt.status).toBe(400);

    const badPriority = await app.request("/api/v1/tasks", {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Bad priority",
        prompt: "Do something.",
        priority: -1
      })
    });
    expect(badPriority.status).toBe(400);

    await expect(store.listTasks({
      userId: session.user.id,
      actorType: "user",
      permissions: ["user"],
      requestId: "task-validation-check",
      session
    })).resolves.toEqual([]);
  });

  it("rejects invalid task updates before mutating existing tasks", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone"
    });
    const app = buildApp({ settings, store });
    const session = await store.createDevelopmentSession(settings, "task-update-validation-login");
    const context = {
      userId: session.user.id,
      actorType: "user" as const,
      permissions: ["user"],
      requestId: "task-update-validation-seed",
      session
    };
    const task = await store.createTask(context, {
      title: "Keep this title",
      prompt: "Keep this prompt."
    });

    const response = await app.request(`/api/v1/tasks/${task.id}`, {
      method: "PATCH",
      headers: {
        cookie: cookieHeader(session.id),
        "content-type": "application/json"
      },
      body: JSON.stringify({
        title: " ",
        status: "pending"
      })
    });

    expect(response.status).toBe(400);
    await expect(store.getTask(context, task.id)).resolves.toMatchObject({
      title: "Keep this title",
      prompt: "Keep this prompt."
    });
  });

  it("restricts admin APIs to administrators and lets admins inspect all user audit", async () => {
    const store = createMemoryStore();
    const adminSettings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      DEV_USER_ID: "admin",
      DEV_USER_EMAIL: "admin@example.test",
      DEV_USER_IS_ADMIN: "true"
    });
    const normalSettings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      DEV_USER_ID: "normal",
      DEV_USER_EMAIL: "normal@example.test",
      DEV_USER_IS_ADMIN: "false"
    });
    const app = buildApp({ settings: adminSettings, store });
    const adminSession = await store.createDevelopmentSession(adminSettings, "admin-login");
    const normalSession = await store.createDevelopmentSession(normalSettings, "normal-login");

    const forbidden = await app.request("/api/v1/admin/audit", {
      headers: {
        cookie: cookieHeader(normalSession.id),
        "x-request-id": "normal-admin"
      }
    });
    expect(forbidden.status).toBe(403);

    await app.request("/api/v1/tasks", {
      method: "POST",
      headers: {
        cookie: cookieHeader(normalSession.id),
        "content-type": "application/json"
      },
      body: JSON.stringify({
        title: "Normal user task",
        prompt: "Visible in admin audit."
      })
    });
    await store.recordAudit(
      {
        userId: normalSession.user.id,
        actorType: "system",
        requestId: "normal-secret-audit"
      },
      "worker.imap_error",
      "connector",
      "imap",
      {
        message: "Bearer raw-secret-token https://private.example/path password=topsecret",
        nested: {
          token: "raw-secret-token"
        }
      }
    );

    const auditResponse = await app.request("/api/v1/admin/audit", {
      headers: {
        cookie: cookieHeader(adminSession.id)
      }
    });
    expect(auditResponse.status).toBe(200);
    const auditPayload = await auditResponse.json() as { events: Array<{ action: string; userId: string | null; details: Record<string, unknown> }> };
    expect(auditPayload.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "task.create",
          userId: "normal"
        }),
        expect.objectContaining({
          action: "worker.imap_error",
          details: expect.objectContaining({
            message: expect.stringContaining("Bearer [redacted]")
          })
        })
      ])
    );
    expect(JSON.stringify(auditPayload)).not.toContain("topsecret");
    expect(JSON.stringify(auditPayload)).not.toContain("raw-secret-token");
    expect(JSON.stringify(auditPayload)).not.toContain("private.example");
  });

  it("allows administrators to manage AI backend config", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      DEV_USER_IS_ADMIN: "true"
    });
    const app = buildApp({ settings, store });
    const session = await store.createDevelopmentSession(settings, "admin-login");

    const response = await app.request("/api/v1/admin/ai-config", {
      method: "PUT",
      headers: {
        cookie: cookieHeader(session.id),
        "content-type": "application/json"
      },
      body: JSON.stringify({
        fastModel: "test-fast",
        repairAttemptLimit: 2
      })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      fastModel: "test-fast",
      repairAttemptLimit: 2
    });
  });

  it("rejects unsafe admin AI backend config values", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      DEV_USER_IS_ADMIN: "true"
    });
    const app = buildApp({ settings, store });
    const session = await store.createDevelopmentSession(settings, "admin-config-validation-login");

    const response = await app.request("/api/v1/admin/ai-config", {
      method: "PUT",
      headers: {
        cookie: cookieHeader(session.id),
        "content-type": "application/json",
        "x-request-id": "admin-config-validation"
      },
      body: JSON.stringify({
        fastModel: " ",
        maxToolCalls: -1
      })
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "validation_error",
        request_id: "admin-config-validation"
      }
    });
    await expect(store.getAiConfig()).resolves.toMatchObject({
      fastModel: "gpt-5-mini",
      maxToolCalls: 50,
      maxRuntimeSec: 500
    });
  });

  it("rejects contradictory admin AI backend config values", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      DEV_USER_IS_ADMIN: "true"
    });
    const app = buildApp({ settings, store });
    const session = await store.createDevelopmentSession(settings, "admin-config-contradiction-login");

    const response = await app.request("/api/v1/admin/ai-config", {
      method: "PUT",
      headers: {
        cookie: cookieHeader(session.id),
        "content-type": "application/json",
        "x-request-id": "admin-config-contradiction"
      },
      body: JSON.stringify({
        fastModel: "gpt-5-mini",
        maxToolCalls: 1,
        repairAttemptLimit: 2
      })
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "validation_error",
        request_id: "admin-config-contradiction"
      }
    });
    await expect(store.getAiConfig()).resolves.toMatchObject({
      fastModel: "gpt-5-mini",
      maxToolCalls: 50,
      repairAttemptLimit: 1
    });
  });

  it("seeds and validates AI backend config defaults at the store boundary", async () => {
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      AGENT_OPENAI_MODEL_FAST: "test-fast",
      AGENT_MAX_TOOL_CALLS: "25",
      AGENT_MAX_RUNTIME_SEC: "300"
    });
    const store = createMemoryStore(settings);
    const session = await store.createDevelopmentSession(settings, "store-ai-config-login");
    const authContext = {
      userId: session.user.id,
      actorType: "admin" as const,
      permissions: ["user", "admin"],
      requestId: "store-ai-config",
      session
    };

    await expect(store.getAiConfig()).resolves.toMatchObject({
      fastModel: "test-fast",
      maxToolCalls: 25,
      maxRuntimeSec: 300
    });
    await expect(store.updateAiConfig(authContext, {
      fastModel: "test-fast",
      smartModel: "gpt-5",
      orchestratorModel: "gpt-5",
      repairModel: "gpt-5-mini",
      maxToolCalls: 0,
      maxRuntimeSec: 300,
      repairAttemptLimit: 1
    })).rejects.toThrow(/maxToolCalls/);
  });

  it("does not emit schedule context changes for no-op task updates", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone"
    });
    const session = await store.createDevelopmentSession(settings, "noop-task-login");
    const context = {
      userId: session.user.id,
      actorType: "admin" as const,
      permissions: ["user", "admin"],
      requestId: "noop-task-test",
      session
    };
    const task = await store.createTask(context, {
      title: "No-op task",
      prompt: "Keep the context stable."
    });

    await store.updateTask(context, task.id, { status: "pending" });

    await expect(store.listTaskEvents(context, task.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "task.updated",
          details: {}
        })
      ])
    );
  });

  it("lists and updates queued outbound messages for the current user", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      DEV_USER_IS_ADMIN: "true"
    });
    const app = buildApp({ settings, store });
    const session = await store.createDevelopmentSession(settings, "outbox-login");
    await store.queueOutboundMessage({
      userId: session.user.id,
      actorType: "admin",
      permissions: ["user", "admin"],
      requestId: "outbox-test",
      session
    }, {
      channel: "sms",
      status: "requires_approval",
      toAddr: "15555550100@sms.example.test",
      bodyText: "hello"
    });

    const list = await app.request("/api/v1/outbox", {
      headers: {
        cookie: cookieHeader(session.id)
      }
    });
    expect(list.status).toBe(200);
    const payload = await list.json() as { messages: Array<{ id: string }> };
    expect(payload.messages).toHaveLength(1);

    const update = await app.request(`/api/v1/outbox/${payload.messages[0]?.id}`, {
      method: "PATCH",
      headers: {
        cookie: cookieHeader(session.id),
        "content-type": "application/json"
      },
      body: JSON.stringify({ status: "approved" })
    });

    expect(update.status).toBe(200);
    await expect(update.json()).resolves.toMatchObject({ status: "approved" });
  });

  it("does not manually revive failed outbox records", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone"
    });
    const app = buildApp({ settings, store });
    const session = await store.createDevelopmentSession(settings, "outbox-terminal-login");
    const context = {
      userId: session.user.id,
      actorType: "user" as const,
      permissions: ["user"],
      requestId: "outbox-terminal-seed",
      session
    };
    const message = await store.queueOutboundMessage(context, {
      channel: "sms",
      status: "pending",
      toAddr: "owner-sms@example.test",
      bodyText: "failed delivery"
    });
    await store.updateOutboundMessageStatus(context, message.id, "failed", "SMTP refused the message.");

    const update = await app.request(`/api/v1/outbox/${message.id}`, {
      method: "PATCH",
      headers: {
        cookie: cookieHeader(session.id),
        "content-type": "application/json"
      },
      body: JSON.stringify({ status: "approved" })
    });

    expect(update.status).toBe(409);
    await expect(update.json()).resolves.toMatchObject({
      error: {
        code: "validation_error",
        request_id: expect.any(String)
      }
    });
    await expect(store.listOutboundMessages(context)).resolves.toEqual([
      expect.objectContaining({
        id: message.id,
        status: "failed",
        failureMessage: "SMTP refused the message."
      })
    ]);
  });

  it("lets users manage trusted sender classifications", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone"
    });
    const app = buildApp({ settings, store });
    const session = await store.createDevelopmentSession(settings, "sender-login");

    const update = await app.request("/api/v1/senders/newsletter%40example.test", {
      method: "PUT",
      headers: {
        cookie: cookieHeader(session.id),
        "content-type": "application/json"
      },
      body: JSON.stringify({ status: "newsletter" })
    });

    expect(update.status).toBe(200);
    await expect(update.json()).resolves.toMatchObject({
      senders: [
        expect.objectContaining({
          address: "newsletter@example.test",
          status: "newsletter"
        })
      ]
    });

    const list = await app.request("/api/v1/senders", {
      headers: {
        cookie: cookieHeader(session.id)
      }
    });
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      senders: [
        expect.objectContaining({
          address: "newsletter@example.test",
          status: "newsletter"
        })
      ]
    });

    const deleted = await app.request("/api/v1/senders/newsletter%40example.test", {
      method: "DELETE",
      headers: {
        cookie: cookieHeader(session.id)
      }
    });
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({ senders: [] });

    const missingDelete = await app.request("/api/v1/senders/newsletter%40example.test", {
      method: "DELETE",
      headers: {
        cookie: cookieHeader(session.id)
      }
    });
    expect(missingDelete.status).toBe(404);
  });

  it("lists and reads memory documents for the current user", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone"
    });
    const app = buildApp({ settings, store });
    const session = await store.createDevelopmentSession(settings, "memory-login");
    const context = {
      userId: session.user.id,
      actorType: "user" as const,
      permissions: ["user"],
      requestId: "memory-test",
      session
    };
    await store.upsertMemoryDocument(context, {
      slug: "newsletter-preferences",
      title: "Newsletter Preferences",
      body: "# Newsletter Preferences\n\n- I like useful security writeups."
    });

    const list = await app.request("/api/v1/memory", {
      headers: {
        cookie: cookieHeader(session.id)
      }
    });
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      documents: [
        expect.objectContaining({
          slug: "newsletter-preferences",
          title: "Newsletter Preferences"
        })
      ]
    });

    const detail = await app.request("/api/v1/memory/newsletter-preferences", {
      headers: {
        cookie: cookieHeader(session.id)
      }
    });
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      document: {
        body: expect.stringContaining("security writeups")
      }
    });
  });

  it("lists inbound inbox messages for the current user", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone"
    });
    const app = buildApp({ settings, store });
    const session = await store.createDevelopmentSession(settings, "inbox-login");
    const context = {
      userId: session.user.id,
      actorType: "user" as const,
      permissions: ["user"],
      requestId: "inbox-test",
      session
    };
    const recorded = await store.recordInboundMessage(context, {
      providerMessageId: "inbox-provider-1",
      fromAddr: "owner@example.test",
      toAddr: "agent@example.test",
      subject: "Follow-up",
      bodyText: "what happened?",
      source: "sms"
    }, "owner");
    await store.updateInboundMessageHandling(context, recorded.id, {
      action: "routed_to_agent",
      agentRunId: "run-1"
    });

    const response = await app.request("/api/v1/messages", {
      headers: {
        cookie: cookieHeader(session.id)
      }
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      messages: [
        expect.objectContaining({
          fromAddr: "owner@example.test",
          source: "sms",
          classification: "owner",
          handlingAction: "routed_to_agent",
          agentRunId: "run-1"
        })
      ]
    });
  });

  it("preserves existing inbound handling metadata when later updates omit optional links", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone"
    });
    const session = await store.createDevelopmentSession(settings, "inbox-handling-merge-login");
    const context = {
      userId: session.user.id,
      actorType: "user" as const,
      permissions: ["user"],
      requestId: "inbox-handling-merge-test",
      session
    };
    const thread = await store.createConversationThread(context, {
      title: "Roof quote",
      status: "active"
    });
    const recorded = await store.recordInboundMessage(context, {
      providerMessageId: "inbox-provider-thread-1",
      fromAddr: "owner@example.test",
      toAddr: "agent@example.test",
      subject: "Follow-up",
      bodyText: "what happened?",
      source: "sms"
    }, "owner");

    await store.updateInboundMessageHandling(context, recorded.id, {
      action: "routed_to_agent",
      conversationThreadId: thread.id,
      agentRunId: "run-1"
    });
    const updated = await store.updateInboundMessageHandling(context, recorded.id, {
      action: "approval_decided"
    });

    expect(updated).toMatchObject({
      handlingAction: "approval_decided",
      conversationThreadId: thread.id,
      agentRunId: "run-1"
    });
  });

  it("queues a missing owner review notification from an inbox row", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone"
    });
    const app = buildApp({ settings, store });
    const session = await store.createDevelopmentSession(settings, "inbox-review-login");
    const context = {
      userId: session.user.id,
      actorType: "user" as const,
      permissions: ["user"],
      requestId: "inbox-review-test",
      session
    };
    await store.upsertConnector(context, {
      kind: "owner-contact",
      status: "enabled",
      config: {
        sms_gateway: "owner-sms@example.test"
      }
    });
    const recorded = await store.recordInboundMessage(context, {
      providerMessageId: "inbox-review-provider-1",
      fromAddr: "unknown@example.test",
      toAddr: "agent@example.test",
      subject: "Hello",
      bodyText: "Can you do something?",
      source: "email"
    }, "untrusted");
    await store.updateInboundMessageHandling(context, recorded.id, {
      action: "queued_owner_review"
    });

    const response = await app.request(`/api/v1/messages/${recorded.id}/owner-review`, {
      method: "POST",
      headers: {
        cookie: cookieHeader(session.id)
      }
    });

    expect(response.status).toBe(200);
    const payload = await response.json() as {
      message: { outboundMessageId: string };
      outbound: { status: string; toAddr: string; bodyText: string };
    };
    expect(payload.message.outboundMessageId).toBeTruthy();
    expect(payload.outbound).toMatchObject({
      status: "pending",
      toAddr: "owner-sms@example.test"
    });
    expect(payload.outbound.bodyText).toContain("Untrusted sender unknown@example.test");
  });

  it("rejects invalid approval status filters instead of broadening the listing", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone"
    });
    const app = buildApp({ settings, store });
    const session = await store.createDevelopmentSession(settings, "approval-filter-login");
    const context = {
      userId: session.user.id,
      actorType: "user" as const,
      permissions: ["user"],
      requestId: "approval-filter-seed",
      session
    };
    await store.createApproval(context, {
      actionType: "send_outbound_message",
      proposedPayload: { body_text: "Pending." },
      riskLevel: "high",
      summary: "Pending approval",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const rejected = await store.createApproval(context, {
      actionType: "send_outbound_message",
      proposedPayload: { body_text: "Rejected." },
      riskLevel: "high",
      summary: "Rejected approval",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    await store.updateApprovalStatus(context, rejected.id, "rejected", session.user.id);

    const invalid = await app.request("/api/v1/approvals?status=pending,not-a-status", {
      headers: {
        cookie: cookieHeader(session.id),
        "x-request-id": "approval-filter-invalid"
      }
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({
      error: {
        code: "validation_error",
        field_errors: ["not-a-status"],
        request_id: "approval-filter-invalid"
      }
    });

    const pendingOnly = await app.request("/api/v1/approvals?status=pending", {
      headers: {
        cookie: cookieHeader(session.id)
      }
    });
    expect(pendingOnly.status).toBe(200);
    const payload = await pendingOnly.json() as { approvals: Array<{ status: string }> };
    expect(payload.approvals).toHaveLength(1);
    expect(payload.approvals[0]?.status).toBe("pending");
  });

  it("lets the current user manage connector configuration with redacted credentials", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone"
    });
    const app = buildApp({ settings, store });
    const session = await store.createDevelopmentSession(settings, "connectors-login");

    const update = await app.request("/api/v1/connectors/imap", {
      method: "PUT",
      headers: {
        cookie: cookieHeader(session.id),
        "content-type": "application/json"
      },
      body: JSON.stringify({
        status: "enabled",
        config: {
          username: "agent@example.test",
          host: "imap.example.test",
          port: 993,
          secure: true,
          mailbox: "INBOX",
          password: "user-mailbox-password"
        }
      })
    });
    expect(update.status).toBe(200);

    const list = await app.request("/api/v1/connectors", {
      headers: {
        cookie: cookieHeader(session.id)
      }
    });
    expect(list.status).toBe(200);
    const payload = await list.json() as { connectors: Array<{ kind: string; status: string; config: Record<string, unknown> }> };
    expect(payload.connectors).toEqual([
      expect.objectContaining({
        kind: "imap",
        status: "enabled",
        config: expect.objectContaining({
          username: "agent@example.test",
          imap: expect.objectContaining({
            host: "imap.example.test",
            port: 993,
            secure: true,
            mailbox: "INBOX",
            password_set: true
          })
        })
      })
    ]);
    expect(JSON.stringify(payload)).not.toContain("user-mailbox-password");

    const internal = await store.getConnector({
      userId: session.user.id,
      actorType: "user",
      permissions: ["user"],
      requestId: "connector-internal",
      session
    }, "imap");
    expect((internal?.config.imap as { password?: string }).password).toBe("user-mailbox-password");
  });

  it("reports IMAP test failures without exposing credentials", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone"
    });
    const app = buildApp({ settings, store });
    const session = await store.createDevelopmentSession(settings, "imap-test-login");

    const response = await app.request("/api/v1/connectors/imap/test", {
      method: "POST",
      headers: {
        cookie: cookieHeader(session.id)
      }
    });

    expect(response.status).toBe(200);
    const payload = await response.json() as { ok: boolean; configured: boolean; error?: { message?: string } };
    expect(payload).toMatchObject({
      ok: false,
      configured: false,
      error: {
        message: "IMAP connector is not enabled."
      }
    });
    expect(JSON.stringify(payload)).not.toContain("password");
  });

  it("bounds web-created MCP session TTLs", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone"
    });
    const app = buildApp({ settings, store });
    const session = await store.createDevelopmentSession(settings, "mcp-ttl-login");

    const response = await app.request("/api/v1/agent/mcp-sessions", {
      method: "POST",
      headers: {
        cookie: cookieHeader(session.id),
        "content-type": "application/json",
        "x-request-id": "mcp-ttl-validation"
      },
      body: JSON.stringify({
        ttlSeconds: 901
      })
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "validation_error",
        request_id: "mcp-ttl-validation"
      }
    });
  });

  it("returns operational job status for administrators", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      DEV_USER_IS_ADMIN: "true"
    });
    const app = buildApp({ settings, store });
    const session = await store.createDevelopmentSession(settings, "jobs-login");

    await app.request("/api/v1/tasks", {
      method: "POST",
      headers: {
        cookie: cookieHeader(session.id),
        "content-type": "application/json"
      },
      body: JSON.stringify({
        title: "Due task",
        prompt: "Run me.",
        dueAt: new Date(Date.now() - 60_000).toISOString()
      })
    });

    const response = await app.request("/api/v1/admin/jobs", {
      headers: {
        cookie: cookieHeader(session.id)
      }
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      budgets: expect.objectContaining({
        maxAgentRunsPerUserPerBurstWindow: 60,
        agentRunBurstWindowSeconds: 600,
        maxAutonomousRunsPerWorkerTick: 10,
        maxToolCallsPerRun: 50,
        maxRuntimeSecPerRun: 500,
        maxOwnerVisibleOutboundMessagesPerUserPerDay: 10,
        outboundMessagesPerWorkerTick: 1,
        maxUntrustedReviewNotificationsPerSenderPerDay: 5,
        maxNewsletterDocumentsPerInterestCheck: 25
      }),
      jobs: expect.arrayContaining([
        expect.objectContaining({
          name: "task-runner",
          pendingTasks: 1,
          dueTasks: 1
        }),
        expect.objectContaining({
          name: "outbox"
        }),
        expect.objectContaining({
          name: "inbound-mailbox",
          status: "disabled"
        }),
        expect.objectContaining({
          name: "rag-index",
          pendingJobs: 0
        }),
        expect.objectContaining({
          name: "qdrant-collections"
        }),
        expect.objectContaining({
          name: "runaway-guardrails",
          status: "configured"
        })
      ])
    });
  });

  it("summarizes admin-wide stale worker state and redacted operational failures", async () => {
    const store = createMemoryStore();
    const adminSettings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      DEV_USER_ID: "admin-user",
      DEV_USER_EMAIL: "admin@example.test",
      DEV_USER_IS_ADMIN: "true"
    });
    const otherSettings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      DEV_USER_ID: "other-user",
      DEV_USER_EMAIL: "other@example.test",
      DEV_USER_IS_ADMIN: "false"
    });
    const app = buildApp({ settings: adminSettings, store });
    const start = new Date("2026-06-13T10:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(start);
    try {
      const adminSession = await store.createDevelopmentSession(adminSettings, "admin-jobs-login");
      const otherSession = await store.createDevelopmentSession(otherSettings, "other-jobs-login");
      const adminContext = {
        userId: adminSession.user.id,
        actorType: "admin" as const,
        permissions: ["user", "admin"],
        requestId: "admin-jobs-seed",
        session: adminSession
      };
      const otherContext = {
        userId: otherSession.user.id,
        actorType: "user" as const,
        permissions: ["user"],
        requestId: "other-jobs-seed",
        session: otherSession
      };

      await store.createTask(otherContext, {
        title: "Other user's due task",
        prompt: "Visible only as an admin aggregate.",
        dueAt: new Date(start.getTime() - 60_000).toISOString()
      });
      const claimedTask = await store.createTask(adminContext, {
        title: "Stale claimed task",
        prompt: "Worker should recover this eventually."
      });
      await store.updateTask(adminContext, claimedTask.id, { status: "claimed" });
      const outbound = await store.queueOutboundMessage(adminContext, {
        channel: "sms",
        status: "pending",
        toAddr: "owner-sms@example.test",
        bodyText: "Queued message",
        subject: null
      });
      await store.claimOutboundMessageForSending(adminContext, outbound.id);

      const failedApproval = await store.createApproval(otherContext, {
        actionType: "cross_app_write_action",
        proposedPayload: { action_id: "goals.create_goal", body: { title: "Goal" } },
        riskLevel: "high",
        summary: "Create a goal from owner instruction.",
        expiresAt: new Date(start.getTime() + 60 * 60_000).toISOString()
      });
      await store.updateApprovalStatus(otherContext, failedApproval.id, "approved", otherContext.userId);
      await store.claimApprovalExecution(otherContext, failedApproval.id);
      await store.failApprovalExecution(
        otherContext,
        failedApproval.id,
        "missing_user_integration_token password=topsecret https://private.example/path",
        { token: "topsecret", url: "https://private.example/path" }
      );

      const runningApproval = await store.createApproval(adminContext, {
        actionType: "cross_app_write_action",
        proposedPayload: { action_id: "goals.create_goal", body: { title: "Another goal" } },
        riskLevel: "high",
        summary: "Create another goal.",
        expiresAt: new Date(start.getTime() + 60 * 60_000).toISOString()
      });
      await store.updateApprovalStatus(adminContext, runningApproval.id, "approved", adminContext.userId);
      await store.claimApprovalExecution(adminContext, runningApproval.id);
      await store.upsertConnector(adminContext, {
        kind: "imap",
        status: "enabled",
        config: {
          username: "owner",
          imap: {
            host: "imap.private.example",
            mailbox: "INBOX"
          }
        }
      });
      await store.recordAudit(adminContext, "worker.imap_error", "connector", "imap", {
        message: "Bearer super-secret-token https://private.example/path password=topsecret",
        command: "LOGIN password=topsecret"
      });

      vi.setSystemTime(new Date(start.getTime() + 31 * 60_000));
      const response = await app.request("/api/v1/admin/jobs", {
        headers: {
          cookie: cookieHeader(adminSession.id)
        }
      });

      expect(response.status).toBe(200);
      const payload = await response.json() as {
        scope: string;
        staleState: Record<string, number>;
        connectorHealth: Array<{ kind: string; status: string; incompleteUsers: number }>;
        recentFailures: {
          connectorFailures: Array<{ details: Record<string, unknown> }>;
          approvalExecutions: Array<{ executionError: string | null }>;
        };
        jobs: Array<Record<string, unknown>>;
      };
      expect(payload.scope).toBe("admin_all_users");
      expect(payload.staleState.staleClaimedTasks).toBe(1);
      expect(payload.staleState.staleSendingMessages).toBe(1);
      expect(payload.staleState.staleRunningApprovalExecutions).toBe(1);
      expect(payload.connectorHealth).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: "imap",
          status: "incomplete",
          incompleteUsers: 1
        })
      ]));
      expect(payload.jobs).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "task-runner",
          dueTasks: 1,
          staleClaimedTasks: 1
        }),
        expect.objectContaining({
          name: "approvals",
          failedExecutions: 1,
          staleRunningExecutions: 1
        })
      ]));
      expect(payload.recentFailures.approvalExecutions[0]?.executionError).toContain("missing_user_integration_token");
      expect(JSON.stringify(payload)).not.toContain("topsecret");
      expect(JSON.stringify(payload)).not.toContain("private.example");
      expect(JSON.stringify(payload)).not.toContain("imap.private.example");
      expect(JSON.stringify(payload)).not.toContain("super-secret-token");
    } finally {
      vi.useRealTimers();
    }
  });

  it("exposes scoped jobs and lets administrators retry failed RAG jobs", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      DEV_USER_IS_ADMIN: "true"
    });
    const app = buildApp({ settings, store });
    const session = await store.createDevelopmentSession(settings, "jobs-rag-login");
    const context = {
      userId: session.user.id,
      actorType: "admin" as const,
      permissions: ["user", "admin"],
      requestId: "jobs-rag-test",
      session
    };
    const document = await store.writeMarkdownDocument(context, {
      path: "/personal/retry.md",
      markdown: "# Retry\n\nNeeds indexing."
    });
    if ("code" in document) {
      throw new Error("unexpected markdown conflict");
    }
    const [job] = await store.claimRagIndexJobs(1, new Date());
    await store.markRagIndexJobDead(job.id, "embedding provider unavailable");
    await store.recordToolCall(context, {
      runId: null,
      toolName: "create_task",
      status: "rejected",
      arguments: {
        title: "bad",
        leaked: "super-secret-token"
      },
      result: {
        password: "super-secret-token"
      },
      validationError: "prompt is required"
    });

    const jobsResponse = await app.request("/api/v1/jobs", {
      headers: {
        cookie: cookieHeader(session.id)
      }
    });
    expect(jobsResponse.status).toBe(200);
    const jobsPayload = await jobsResponse.json() as {
      recentFailures: {
        ragJobs: Array<{ id: string; status: string; lastError: string | null }>;
        toolCalls: Array<Record<string, unknown>>;
      };
      jobs: Array<{ name: string; deadJobs?: number; status: string }>;
    };
    expect(jobsPayload.recentFailures.ragJobs).toEqual([
      expect.objectContaining({
        id: job.id,
        status: "dead",
        lastError: "embedding provider unavailable"
      })
    ]);
    expect(jobsPayload.recentFailures.toolCalls).toEqual([
      expect.objectContaining({
        toolName: "create_task",
        status: "rejected",
        validationError: "prompt is required"
      })
    ]);
    expect(jobsPayload.recentFailures.toolCalls[0]).not.toHaveProperty("arguments");
    expect(jobsPayload.recentFailures.toolCalls[0]).not.toHaveProperty("result");
    expect(JSON.stringify(jobsPayload.recentFailures.toolCalls)).not.toContain("super-secret-token");
    expect(jobsPayload.jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "rag-index",
        status: "degraded",
        deadJobs: 1
      })
    ]));

    const retryResponse = await app.request(`/api/v1/admin/rag-index-jobs/${job.id}/retry`, {
      method: "POST",
      headers: {
        cookie: cookieHeader(session.id)
      }
    });
    expect(retryResponse.status).toBe(200);
    await expect(retryResponse.json()).resolves.toMatchObject({
      job: {
        id: job.id,
        status: "pending",
        attempts: 0,
        lastError: null
      }
    });

    const [retried] = await store.claimRagIndexJobs(1, new Date());
    expect(retried).toMatchObject({
      id: job.id,
      status: "claimed",
      attempts: 1
    });

    const audit = await store.listAudit(context, true);
    expect(audit).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "rag.index_job.retry",
        entityId: job.id,
        details: expect.objectContaining({
          prior_attempts: 1,
          attempts: 0
        })
      })
    ]));
  });

  it("returns well-formed code-point-bounded semantic excerpts from memory", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({ APP_ENV: "test", AUTH_MODE: "standalone" });
    const session = await store.createDevelopmentSession(settings, "semantic-excerpt-login");
    const context = {
      userId: session.user.id,
      actorType: "user" as const,
      permissions: ["user"],
      requestId: "semantic-excerpt-test",
      session
    };
    const document = await store.writeMarkdownDocument(context, {
      path: "/assistant/unicode-excerpt.md",
      markdown: "# Unicode excerpt"
    });
    if ("code" in document) {
      throw new Error("unexpected markdown conflict");
    }
    const content = `bad\uD800${"a".repeat(315)}🚀tail`;
    await store.replaceDocumentChunks(context, document.id, [{
      id: "unicode-chunk",
      documentVersion: document.version,
      sectionId: "unicode-excerpt",
      headingPath: ["Unicode excerpt"],
      chunkIndex: 0,
      content,
      contentHash: "unicode-content-hash",
      qdrantPointId: "unicode-point",
      qdrantCollection: "unicode-collection",
      embeddingModel: "mock-embedding",
      embeddingDimensions: 4
    }]);

    const [result] = await store.searchMarkdownSemantic(context, {
      pointIds: ["unicode-point"],
      scoresByPointId: { "unicode-point": 0.9 }
    });

    expect(result?.excerpt).toBe(`bad\uFFFD${"a".repeat(315)}🚀`);
    expect(Array.from(result?.excerpt ?? "")).toHaveLength(320);
    expect(result?.excerpt).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it("reuses an equivalent active RAG request instead of reviving a conflicting failed job", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      DEV_USER_IS_ADMIN: "true"
    });
    const session = await store.createDevelopmentSession(settings, "rag-retry-coalescing-login");
    const context = {
      userId: session.user.id,
      actorType: "admin" as const,
      permissions: ["user", "admin"],
      requestId: "rag-retry-coalescing-test",
      session
    };
    const document = await store.writeMarkdownDocument(context, {
      path: "/personal/retry-coalescing.md",
      markdown: "# Retry coalescing\n\nOnly one active request should remain."
    });
    if ("code" in document) {
      throw new Error("unexpected markdown conflict");
    }
    const [failed] = await store.claimRagIndexJobs(1, new Date());
    await store.markRagIndexJobDead(failed.id, "first request exhausted retries");
    const active = await store.enqueueRagJob(context, document.id, "index_markdown");
    const [claimedActive] = await store.claimRagIndexJobs(1, new Date());
    expect(claimedActive).toMatchObject({ id: active.id, attempts: 1, status: "claimed" });

    await expect(store.retryRagIndexJob(context, failed.id, true)).resolves.toMatchObject({
      id: active.id,
      status: "claimed",
      attempts: 1
    });
    const jobs = await store.listRagIndexJobs(context, true);
    expect(jobs.filter((job) => (
      job.documentId === document.id && ["pending", "claimed"].includes(job.status)
    ))).toHaveLength(1);
    expect(jobs.find((job) => job.id === failed.id)).toMatchObject({ status: "dead" });
    const audit = await store.listAudit(context, true);
    expect(audit).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "rag.index_job.retry",
        entityId: failed.id,
        details: expect.objectContaining({
          requested_job_id: failed.id,
          active_job_id: active.id,
          reused_active_job: true,
          prior_attempts: 1,
          attempts: 1
        })
      })
    ]));
  });
});
