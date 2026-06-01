import { describe, expect, it, vi } from "vitest";
import { loadSettings } from "../src/config/settings.js";
import { createMemoryStore } from "../src/domain/store.js";
import { workerTick } from "../src/worker.js";

describe("worker loop", () => {
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
});
