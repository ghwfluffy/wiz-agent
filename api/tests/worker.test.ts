import { describe, expect, it, vi } from "vitest";
import type { ToolModelRequest } from "../src/agent/modelClient.js";
import { MockModelClient } from "../src/agent/modelClient.js";
import { loadSettings } from "../src/config/settings.js";
import { createMemoryStore } from "../src/domain/store.js";
import { buildScheduledTaskPrompt } from "../src/scheduler/autonomousTasks.js";
import { daemonOnce } from "../src/scheduler/taskQueue.js";
import { isWorkerEntrypoint, workerTick } from "../src/worker.js";

describe("worker loop", () => {
  it("detects the worker entrypoint when node receives a relative script path", () => {
    expect(isWorkerEntrypoint(new URL("../src/worker.ts", import.meta.url).href, "src/worker.ts")).toBe(true);
  });

  it("keeps newsletter, autonomous wake, and self-review tasks scheduled with durable rationale", async () => {
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
        prompt: expect.stringContaining("newsletters/"),
        scheduleRationale: "Default daily review of trusted newsletter knowledge.",
        recurrencePolicy: "daily at 17:00 local/server time"
      }),
      expect.objectContaining({
        title: "Autonomous agent wake review",
        prompt: expect.stringContaining("default 3-hour autonomous wake"),
        scheduleRationale: "Default autonomous review cadence for active tasks, owner context, and schedule rationale.",
        recurrencePolicy: "roughly every 3 hours"
      }),
      expect.objectContaining({
        title: "Assistant self-review",
        prompt: expect.stringContaining("get_recent_bot_activity"),
        scheduleRationale: "Default twice-daily self-review of assistant behavior and owner communication preferences.",
        recurrencePolicy: "twice daily around 09:00 and 21:00 local/server time"
      })
    ]));
    await expect(store.getMemoryDocument(context, "agent-schedule")).resolves.toMatchObject({
      body: expect.stringContaining("Assistant self-review")
    });
    await expect(store.getMarkdownDocument(context, "/tasks/schedule-rationale.md")).resolves.toMatchObject({
      markdown: expect.stringContaining("Schedule Rationale")
    });
    await expect(store.getMarkdownDocument(context, "/assistant/preferences/communication.md")).resolves.toMatchObject({
      markdown: expect.stringContaining("Communication Preferences")
    });
    await expect(store.getMarkdownDocument(context, "/assistant/preferences/newsletters.md")).resolves.toMatchObject({
      markdown: expect.stringContaining("Newsletter Preferences")
    });
  });

  it("builds a self-review prompt with activity and preference-memory guidance", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone"
    });
    const session = await store.createDevelopmentSession(settings, "worker-self-review-prompt-login");
    const context = {
      userId: session.user.id,
      actorType: "system" as const,
      permissions: ["user", "system"],
      requestId: "worker-self-review-prompt-test",
      session
    };

    await daemonOnce({
      store,
      context,
      settings,
      modelClient: new MockModelClient(),
      now: new Date("2026-06-13T08:00:00.000Z")
    });
    const task = (await store.listTasks(context)).find((entry) => entry.title === "Assistant self-review");
    expect(task).toBeTruthy();

    const prompt = await buildScheduledTaskPrompt({
      store,
      context,
      task: task!,
      now: new Date("2026-06-13T09:00:00.000Z")
    });

    expect(prompt).toContain("internal operational review");
    expect(prompt).toContain("Do not message the owner solely because this review ran");
    expect(prompt).toContain("Use get_recent_bot_activity");
    expect(prompt).toContain("/assistant/self-review/2026-06-13.md");
    expect(prompt).toContain("/assistant/preferences/communication.md");
    expect(prompt).toContain("Communication preferences:");
    expect(prompt).toContain("Preserve uncertainty");
  });

  it("lets self-review write a dated markdown note and records task/run events without outbound messages", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone"
    });
    const session = await store.createDevelopmentSession(settings, "worker-self-review-write-login");
    const context = {
      userId: session.user.id,
      actorType: "system" as const,
      permissions: ["user", "system"],
      requestId: "worker-self-review-write-test",
      session
    };

    await daemonOnce({
      store,
      context,
      settings,
      modelClient: new MockModelClient(),
      now: new Date("2026-06-13T08:00:00.000Z")
    });
    const selfReview = (await store.listTasks(context)).find((entry) => entry.title === "Assistant self-review");
    expect(selfReview).toBeTruthy();
    await store.updateTask(context, selfReview!.id, { dueAt: "2026-06-13T09:00:00.000Z" });

    const result = await daemonOnce({
      store,
      context,
      settings,
      modelClient: new MockModelClient({
        tools: [
          {
            toolName: "write_file",
            arguments: {
              path: "/assistant/self-review/2026-06-13.md",
              content: "# Self Review: 2026-06-13\n\n- Contact cadence: quiet.\n- Pending approvals: none.\n- Delivery failures: none.\n- Preference updates: none.",
              rationale: "Record compact operational self-review."
            }
          }
        ]
      }),
      now: new Date("2026-06-13T09:00:00.000Z")
    });

    expect(result).toMatchObject({ claimedTasks: 1, ranTasks: 1, outboundAttempted: 0 });
    await expect(store.getMarkdownDocument(context, "/assistant/self-review/2026-06-13.md")).resolves.toMatchObject({
      markdown: expect.stringContaining("Contact cadence: quiet")
    });
    await expect(store.getTask(context, selfReview!.id)).resolves.toMatchObject({ status: "completed" });
    await expect(store.listTaskEvents(context, selfReview!.id)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "agent.prompted" }),
      expect.objectContaining({ eventType: "scheduled_task.outcome" })
    ]));
    await expect(store.listToolCalls(context)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        toolName: "write_file",
        status: "accepted",
        result: expect.objectContaining({
          execution: expect.objectContaining({
            path: "/assistant/self-review/2026-06-13.md"
          })
        })
      })
    ]));
    await expect(store.listOutboundMessages(context)).resolves.toEqual([]);
    expect((await store.listTasks(context)).filter((entry) =>
      entry.title === "Assistant self-review" &&
      entry.status === "pending" &&
      entry.id !== selfReview!.id
    )).toHaveLength(1);
  });

  it("lets the autonomous wake reschedule another task with rationale and creates the next wake", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone"
    });
    const session = await store.createDevelopmentSession(settings, "worker-wake-reschedule-login");
    const context = {
      userId: session.user.id,
      actorType: "system" as const,
      permissions: ["user", "system"],
      requestId: "worker-wake-reschedule-test",
      session
    };
    const target = await store.createTask(context, {
      title: "Call the clinic",
      prompt: "Check appointment availability.",
      dueAt: "2026-06-16T14:00:00.000Z",
      scheduleRationale: "Initial owner request."
    });
    await store.createTask(context, {
      title: "Autonomous agent wake review",
      prompt: "Wake and reassess work.",
      dueAt: "2026-06-13T12:00:00.000Z",
      priority: 5,
      scheduleRationale: "Test wake.",
      recurrencePolicy: "roughly every 3 hours"
    });
    const dueAt = "2026-06-14T14:00:00.000Z";

    await daemonOnce({
      store,
      context,
      settings,
      modelClient: new MockModelClient({
        tools: [
          {
            toolName: "update_task_schedule",
            arguments: {
              taskId: target.id,
              dueAt,
              rationale: "Owner's recent context makes this worth checking before Monday.",
              confidence: "medium"
            }
          }
        ]
      }),
      now: new Date("2026-06-13T12:00:00.000Z")
    });

    await expect(store.getTask(context, target.id)).resolves.toMatchObject({
      dueAt,
      scheduleRationale: "Owner's recent context makes this worth checking before Monday."
    });
    const tasks = await store.listTasks(context);
    expect(tasks.filter((task) =>
      task.title === "Autonomous agent wake review" &&
      task.status === "pending" &&
      task.dueAt === "2026-06-13T15:00:00.000Z"
    )).toHaveLength(1);
  });

  it("schedules the next autonomous wake even when the wake run fails", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone"
    });
    const session = await store.createDevelopmentSession(settings, "worker-wake-failure-login");
    const context = {
      userId: session.user.id,
      actorType: "system" as const,
      permissions: ["user", "system"],
      requestId: "worker-wake-failure-test",
      session
    };
    const wake = await store.createTask(context, {
      title: "Autonomous agent wake review",
      prompt: "Wake and reassess work.",
      dueAt: "2026-06-13T12:00:00.000Z",
      priority: 5,
      scheduleRationale: "Test wake.",
      recurrencePolicy: "roughly every 3 hours"
    });

    const failingModel = {
      async runStructured() {
        return {};
      },
      async runWithTools(_request: ToolModelRequest) {
        throw new Error("model unavailable");
      },
      async repairToolArguments() {
        return {};
      }
    };

    await daemonOnce({
      store,
      context,
      settings,
      modelClient: failingModel,
      now: new Date("2026-06-13T12:00:00.000Z")
    });

    await expect(store.getTask(context, wake.id)).resolves.toMatchObject({
      status: "failed"
    });
    const tasks = await store.listTasks(context);
    expect(tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: "Autonomous agent wake review",
        status: "pending",
        dueAt: "2026-06-13T15:00:00.000Z"
      })
    ]));
    await expect(store.listTaskEvents(context, wake.id)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: "scheduled_task.failed",
        details: expect.objectContaining({
          failure_message: "model unavailable"
        })
      })
    ]));
  });

  it("schedules the next self-review even when the review run fails", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone"
    });
    const session = await store.createDevelopmentSession(settings, "worker-self-review-failure-login");
    const context = {
      userId: session.user.id,
      actorType: "system" as const,
      permissions: ["user", "system"],
      requestId: "worker-self-review-failure-test",
      session
    };
    const review = await store.createTask(context, {
      title: "Assistant self-review",
      prompt: "Run self-review.",
      dueAt: "2026-06-13T09:00:00.000Z",
      priority: 6,
      scheduleRationale: "Test self-review.",
      recurrencePolicy: "twice daily around 09:00 and 21:00 local/server time"
    });
    const failingModel = {
      async runStructured() {
        return {};
      },
      async runWithTools(_request: ToolModelRequest) {
        throw new Error("model unavailable");
      },
      async repairToolArguments() {
        return {};
      }
    };

    await daemonOnce({
      store,
      context,
      settings,
      modelClient: failingModel,
      now: new Date("2026-06-13T09:00:00.000Z")
    });

    await expect(store.getTask(context, review.id)).resolves.toMatchObject({ status: "failed" });
    expect((await store.listTasks(context)).filter((entry) =>
      entry.title === "Assistant self-review" &&
      entry.status === "pending" &&
      entry.id !== review.id
    )).toHaveLength(1);
    await expect(store.listTaskEvents(context, review.id)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: "scheduled_task.failed",
        details: expect.objectContaining({
          failure_message: "model unavailable"
        })
      })
    ]));
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
