import { describe, expect, it } from "vitest";
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

    const auditResponse = await app.request("/api/v1/admin/audit", {
      headers: {
        cookie: cookieHeader(adminSession.id)
      }
    });
    expect(auditResponse.status).toBe(200);
    const auditPayload = await auditResponse.json() as { events: Array<{ action: string; userId: string | null }> };
    expect(auditPayload.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "task.create",
          userId: "normal"
        })
      ])
    );
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
      jobs: [
        expect.objectContaining({
          name: "task-runner",
          pendingTasks: 1,
          dueTasks: 1
        }),
        expect.objectContaining({
          name: "outbox"
        })
      ]
    });
  });
});
