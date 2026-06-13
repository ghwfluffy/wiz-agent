import { describe, expect, it, vi } from "vitest";
import { MockModelClient } from "../src/agent/modelClient.js";
import { loadSettings } from "../src/config/settings.js";
import { createMemoryStore } from "../src/domain/store.js";
import { daemonOnce } from "../src/scheduler/taskQueue.js";
import { isWorkerEntrypoint, workerTick } from "../src/worker.js";

describe("worker loop", () => {
  it("detects the worker entrypoint when node receives a relative script path", () => {
    expect(isWorkerEntrypoint(new URL("../src/worker.ts", import.meta.url).href, "src/worker.ts")).toBe(true);
  });

  it("keeps daily newsletter and autonomous wake tasks scheduled with durable rationale", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone"
    });
    const session = await store.createDevelopmentSession(settings, "worker-autonomous-login");
    const context = {
      userId: session.user.id,
      actorType: "system" as const,
      permissions: ["user", "system"],
      requestId: "worker-autonomous-test",
      session
    };

    await daemonOnce({
      store,
      context,
      settings,
      modelClient: new MockModelClient(),
      now: new Date("2026-06-13T12:00:00.000Z")
    });

    const tasks = await store.listTasks(context);
    expect(tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: "Daily newsletter synthesis",
        prompt: expect.stringContaining("newsletters/")
      }),
      expect.objectContaining({
        title: "Autonomous agent wake review",
        prompt: expect.stringContaining("default 3-hour autonomous wake")
      })
    ]));
    await expect(store.getMemoryDocument(context, "agent-schedule")).resolves.toMatchObject({
      body: expect.stringContaining("Default cadence: every 3 hours.")
    });
  });

  it("processes approved outbox records for OAuth users without a dashboard session", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "oauth"
    });
    const session = await store.createOauthSession(settings, {
      subject: "owner",
      email: "owner@example.test",
      displayName: "Owner",
      isAdmin: true,
      identityProvider: "central-oauth",
      requestId: "worker-login"
    });
    await store.setSenderStatus({
      userId: session.user.id,
      actorType: "system",
      permissions: ["user", "system"],
      requestId: "worker-owner-recipient",
      session
    }, "15555550100@sms.example.test", "owner");
    await store.queueOutboundMessage({
      userId: session.user.id,
      actorType: "system",
      permissions: ["user", "system"],
      requestId: "worker-test",
      session
    }, {
      channel: "sms",
      status: "approved",
      toAddr: "15555550100@sms.example.test",
      bodyText: "hello"
    });
    await store.upsertConnector({
      userId: session.user.id,
      actorType: "system",
      permissions: ["user", "system"],
      requestId: "worker-smtp-config",
      session
    }, {
      kind: "smtp",
      status: "enabled",
      config: {
        username: "sender@example.test",
        smtp: {
          host: "smtp.example.test",
          from: "sender@example.test",
          password: "secret"
        }
      }
    });
    const sendMail = vi.fn().mockResolvedValue({ accepted: ["15555550100@sms.example.test"] });

    const result = await workerTick({
      store,
      settings: loadSettings({
        APP_ENV: "test",
        AUTH_MODE: "oauth",
        AGENT_OUTBOUND_ENABLED: "true"
      }),
      mailTransport: { sendMail }
    });

    expect(result).toMatchObject({
      users: 1,
      outboundAttempted: 1,
      outboundSent: 1,
      outboundFailed: 0
    });
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("rate limits outbound delivery to one message per worker tick", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone"
    });
    const session = await store.createDevelopmentSession(settings, "worker-rate-login");
    const context = {
      userId: session.user.id,
      actorType: "system" as const,
      permissions: ["user", "system"],
      requestId: "worker-rate-test",
      session
    };
    await store.setSenderStatus(context, "1@sms.example.test", "owner");
    await store.setSenderStatus(context, "2@sms.example.test", "owner");
    for (const index of [1, 2]) {
      await store.queueOutboundMessage(context, {
        channel: "sms",
        status: "approved",
        toAddr: `${index}@sms.example.test`,
        bodyText: `message ${index}`
      });
    }
    await store.upsertConnector(context, {
      kind: "smtp",
      status: "enabled",
      config: {
        username: "sender@example.test",
        smtp: { host: "smtp.example.test", password: "secret" }
      }
    });
    const sendMail = vi.fn().mockResolvedValue({ accepted: ["ok"] });

    const result = await workerTick({
      store,
      settings: loadSettings({
        APP_ENV: "test",
        AGENT_OUTBOUND_ENABLED: "true"
      }),
      mailTransport: { sendMail }
    });

    expect(result.outboundAttempted).toBe(1);
    expect(sendMail).toHaveBeenCalledTimes(1);
    const messages = await store.listOutboundMessages(context);
    expect(messages.filter((message) => message.status === "sent")).toHaveLength(1);
    expect(messages.filter((message) => message.status === "approved")).toHaveLength(1);
  });

  it("delivers outbound messages even when IMAP processing fails", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone"
    });
    const session = await store.createDevelopmentSession(settings, "worker-outbound-before-imap-login");
    const context = {
      userId: session.user.id,
      actorType: "system" as const,
      permissions: ["user", "system"],
      requestId: "worker-outbound-before-imap-test",
      session
    };
    await store.setSenderStatus(context, "owner-sms@example.test", "owner");
    await store.queueOutboundMessage(context, {
      channel: "sms",
      status: "pending",
      toAddr: "owner-sms@example.test",
      bodyText: "review this sender"
    });
    await store.upsertConnector(context, {
      kind: "smtp",
      status: "enabled",
      config: {
        username: "sender@example.test",
        smtp: { host: "smtp.example.test", password: "secret" }
      }
    });
    await store.upsertConnector(context, {
      kind: "imap",
      status: "enabled",
      config: {
        username: "agent@example.test",
        imap: { host: "imap.example.test", password: "secret" }
      }
    });
    const sendMail = vi.fn().mockResolvedValue({ accepted: ["owner-sms@example.test"] });

    const result = await workerTick({
      store,
      settings: loadSettings({
        APP_ENV: "test",
        AGENT_OUTBOUND_ENABLED: "true"
      }),
      mailTransport: { sendMail },
      imapProcessor: async () => {
        throw new Error("IMAP unavailable");
      }
    });

    expect(result).toMatchObject({
      outboundAttempted: 1,
      outboundSent: 1,
      inboundFailed: 1
    });
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("records IMAP worker failures in user audit logs", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone"
    });
    const session = await store.createDevelopmentSession(settings, "worker-imap-login");
    const context = {
      userId: session.user.id,
      actorType: "system" as const,
      permissions: ["user", "system"],
      requestId: "worker-imap-test",
      session
    };
    await store.upsertConnector(context, {
      kind: "imap",
      status: "enabled",
      config: {
        username: "agent@example.test",
        imap: {
          host: "imap.example.test",
          password: "secret"
        }
      }
    });

    const result = await workerTick({
      store,
      settings,
      imapProcessor: async () => {
        throw Object.assign(new Error("Command failed"), {
          response: "NO IMAP disabled"
        });
      }
    });

    expect(result.inboundFailed).toBe(1);
    const audit = await store.listAudit(context, false);
    expect(audit[0]).toMatchObject({
      action: "worker.imap_error",
      entityType: "connector",
      entityId: "imap",
      details: expect.objectContaining({
        message: "Command failed",
        response: "NO IMAP disabled"
      })
    });
  });
});
