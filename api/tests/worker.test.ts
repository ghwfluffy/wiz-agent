import { describe, expect, it, vi } from "vitest";
import type { ToolModelRequest } from "../src/agent/modelClient.js";
import { MockModelClient } from "../src/agent/modelClient.js";
import { loadSettings } from "../src/config/settings.js";
import { createMemoryStore } from "../src/domain/store.js";
import {
  buildScheduledTaskPrompt,
  DAILY_CHECK_IN_TITLE,
  ensureAutonomousTasks,
  nextDailyCheckInTime
} from "../src/scheduler/autonomousTasks.js";
import {
  DAILY_CHECK_IN_FALLBACK_MESSAGE,
  daemonOnce,
  recoverStuckWorkerState
} from "../src/scheduler/taskQueue.js";
import { recordTaskOutcomeMemory } from "../src/memory/taskOutcomeMemory.js";
import {
  OWNER_SCHEDULED_MESSAGE_RECURRENCE,
  scheduledOwnerMessagePrompt
} from "../src/tools/ownerMessaging.js";
import { createNonOverlappingRunner, isWorkerEntrypoint, workerTick } from "../src/worker.js";
import type { WebResearchClient } from "../src/research/openAiWebResearchClient.js";

function stubWebResearch(answer: string): WebResearchClient {
  return {
    research: async () => ({
      riskLevel: "clean",
      bundle: {
        status: "ok",
        answer,
        claims: [{ id: "c1", text: answer, sourceIds: ["source-original"] }],
        entities: [],
        sources: [{
          id: "source-original",
          url: "https://1.1.1.1/newsletter-story",
          title: "Provider-supplied title",
          publishedAt: null
        }],
        warnings: [],
        taint: "external_web",
        searchedAt: "2026-06-16T17:00:00.000Z"
      }
    })
  };
}

describe("worker loop", () => {
  it("detects the worker entrypoint when node receives a relative script path", () => {
    expect(isWorkerEntrypoint(new URL("../src/worker.ts", import.meta.url).href, "src/worker.ts")).toBe(true);
  });

  it("does not overlap worker ticks", async () => {
    let release: (() => void) | undefined;
    const work = vi.fn(() => new Promise<void>((resolve) => {
      release = resolve;
    }));
    const run = createNonOverlappingRunner(work);

    const first = run();
    await Promise.resolve();
    await expect(run()).resolves.toBe(false);
    expect(work).toHaveBeenCalledTimes(1);

    release?.();
    await expect(first).resolves.toBe(true);
  });

  it("schedules the daily check-in at 17:00 in the owner's timezone with UTC fallback", () => {
    expect(nextDailyCheckInTime(
      new Date("2026-08-17T21:59:00.000Z"),
      "America/Chicago"
    ).toISOString()).toBe("2026-08-17T22:00:00.000Z");
    expect(nextDailyCheckInTime(
      new Date("2026-08-17T22:00:00.000Z"),
      "America/Chicago"
    ).toISOString()).toBe("2026-08-18T22:00:00.000Z");
    expect(nextDailyCheckInTime(
      new Date("2026-08-17T12:00:00.000Z"),
      "not/a-timezone"
    ).toISOString()).toBe("2026-08-17T17:00:00.000Z");
  });

  it("uses the timezone carried on the authenticated owner when reconciling daily work", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({ APP_ENV: "test", AUTH_MODE: "standalone" });
    const session = await store.createDevelopmentSession(settings, "worker-owner-timezone-login");
    session.user.timezone = "America/Chicago";
    const context = {
      userId: session.user.id,
      actorType: "system" as const,
      permissions: ["user", "system"],
      requestId: "worker-owner-timezone-test",
      session
    };

    await ensureAutonomousTasks({
      store,
      context,
      now: new Date("2026-08-17T21:59:00.000Z")
    });

    await expect(store.listTasks(context)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: DAILY_CHECK_IN_TITLE,
        dueAt: "2026-08-17T22:00:00.000Z"
      })
    ]));
  });

  it("keeps the daily check-in, autonomous wake, self-review, and memory-review tasks scheduled with durable rationale", async () => {
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
        title: DAILY_CHECK_IN_TITLE,
        prompt: expect.stringContaining("not a daily digest"),
        scheduleRationale: "Default daily conversational owner check-in with an optional newsletter-derived icebreaker.",
        recurrencePolicy: "daily conversational check-in around 17:00 in the owner's configured timezone"
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
      }),
      expect.objectContaining({
        title: "Memory quality review",
        prompt: expect.stringContaining("/assistant/memory-review/2026-06.md"),
        scheduleRationale: "Default weekly memory quality review of durable memory, lists, task outcomes, newsletter-interest notes, and self-review notes.",
        recurrencePolicy: "weekly around Sunday 10:00 local/server time"
      })
    ]));
    await expect(store.getMemoryDocument(context, "agent-schedule")).resolves.toMatchObject({
      body: expect.stringContaining("Memory quality review")
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

  it("keeps schedule bootstrap idempotent instead of rewriting schedule markdown every reconciliation", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({ APP_ENV: "test", AUTH_MODE: "standalone" });
    const session = await store.createDevelopmentSession(settings, "worker-stable-schedule-login");
    const context = {
      userId: session.user.id,
      actorType: "system" as const,
      permissions: ["user", "system"],
      requestId: "worker-stable-schedule-test",
      session
    };

    await ensureAutonomousTasks({
      store,
      context,
      now: new Date("2026-06-13T12:00:00.000Z")
    });
    const firstDocument = await store.getMarkdownDocument(context, "/assistant/schedule.md");
    const firstJobs = (await store.listRagIndexJobs(context, false))
      .filter((job) => job.documentId === firstDocument?.id);

    await ensureAutonomousTasks({
      store,
      context,
      now: new Date("2026-06-13T12:00:20.000Z")
    });
    const secondDocument = await store.getMarkdownDocument(context, "/assistant/schedule.md");
    const secondJobs = (await store.listRagIndexJobs(context, false))
      .filter((job) => job.documentId === secondDocument?.id);

    expect(secondDocument).toMatchObject({
      id: firstDocument?.id,
      version: firstDocument?.version,
      updatedAt: firstDocument?.updatedAt
    });
    expect(secondJobs).toHaveLength(firstJobs.length);
    expect(secondDocument?.markdown).not.toContain("Last host schedule reconciliation");
  });

  it("cancels duplicate pending recurring tasks and leaves one active task per recurrence", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({ APP_ENV: "test", AUTH_MODE: "standalone" });
    const session = await store.createDevelopmentSession(settings, "worker-recurring-dedupe-login");
    const context = {
      userId: session.user.id,
      actorType: "system" as const,
      permissions: ["user", "system"],
      requestId: "worker-recurring-dedupe-test",
      session
    };
    await store.createTask(context, {
      title: "Newsletter interest check",
      prompt: "Old check-in.",
      dueAt: "2026-06-13T17:00:00.000Z"
    });
    await store.createTask(context, {
      title: DAILY_CHECK_IN_TITLE,
      prompt: "Duplicate new check-in.",
      dueAt: "2026-06-14T17:00:00.000Z"
    });
    await store.createTask(context, {
      title: "Autonomous agent wake review",
      prompt: "First wake.",
      dueAt: "2026-06-13T15:00:00.000Z"
    });
    await store.createTask(context, {
      title: "Autonomous agent wake review",
      prompt: "Duplicate wake.",
      dueAt: "2026-06-13T16:00:00.000Z"
    });

    await expect(ensureAutonomousTasks({
      store,
      context,
      now: new Date("2026-06-13T12:00:00.000Z")
    })).resolves.toMatchObject({ cancelledDuplicates: 2 });

    const tasks = await store.listTasks(context);
    expect(tasks.filter((task) =>
      ["Newsletter interest check", DAILY_CHECK_IN_TITLE].includes(task.title) && task.status === "pending"
    )).toHaveLength(1);
    expect(tasks.filter((task) => task.title === "Autonomous agent wake review" && task.status === "pending"))
      .toHaveLength(1);
    expect(tasks.filter((task) => task.status === "cancelled")).toHaveLength(2);
  });

  it("bounds scheduled agent runs claimed in one worker tick", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      AGENT_MAX_AUTONOMOUS_RUNS_PER_WORKER_TICK: "1"
    });
    const session = await store.createDevelopmentSession(settings, "worker-run-guardrail-login");
    const context = {
      userId: session.user.id,
      actorType: "system" as const,
      permissions: ["user", "system"],
      requestId: "worker-run-guardrail-test",
      session
    };
    await store.createTask(context, {
      title: "Due task one",
      prompt: "Run first.",
      dueAt: "2026-06-13T12:00:00.000Z"
    });
    await store.createTask(context, {
      title: "Due task two",
      prompt: "Run second.",
      dueAt: "2026-06-13T12:00:00.000Z"
    });

    const result = await daemonOnce({
      store,
      context,
      settings,
      modelClient: new MockModelClient({
        tools: [
          {
            toolName: "record_observation",
            arguments: {
              summary: "One bounded task ran.",
              source: "unit-test"
            }
          }
        ]
      }),
      now: new Date("2026-06-13T12:00:00.000Z")
    });

    expect(result).toMatchObject({ claimedTasks: 1, ranTasks: 1 });
    const tasks = await store.listTasks(context);
    expect(tasks.filter((task) => task.status === "completed")).toHaveLength(1);
    expect(tasks.filter((task) => task.status === "pending" && task.title.startsWith("Due task"))).toHaveLength(1);
  });

  it("reconciles recurring tasks for signed-in users even when they have no due work yet", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone"
    });
    const session = await store.createDevelopmentSession(settings, "worker-idle-reconcile-login");
    const context = {
      userId: session.user.id,
      actorType: "system" as const,
      permissions: ["user", "system"],
      requestId: "worker-idle-reconcile-test",
      session
    };

    const result = await workerTick({
      store,
      settings,
      modelClient: new MockModelClient(),
      imapProcessor: async () => ({ attempted: 0, recorded: 0, failed: 0 }),
      now: new Date("2026-06-13T12:00:00.000Z")
    });

    expect(result.users).toBe(1);
    await expect(store.listTasks(context)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ title: DAILY_CHECK_IN_TITLE, status: "pending" }),
      expect.objectContaining({ title: "Autonomous agent wake review", status: "pending" }),
      expect.objectContaining({ title: "Assistant self-review", status: "pending" }),
      expect.objectContaining({ title: "Memory quality review", status: "pending" })
    ]));
  });

  it("passes an owner-scoped signed integration provider to inbound IMAP agent work", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "oauth",
      AGENT_INTEGRATION_TOKEN_SECRET: "test-worker-integration-secret",
      OMNI_DEV_API_BASE_URL: "https://omni.example.test/api/agent/v1"
    });
    const session = await store.createOauthSession(settings, {
      subject: "owner-subject",
      email: "owner@example.test",
      displayName: "Owner",
      isAdmin: true,
      identityProvider: "central-oauth",
      requestId: "worker-integration-login"
    });
    let claims: Record<string, unknown> | undefined;

    const result = await workerTick({
      store,
      settings,
      modelClient: new MockModelClient(),
      imapProcessor: async (options) => {
        const token = await options.integrationTokenProvider?.tokenFor(
          options.context,
          "omni_dev",
          "omni_dev.create_job"
        );
        const payload = token?.split(".")[1];
        claims = payload
          ? JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>
          : undefined;
        return { configured: true, attempted: 0, recorded: 0, failed: 0 };
      }
    });

    expect(result.users).toBe(1);
    expect(session.user.id).toBe("oauth:central-oauth:owner-subject");
    expect(claims).toMatchObject({
      aud: "omni_dev",
      iss: "agent-service",
      scope: "omni_dev.create_job",
      sub: "owner-subject"
    });
  });

  it("fails stale claimed recurring tasks visibly and schedules the next recurrence", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone"
    });
    const session = await store.createDevelopmentSession(settings, "worker-stale-task-login");
    const context = {
      userId: session.user.id,
      actorType: "system" as const,
      permissions: ["user", "system"],
      requestId: "worker-stale-task-test",
      session
    };
    const task = await store.createTask(context, {
      title: "Autonomous agent wake review",
      prompt: "Wake and reassess work.",
      dueAt: new Date().toISOString(),
      priority: 5,
      scheduleRationale: "Test stale claim recovery.",
      recurrencePolicy: "roughly every 3 hours"
    });
    await store.claimDueTasks(context, 1, new Date(Date.now() + 1000));

    const result = await daemonOnce({
      store,
      context,
      settings,
      modelClient: new MockModelClient(),
      now: new Date(Date.now() + 31 * 60_000)
    });

    expect(result).toMatchObject({ recoveredTasks: 1, claimedTasks: 0 });
    await expect(store.getTask(context, task.id)).resolves.toMatchObject({
      status: "failed",
      blockedReason: "Worker claim expired before completion."
    });
    await expect(store.listTaskEvents(context, task.id)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: "scheduled_task.failed",
        details: expect.objectContaining({
          failure_message: "Worker claim expired before completion."
        })
      })
    ]));
    expect((await store.listTasks(context)).filter((entry) =>
      entry.title === "Autonomous agent wake review" &&
      entry.status === "pending" &&
      entry.id !== task.id
    )).toHaveLength(1);
    await expect(store.getMarkdownDocument(context, `/tasks/outcomes/${new Date(Date.now() + 31 * 60_000).toISOString().slice(0, 7)}.md`))
      .resolves.toMatchObject({
        markdown: expect.stringContaining(`<!-- task-outcome:${task.id}:failed -->`)
      });
    await expect(store.listAudit(context, false)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "worker.recovered_task_claim", entityId: task.id })
    ]));
  });

  it("ensures today's fallback outbox before rolling a stale claimed daily task", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({ APP_ENV: "test", AUTH_MODE: "standalone" });
    const session = await store.createDevelopmentSession(settings, "worker-stale-daily-login");
    const context = {
      userId: session.user.id,
      actorType: "system" as const,
      permissions: ["user", "system"],
      requestId: "worker-stale-daily-test",
      session
    };
    await store.upsertConnector(context, {
      kind: "owner-contact",
      status: "enabled",
      config: { sms_gateway: "owner-sms@example.test" }
    });
    const createdAt = new Date("2026-08-18T17:00:00.000Z");
    const task = await store.createTask(context, {
      title: DAILY_CHECK_IN_TITLE,
      prompt: "Stale daily check-in.",
      dueAt: createdAt.toISOString()
    });
    await store.claimDueTasks(context, 1, createdAt);

    await recoverStuckWorkerState({
      store,
      context,
      settings,
      now: new Date("2026-08-18T17:31:00.000Z")
    });

    await expect(store.getTask(context, task.id)).resolves.toMatchObject({ status: "failed" });
    await expect(store.listOutboundMessages(context)).resolves.toEqual([
      expect.objectContaining({
        status: "pending",
        bodyText: DAILY_CHECK_IN_FALLBACK_MESSAGE,
        dedupeKey: "daily-check-in:2026-08-18"
      })
    ]);
    expect((await store.listTasks(context)).filter((entry) =>
      entry.title === DAILY_CHECK_IN_TITLE && entry.status === "pending" && entry.id !== task.id
    )).toHaveLength(1);
  });

  it("marks stale sending outbox records failed without retrying delivery", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      AGENT_OUTBOUND_ENABLED: "true"
    });
    const session = await store.createDevelopmentSession(settings, "worker-stale-outbox-login");
    const context = {
      userId: session.user.id,
      actorType: "system" as const,
      permissions: ["user", "system"],
      requestId: "worker-stale-outbox-test",
      session
    };
    const message = await store.queueOutboundMessage(context, {
      channel: "sms",
      status: "approved",
      toAddr: "owner-sms@example.test",
      bodyText: "Possibly already attempted."
    });
    await store.updateOutboundMessageStatus(context, message.id, "sending");
    const sendMail = vi.fn();

    const result = await daemonOnce({
      store,
      context,
      settings,
      mailTransport: { sendMail },
      now: new Date(Date.now() + 31 * 60_000)
    });

    expect(result).toMatchObject({ recoveredOutbound: 1, outboundAttempted: 0 });
    expect(sendMail).not.toHaveBeenCalled();
    await expect(store.listOutboundMessages(context)).resolves.toEqual([
      expect.objectContaining({
        id: message.id,
        status: "failed",
        failureMessage: "Outbound delivery attempt expired before completion."
      })
    ]);
  });

  it("requeues a stale sending daily check-in on the same durable outbox row", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({ APP_ENV: "test", AUTH_MODE: "standalone" });
    const session = await store.createDevelopmentSession(settings, "worker-stale-daily-outbox-login");
    const context = {
      userId: session.user.id,
      actorType: "system" as const,
      permissions: ["user", "system"],
      requestId: "worker-stale-daily-outbox-test",
      session
    };
    const message = await store.queueOutboundMessage(context, {
      channel: "sms",
      status: "pending",
      toAddr: "owner-sms@example.test",
      bodyText: DAILY_CHECK_IN_FALLBACK_MESSAGE,
      origin: "daily_check_in_fallback",
      isProactive: true,
      dedupeKey: "daily-check-in:2026-08-18"
    });
    await store.claimOutboundMessageForSending(context, message.id);

    const recovery = await recoverStuckWorkerState({
      store,
      context,
      settings,
      now: new Date(Date.now() + 31 * 60_000)
    });

    expect(recovery.recoveredOutbound).toBe(1);
    await expect(store.listOutboundMessages(context)).resolves.toEqual([
      expect.objectContaining({
        id: message.id,
        status: "pending",
        deliveryAttempts: 1,
        dedupeKey: "daily-check-in:2026-08-18"
      })
    ]);
  });

  it("marks stale running cross-app approvals failed without executing them again", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      DEV_USER_ID: "oauth:central-oauth:owner-subject",
      GOALS_API_BASE_URL: "https://goals.example.test",
      AGENT_INTEGRATION_TOKEN_SECRET: "test-signing-secret"
    });
    const session = await store.createDevelopmentSession(settings, "worker-stale-approval-login");
    const context = {
      userId: session.user.id,
      actorType: "system" as const,
      permissions: ["user", "system"],
      requestId: "worker-stale-approval-test",
      session
    };
    const approval = await store.createApproval(context, {
      actionType: "cross_app_write_action",
      proposedPayload: {
        action_id: "goals.create_goal",
        body: { title: "Already attempted" }
      },
      riskLevel: "high",
      summary: "Create goal",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    await store.updateApprovalStatus(context, approval.id, "approved", context.userId);
    await store.claimApprovalExecution(context, approval.id);
    const fetchMock = vi.fn();

    const result = await daemonOnce({
      store,
      context,
      settings,
      fetchImpl: fetchMock,
      now: new Date(Date.now() + 31 * 60_000)
    });

    expect(result).toMatchObject({ recoveredApprovalExecutions: 1, approvalExecutionAttempted: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(store.getApproval(context, approval.id)).resolves.toMatchObject({
      executionStatus: "failed",
      executionError: "approval_execution_expired"
    });
  });

  it("expires stale pending approvals and cancels linked approval outbox records", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone"
    });
    const session = await store.createDevelopmentSession(settings, "worker-expired-approval-login");
    const context = {
      userId: session.user.id,
      actorType: "system" as const,
      permissions: ["user", "system"],
      requestId: "worker-expired-approval-test",
      session
    };
    const approval = await store.createApproval(context, {
      actionType: "send_outbound_message",
      proposedPayload: {
        channel: "sms",
        to_addr: "owner-sms@example.test",
        body_text: "Expired approval message."
      },
      riskLevel: "high",
      summary: "Send expired message",
      expiresAt: new Date(Date.now() - 1000).toISOString()
    });
    const outbound = await store.queueOutboundMessage(context, {
      channel: "sms",
      status: "requires_approval",
      toAddr: "owner-sms@example.test",
      bodyText: "Expired approval message.",
      approvalId: approval.id
    });
    await store.updateApprovalPayload(context, approval.id, {
      ...approval.proposedPayload,
      outbound_message_id: outbound.id
    });

    const result = await daemonOnce({
      store,
      context,
      settings,
      now: new Date()
    });

    expect(result.expiredApprovals).toBe(1);
    await expect(store.getApproval(context, approval.id)).resolves.toMatchObject({ status: "expired" });
    await expect(store.listOutboundMessages(context)).resolves.toEqual([
      expect.objectContaining({ id: outbound.id, status: "cancelled" })
    ]);
    await expect(store.listAudit(context, false)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "worker.expired_approval", entityId: approval.id })
    ]));
  });

  it("delivers due owner-scheduled messages without another model decision or approval", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      AGENT_OUTBOUND_ENABLED: "true"
    });
    const session = await store.createDevelopmentSession(settings, "worker-owner-message-login");
    const context = {
      userId: session.user.id,
      actorType: "system" as const,
      permissions: ["user", "system"],
      requestId: "worker-owner-message-test",
      session
    };
    await store.upsertConnector(context, {
      kind: "owner-contact",
      status: "enabled",
      config: { sms_gateway: "owner-sms@example.test" }
    });
    await store.upsertConnector(context, {
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
    const task = await store.createTask(context, {
      title: "Send owner message",
      prompt: scheduledOwnerMessagePrompt({
        body: "This is your scheduled reminder.",
        subject: "Reminder"
      }),
      dueAt: "2026-06-18T22:00:00.000Z",
      priority: 80,
      scheduleRationale: "Owner asked for a message in a couple hours.",
      recurrencePolicy: OWNER_SCHEDULED_MESSAGE_RECURRENCE
    });
    const sendMail = vi.fn().mockResolvedValue({ accepted: ["owner-sms@example.test"] });

    const result = await daemonOnce({
      store,
      context,
      settings,
      modelClient: new MockModelClient({
        tools: [
          {
            toolName: "record_observation",
            arguments: {
              summary: "This should not be used for the owner message.",
              source: "unexpected-model-path"
            }
          }
        ]
      }),
      mailTransport: { sendMail },
      now: new Date("2026-06-18T22:00:00.000Z")
    });

    expect(result).toMatchObject({
      claimedTasks: 1,
      ranTasks: 1,
      outboundAttempted: 1,
      outboundSent: 1
    });
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
      to: "owner-sms@example.test",
      subject: "Reminder",
      text: "This is your scheduled reminder."
    }));
    await expect(store.listApprovals(context, ["pending"])).resolves.toEqual([]);
    await expect(store.listAgentRuns(context)).resolves.toEqual([]);
    await expect(store.getTask(context, task.id)).resolves.toMatchObject({ status: "completed" });
    await expect(store.listOutboundMessages(context)).resolves.toEqual([
      expect.objectContaining({
        status: "sent",
        approvalId: null,
        bodyText: "This is your scheduled reminder."
      })
    ]);
  });

  it("falls back to SMS when a researched daily check-in has no MMS destination", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      AGENT_OUTBOUND_ENABLED: "true",
      AGENT_OPENAI_API_KEY: "test-key",
      AGENT_WEB_RESEARCH_ENABLED: "true"
    });
    const session = await store.createDevelopmentSession(settings, "worker-newsletter-contact-login");
    const context = {
      userId: session.user.id,
      actorType: "system" as const,
      permissions: ["user", "system"],
      requestId: "worker-newsletter-contact-test",
      session
    };
    await store.upsertConnector(context, {
      kind: "owner-contact",
      status: "enabled",
      config: { sms_gateway: "owner-sms@example.test" }
    });
    await store.upsertConnector(context, {
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
    await store.createTask(context, {
      title: "Newsletter interest check",
      prompt: "You woke up for the newsletter interest check.",
      dueAt: "2026-06-16T17:00:00.000Z",
      scheduleRationale: "Preference-aware daily newsletter interest check.",
      recurrencePolicy: "preference-aware daily interest check around 17:00 local/server time"
    });
    const sendMail = vi.fn().mockResolvedValue({ accepted: ["owner-sms@example.test"] });

    const result = await daemonOnce({
      store,
      context,
      settings,
      modelClient: new MockModelClient({
        tools: [
          {
            toolName: "web_research",
            arguments: {
              query: "Find current details about the concrete newsletter discovery.",
              sourceNewsletterPaths: [],
              rationale: "The item appears unusually relevant to the owner."
            }
          }
        ]
      }),
      webResearchClient: stubWebResearch("Cool newsletter find: one concrete thing worth checking later."),
      mailTransport: { sendMail },
      now: new Date("2026-06-16T17:00:00.000Z")
    });

    expect(result).toMatchObject({
      claimedTasks: 1,
      ranTasks: 1,
      outboundAttempted: 1,
      outboundSent: 1
    });
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: "owner-sms@example.test" }));
    await expect(store.listApprovals(context, ["pending"])).resolves.toEqual([]);
    await expect(store.listOutboundMessages(context)).resolves.toEqual([
      expect.objectContaining({
        status: "sent",
        approvalId: null,
        channel: "sms",
        origin: "daily_check_in_newsletter_research",
        isProactive: true,
        bodyText: expect.stringContaining("Cool newsletter find: one concrete thing worth checking later.")
      })
    ]);
    expect((await store.listOutboundMessages(context))[0]?.bodyText).toContain("What's up?");
  });

  it("keeps an existing legacy newsletter synthesis task from duplicating and rolls it forward to interest checks", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone"
    });
    const session = await store.createDevelopmentSession(settings, "worker-legacy-newsletter-login");
    const context = {
      userId: session.user.id,
      actorType: "system" as const,
      permissions: ["user", "system"],
      requestId: "worker-legacy-newsletter-test",
      session
    };
    await store.upsertConnector(context, {
      kind: "owner-contact",
      status: "enabled",
      config: { sms_gateway: "owner-sms@example.test" }
    });
    const legacyTask = await store.createTask(context, {
      title: "Daily newsletter synthesis",
      prompt: "Legacy newsletter task.",
      dueAt: "2026-06-13T17:00:00.000Z",
      scheduleRationale: "Existing task from before newsletter interest checks.",
      recurrencePolicy: "daily newsletter synthesis"
    });

    await daemonOnce({
      store,
      context,
      settings,
      modelClient: new MockModelClient(),
      now: new Date("2026-06-13T12:00:00.000Z")
    });

    expect((await store.listTasks(context)).filter((entry) =>
      ["Daily newsletter synthesis", "Newsletter interest check", DAILY_CHECK_IN_TITLE].includes(entry.title) &&
      !["completed", "cancelled", "failed"].includes(entry.status)
    )).toHaveLength(1);

    await daemonOnce({
      store,
      context,
      settings,
      modelClient: new MockModelClient({
        tools: [
          {
            toolName: "record_observation",
            arguments: {
              summary: "Stayed quiet and switch future checks to conversational interest timing.",
              source: "newsletter_interest_check"
            }
          }
        ]
      }),
      now: new Date("2026-06-13T17:00:00.000Z")
    });

    await expect(store.getTask(context, legacyTask.id)).resolves.toMatchObject({ status: "completed" });
    expect((await store.listTasks(context)).filter((entry) =>
      entry.title === DAILY_CHECK_IN_TITLE &&
      entry.status === "pending" &&
      entry.sourceTaskId === legacyTask.id
    )).toHaveLength(1);
  });

  it("builds a newsletter interest prompt with preferences, activity evidence, and conversational timing guidance", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone"
    });
    const session = await store.createDevelopmentSession(settings, "worker-newsletter-prompt-login");
    const context = {
      userId: session.user.id,
      actorType: "system" as const,
      permissions: ["user", "system"],
      requestId: "worker-newsletter-prompt-test",
      session
    };
    await store.writeMarkdownDocument(context, {
      path: "/newsletters/2026-06-13/infra-weekly.md",
      markdown: "# Infra Weekly\n\nA surprising database outage writeup."
    });
    await store.writeMarkdownDocument(context, {
      path: "/assistant/preferences/newsletters.md",
      markdown: "# Newsletter Preferences\n\n- Mention weird infrastructure and agent tooling only when it is genuinely useful."
    });
    await store.writeMarkdownDocument(context, {
      path: "/assistant/preferences/communication.md",
      markdown: "# Communication Preferences\n\n- Prefer fewer proactive messages when approvals are already pending."
    });
    await store.queueOutboundMessage(context, {
      channel: "sms",
      status: "requires_approval",
      toAddr: "owner-sms@example.test",
      bodyText: "Newsletter note: previous item is waiting."
    });

    await daemonOnce({
      store,
      context,
      settings,
      modelClient: new MockModelClient(),
      now: new Date("2026-06-13T12:00:00.000Z")
    });
    const task = (await store.listTasks(context)).find((entry) => entry.title === DAILY_CHECK_IN_TITLE);
    expect(task).toBeTruthy();

    const prompt = await buildScheduledTaskPrompt({
      store,
      context,
      task: task!,
      now: new Date()
    });

    expect(prompt).toContain("This is not a daily digest");
    expect(prompt).toContain("host prompt includes proactive contact cadence");
    expect(prompt).toContain("/assistant/preferences/newsletters.md");
    expect(prompt).toContain("Communication preferences:");
    expect(prompt).toContain("Newsletter preferences:");
    expect(prompt).toContain("Recent bot activity evidence for newsletter timing:");
    expect(prompt).toContain("pending_approvals=");
    expect(prompt).toContain("owner_visible_contact_attempts=");
    expect(prompt).toContain("host will still queue a short fixed 'what's up?' check-in");
    expect(prompt).toContain("A surprising database outage writeup");
  });

  it("keeps recent appended preferences and the newest newsletter files in the bounded check-in prompt", async () => {
    vi.useFakeTimers();
    try {
      const store = createMemoryStore();
      const settings = loadSettings({
        APP_ENV: "test",
        AUTH_MODE: "standalone",
        AGENT_MAX_NEWSLETTER_DOCUMENTS_PER_INTEREST_CHECK: "5"
      });
      const session = await store.createDevelopmentSession(settings, "worker-recent-newsletter-context-login");
      const context = {
        userId: session.user.id,
        actorType: "system" as const,
        permissions: ["user", "system"],
        requestId: "worker-recent-newsletter-context-test",
        session
      };
      await store.writeMarkdownDocument(context, {
        path: "/assistant/preferences/newsletters.md",
        markdown: `# Newsletter Preferences\n\n${"older preference filler ".repeat(90)}\n\n- RECENT-APPENDED-INTEREST: space launch systems.`
      });
      vi.setSystemTime(new Date("2026-06-13T08:00:00.000Z"));
      for (const name of ["a", "b", "c", "d", "e"]) {
        await store.writeMarkdownDocument(context, {
          path: `/newsletters/2026-06-13/${name}.md`,
          markdown: `# ${name}\n\nOlder item ${name}.`
        });
      }
      vi.setSystemTime(new Date("2026-06-13T09:00:00.000Z"));
      await store.writeMarkdownDocument(context, {
        path: "/newsletters/2026-06-13/z-newest.md",
        markdown: "# Newest\n\nNEWEST-NEWSLETTER-MARKER"
      });
      const task = await store.createTask(context, {
        title: DAILY_CHECK_IN_TITLE,
        prompt: "Run daily check-in.",
        dueAt: "2026-06-13T17:00:00.000Z"
      });

      const prompt = await buildScheduledTaskPrompt({
        store,
        context,
        task,
        settings,
        now: new Date("2026-06-13T17:00:00.000Z")
      });

      expect(prompt).toContain("RECENT-APPENDED-INTEREST");
      expect(prompt).toContain("NEWEST-NEWSLETTER-MARKER");
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors the newsletter document guardrail when composing interest prompts", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      AGENT_MAX_NEWSLETTER_DOCUMENTS_PER_INTEREST_CHECK: "2"
    });
    const session = await store.createDevelopmentSession(settings, "worker-newsletter-budget-login");
    const context = {
      userId: session.user.id,
      actorType: "system" as const,
      permissions: ["user", "system"],
      requestId: "worker-newsletter-budget-test",
      session
    };
    for (const filename of ["one.md", "two.md", "three.md"]) {
      await store.writeMarkdownDocument(context, {
        path: `/newsletters/2026-06-13/${filename}`,
        markdown: `# ${filename}\n\nMarker ${filename}`
      });
    }
    const task = await store.createTask(context, {
      title: "Newsletter interest check",
      prompt: "Run newsletter interest check.",
      dueAt: "2026-06-13T17:00:00.000Z"
    });

    const prompt = await buildScheduledTaskPrompt({
      store,
      context,
      task,
      settings,
      now: new Date("2026-06-13T17:00:00.000Z")
    });

    const includedNewsletterDocuments = prompt.match(/\/newsletters\/2026-06-13\//g) ?? [];
    expect(includedNewsletterDocuments).toHaveLength(2);
  });

  it("queues the fixed conversational fallback when a daily check-in has no newsletter icebreaker", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      AGENT_OUTBOUND_ENABLED: "true"
    });
    const session = await store.createDevelopmentSession(settings, "worker-newsletter-quiet-login");
    const context = {
      userId: session.user.id,
      actorType: "system" as const,
      permissions: ["user", "system"],
      requestId: "worker-newsletter-quiet-test",
      session
    };
    await store.upsertConnector(context, {
      kind: "owner-contact",
      status: "enabled",
      config: { sms_gateway: "owner-sms@example.test" }
    });
    await store.upsertConnector(context, {
      kind: "smtp",
      status: "enabled",
      config: {
        username: "sender@example.test",
        smtp: { host: "smtp.example.test", from: "sender@example.test", password: "secret" }
      }
    });
    const task = await store.createTask(context, {
      title: "Newsletter interest check",
      prompt: "Run newsletter interest check.",
      dueAt: "2026-06-13T17:00:00.000Z",
      scheduleRationale: "Test quiet newsletter check.",
      recurrencePolicy: "preference-aware daily interest check around 17:00 local/server time"
    });

    const sendMail = vi.fn().mockResolvedValue({ accepted: ["owner-sms@example.test"] });
    const result = await daemonOnce({
      store,
      context,
      settings,
      modelClient: new MockModelClient({
        tools: [
          {
            toolName: "record_observation",
            arguments: {
              summary: "Stayed quiet: recent newsletter material was routine and an approval was already pending.",
              source: "newsletter_interest_check"
            }
          }
        ]
      }),
      mailTransport: { sendMail },
      now: new Date("2026-06-13T17:00:00.000Z")
    });

    expect(result).toMatchObject({ claimedTasks: 1, ranTasks: 1, outboundAttempted: 1, outboundSent: 1 });
    await expect(store.getTask(context, task.id)).resolves.toMatchObject({
      status: "completed",
      scheduleRationale: "Test quiet newsletter check."
    });
    await expect(store.listOutboundMessages(context)).resolves.toEqual([
      expect.objectContaining({
        status: "sent",
        channel: "sms",
        bodyText: DAILY_CHECK_IN_FALLBACK_MESSAGE,
        origin: "daily_check_in_fallback",
        isProactive: true
      })
    ]);
    await expect(store.listTaskEvents(context, task.id)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "scheduled_task.outcome" })
    ]));
    const ledger = await store.getMarkdownDocument(context, "/assistant/decisions/2026-06.md");
    expect(ledger).toMatchObject({
      markdown: expect.stringContaining("completed scheduled task with action")
    });
    expect(ledger?.markdown).toContain(`taskId: ${task.id}`);
    expect(ledger?.markdown).toContain("Stayed quiet: recent newsletter material was routine");
    expect(ledger?.markdown).toContain("Owner-visible side effect status: tool_or_local_side_effect_recorded");
    expect((await store.listTasks(context)).filter((entry) =>
      entry.title === DAILY_CHECK_IN_TITLE &&
      entry.status === "pending" &&
      entry.id !== task.id
    )).toHaveLength(1);
  });

  it("deduplicates overdue daily replays by owner-local execution date without creating another thread", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      AGENT_OUTBOUND_ENABLED: "true"
    });
    const session = await store.createDevelopmentSession(settings, "worker-daily-dedupe-login");
    const context = {
      userId: session.user.id,
      actorType: "system" as const,
      permissions: ["user", "system"],
      requestId: "worker-daily-dedupe-test",
      session
    };
    await store.upsertConnector(context, {
      kind: "owner-contact",
      status: "enabled",
      config: { sms_gateway: "owner-sms@example.test" }
    });
    await store.upsertConnector(context, {
      kind: "smtp",
      status: "enabled",
      config: {
        username: "sender@example.test",
        smtp: { host: "smtp.example.test", from: "sender@example.test", password: "secret" }
      }
    });
    const firstTask = await store.createTask(context, {
      title: "Newsletter interest check",
      prompt: "Overdue check-in one.",
      dueAt: "2026-08-16T17:00:00.000Z"
    });
    const sendMail = vi.fn().mockResolvedValue({ accepted: ["owner-sms@example.test"] });
    const observationModel = () => new MockModelClient({
      tools: [{
        toolName: "record_observation",
        arguments: { summary: "No newsletter icebreaker today.", source: "daily_check_in" }
      }]
    });

    await daemonOnce({
      store,
      context,
      settings,
      modelClient: observationModel(),
      mailTransport: { sendMail },
      now: new Date("2026-08-18T01:00:00.000Z")
    });
    const [firstOutbound] = await store.listOutboundMessages(context);
    expect(firstOutbound).toMatchObject({
      dedupeKey: "daily-check-in:2026-08-18",
      status: "sent"
    });

    const replayTask = await store.createTask(context, {
      title: "Daily newsletter synthesis",
      prompt: "Overdue check-in replay.",
      dueAt: "2026-08-17T17:00:00.000Z"
    });
    await daemonOnce({
      store,
      context,
      settings,
      modelClient: observationModel(),
      mailTransport: { sendMail },
      now: new Date("2026-08-18T01:05:00.000Z")
    });

    const outbox = await store.listOutboundMessages(context);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.id).toBe(firstOutbound?.id);
    expect(sendMail).toHaveBeenCalledTimes(1);
    await expect(store.listConversationThreads(context)).resolves.toHaveLength(1);
    await expect(store.listTaskEvents(context, replayTask.id)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: "daily_check_in.queued",
        details: expect.objectContaining({
          outbound_message_id: firstOutbound?.id,
          conversation_thread_id: firstOutbound?.conversationThreadId
        })
      })
    ]));
    await expect(store.getTask(context, firstTask.id)).resolves.toMatchObject({ status: "completed" });
  });

  it("retries a transient daily SMTP failure with bounded persistent backoff", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      AGENT_OUTBOUND_ENABLED: "true"
    });
    const session = await store.createDevelopmentSession(settings, "worker-daily-retry-login");
    const context = {
      userId: session.user.id,
      actorType: "system" as const,
      permissions: ["user", "system"],
      requestId: "worker-daily-retry-test",
      session
    };
    await store.upsertConnector(context, {
      kind: "owner-contact",
      status: "enabled",
      config: { sms_gateway: "owner-sms@example.test" }
    });
    await store.upsertConnector(context, {
      kind: "smtp",
      status: "enabled",
      config: {
        username: "sender@example.test",
        smtp: { host: "smtp.example.test", from: "sender@example.test", password: "secret" }
      }
    });
    await store.createTask(context, {
      title: DAILY_CHECK_IN_TITLE,
      prompt: "Daily retry check-in.",
      dueAt: "2026-08-18T17:00:00.000Z"
    });
    const sendMail = vi.fn()
      .mockRejectedValueOnce(new Error("temporary SMTP outage"))
      .mockResolvedValueOnce({ accepted: ["owner-sms@example.test"] });

    const first = await daemonOnce({
      store,
      context,
      settings,
      modelClient: new MockModelClient({
        tools: [{
          toolName: "record_observation",
          arguments: { summary: "Use fallback.", source: "daily_check_in" }
        }]
      }),
      mailTransport: { sendMail },
      now: new Date("2026-08-18T17:00:00.000Z")
    });
    expect(first).toMatchObject({ outboundAttempted: 1, outboundFailed: 1 });
    await expect(store.listOutboundMessages(context)).resolves.toEqual([
      expect.objectContaining({
        status: "pending",
        deliveryAttempts: 1,
        nextDeliveryAttemptAt: "2026-08-18T17:01:00.000Z"
      })
    ]);

    const early = await daemonOnce({
      store,
      context,
      settings,
      mailTransport: { sendMail },
      now: new Date("2026-08-18T17:00:30.000Z")
    });
    expect(early.outboundAttempted).toBe(0);

    const retried = await daemonOnce({
      store,
      context,
      settings,
      mailTransport: { sendMail },
      now: new Date("2026-08-18T17:01:00.000Z")
    });
    expect(retried).toMatchObject({ outboundAttempted: 1, outboundSent: 1 });
    await expect(store.listOutboundMessages(context)).resolves.toEqual([
      expect.objectContaining({ status: "sent", deliveryAttempts: 2, nextDeliveryAttemptAt: null })
    ]);
    expect(sendMail).toHaveBeenCalledTimes(2);
  });

  it("queues exactly one host-owned daily row when the rolling proactive budget is saturated", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      AGENT_OUTBOUND_ENABLED: "true",
      AGENT_MAX_OWNER_VISIBLE_OUTBOUND_MESSAGES_PER_USER_PER_DAY: "1"
    });
    const session = await store.createDevelopmentSession(settings, "worker-daily-budget-bypass-login");
    const context = {
      userId: session.user.id,
      actorType: "system" as const,
      permissions: ["user", "system"],
      requestId: "worker-daily-budget-bypass-test",
      session
    };
    await store.upsertConnector(context, {
      kind: "owner-contact",
      status: "enabled",
      config: { sms_gateway: "owner-sms@example.test" }
    });
    await store.upsertConnector(context, {
      kind: "smtp",
      status: "enabled",
      config: {
        username: "sender@example.test",
        smtp: { host: "smtp.example.test", from: "sender@example.test", password: "secret" }
      }
    });
    await store.queueOutboundMessage(context, {
      channel: "sms",
      status: "sent",
      toAddr: "owner-sms@example.test",
      bodyText: "Earlier autonomous outreach saturated the rolling budget.",
      origin: "propose_outbound_message",
      isProactive: true
    });
    await store.createTask(context, {
      title: DAILY_CHECK_IN_TITLE,
      prompt: "Daily check-in under a saturated rolling budget.",
      dueAt: "2026-08-18T17:00:00.000Z"
    });
    const observationModel = () => new MockModelClient({
      tools: [{
        toolName: "record_observation",
        arguments: { summary: "Use the fixed daily fallback.", source: "daily_check_in" }
      }]
    });
    const sendMail = vi.fn().mockResolvedValue({ accepted: ["owner-sms@example.test"] });

    await daemonOnce({
      store,
      context,
      settings,
      modelClient: observationModel(),
      mailTransport: { sendMail },
      now: new Date("2026-08-18T17:00:00.000Z")
    });
    const firstDailyRows = (await store.listOutboundMessages(context))
      .filter((message) => message.dedupeKey === "daily-check-in:2026-08-18");
    expect(firstDailyRows).toEqual([
      expect.objectContaining({
        status: "sent",
        origin: "daily_check_in_fallback",
        isProactive: true,
        bodyText: DAILY_CHECK_IN_FALLBACK_MESSAGE
      })
    ]);

    await store.createTask(context, {
      title: "Newsletter interest check",
      prompt: "Replay today's daily check-in.",
      dueAt: "2026-08-18T17:05:00.000Z"
    });
    await daemonOnce({
      store,
      context,
      settings,
      modelClient: observationModel(),
      mailTransport: { sendMail },
      now: new Date("2026-08-18T17:05:00.000Z")
    });

    const replayDailyRows = (await store.listOutboundMessages(context))
      .filter((message) => message.dedupeKey === "daily-check-in:2026-08-18");
    expect(replayDailyRows).toHaveLength(1);
    expect(replayDailyRows[0]?.id).toBe(firstDailyRows[0]?.id);
    expect(replayDailyRows[0]?.isProactive).toBe(true);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("lets a scheduled newsletter interest check send a budgeted conversational message", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      AGENT_OUTBOUND_ENABLED: "true",
      AGENT_OPENAI_API_KEY: "test-key",
      AGENT_WEB_RESEARCH_ENABLED: "true"
    });
    const session = await store.createDevelopmentSession(settings, "worker-newsletter-propose-login");
    const context = {
      userId: session.user.id,
      actorType: "system" as const,
      permissions: ["user", "system"],
      requestId: "worker-newsletter-propose-test",
      session
    };
    await store.upsertConnector(context, {
      kind: "owner-contact",
      status: "enabled",
      config: {
        mms_gateway: "owner-mms@example.test"
      }
    });
    await store.upsertConnector(context, {
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
    await store.writeMarkdownDocument(context, {
      path: "/newsletters/2026-06-13/agent-weekly.md",
      markdown: "# Agent Weekly\n\nA practical agent runtime writeup with a useful approval pattern."
    });
    const task = await store.createTask(context, {
      title: "Newsletter interest check",
      prompt: "Run newsletter interest check.",
      dueAt: "2026-06-13T17:00:00.000Z",
      scheduleRationale: "Test proposed newsletter message.",
      recurrencePolicy: "preference-aware daily interest check around 17:00 local/server time"
    });

    const sendMail = vi.fn().mockResolvedValue({ accepted: ["owner-mms@example.test"] });
    const result = await daemonOnce({
      store,
      context,
      settings,
      modelClient: new MockModelClient({
        tools: [
          {
            toolName: "web_research",
            arguments: {
              query: "Research the approval pattern discussed in Agent Weekly and find current corroborating details.",
              sourceNewsletterPaths: ["/newsletters/2026-06-13/agent-weekly.md"],
              rationale: "The pattern is directly relevant to the owner's assistant work."
            }
          }
        ]
      }),
      webResearchClient: stubWebResearch("One newsletter thing worth flagging: Agent Weekly described a useful approval pattern for keeping runtime actions gated."),
      mailTransport: { sendMail },
      now: new Date("2026-06-13T17:00:00.000Z")
    });

    expect(result).toMatchObject({ claimedTasks: 1, ranTasks: 1, outboundAttempted: 1, outboundSent: 1 });
    expect(sendMail).toHaveBeenCalledTimes(1);
    await expect(store.listOutboundMessages(context)).resolves.toEqual([
      expect.objectContaining({
        channel: "mms",
        status: "sent",
        toAddr: "owner-mms@example.test",
        approvalId: null,
        origin: "daily_check_in_newsletter_research",
        isProactive: true,
        bodyText: expect.stringContaining("One newsletter thing worth flagging")
      })
    ]);
    await expect(store.listApprovals(context, ["pending"])).resolves.toEqual([]);
    await expect(store.listToolCalls(context)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        toolName: "web_research",
        status: "accepted",
        result: expect.objectContaining({
          execution: expect.objectContaining({
            status: "ok",
            taint: "external_web"
          })
        })
      })
    ]));
    const [outbound] = await store.listOutboundMessages(context);
    const [research] = await store.listWebResearchSessions(context, {
      sourceTaskId: task.id,
      includeExpired: true
    });
    expect(research).toMatchObject({
      purpose: "newsletter_enrichment",
      outboundMessageId: outbound.id,
      conversationThreadId: outbound.conversationThreadId,
      sourceMarkdownPaths: ["/newsletters/2026-06-13/agent-weekly.md"]
    });
    await expect(store.listTaskEvents(context, task.id)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: "newsletter_research.queued",
        details: expect.objectContaining({ outbound_message_id: outbound.id, channel: "mms" })
      })
    ]));
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
    expect(prompt).toContain("Review owner feedback signals under /assistant/feedback/");
    expect(prompt).toContain("/assistant/self-review/2026-06-13.md");
    expect(prompt).toContain("/assistant/preferences/communication.md");
    expect(prompt).toContain("Recent owner feedback signals:");
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

  it("builds a memory quality review prompt with recent memory, list, outcome, and self-review context", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone"
    });
    const session = await store.createDevelopmentSession(settings, "worker-memory-review-prompt-login");
    const context = {
      userId: session.user.id,
      actorType: "system" as const,
      permissions: ["user", "system"],
      requestId: "worker-memory-review-prompt-test",
      session
    };
    await store.writeMarkdownDocument(context, {
      path: "/personal/profile.md",
      markdown: "# Profile\n\n- Prefers terse notes."
    });
    await store.writeMarkdownDocument(context, {
      path: "/personal/lists/movies.md",
      markdown: "# Movies\n\n<!-- memory-list:v1 -->\n\n- [ ] Arrival <!-- memory-list-item:one -->\n  - added: 2026-06-13\n- [ ] Arrival! <!-- memory-list-item:two -->\n  - added: 2026-06-13"
    });
    await store.writeMarkdownDocument(context, {
      path: "/assistant/self-review/2026-06-13.md",
      markdown: "# Self Review\n\n- Possible repeated approval backlog."
    });
    await store.writeMarkdownDocument(context, {
      path: "/assistant/newsletter-interest/2026-06.md",
      markdown: "# Newsletter Interest\n\n- Stayed quiet because material was routine."
    });
    await store.writeMarkdownDocument(context, {
      path: "/assistant/feedback/2026-06.md",
      markdown: "# Owner Feedback: 2026-06\n\n## 2026-06-13 communication feedback\n\n- Owner said not to text early."
    });
    await store.writeMarkdownDocument(context, {
      path: "/newsletters/2026-06-13/agent-weekly.md",
      markdown: "# Agent Weekly\n\nMentions memory cleanup patterns."
    });
    await store.writeMarkdownDocument(context, {
      path: "/assistant/memory-review/2026-06.md",
      markdown: "# Memory Review: 2026-06\n\n## 2026-06-08\n\n- Existing finding to preserve."
    });
    const completed = await store.createTask(context, {
      title: "Finished context task",
      prompt: "Do a thing."
    });
    await store.updateTask(context, completed.id, { status: "completed" });
    await recordTaskOutcomeMemory({
      store,
      context,
      taskId: completed.id,
      now: new Date("2026-06-13T12:00:00.000Z")
    });
    const task = await store.createTask(context, {
      title: "Memory quality review",
      prompt: "Run memory quality review.",
      dueAt: "2026-06-14T10:00:00.000Z"
    });

    const prompt = await buildScheduledTaskPrompt({
      store,
      context,
      task,
      settings,
      now: new Date("2026-06-14T10:00:00.000Z")
    });

    expect(prompt).toContain("Memory quality review outcome");
    expect(prompt).toContain("/assistant/memory-review/2026-06.md");
    expect(prompt).toContain("Existing finding to preserve");
    expect(prompt).toContain("never silently delete memory");
    expect(prompt).toContain("Recent owner feedback signals:");
    expect(prompt).toContain("Owner said not to text early.");
    expect(prompt).toContain("Recent markdown writes for memory quality review:");
    expect(prompt).toContain("/personal/profile.md");
    expect(prompt).toContain("/assistant/feedback/2026-06.md");
    expect(prompt).toContain("/assistant/self-review/2026-06-13.md");
    expect(prompt).toContain("/assistant/newsletter-interest/2026-06.md");
    expect(prompt).toContain("/tasks/outcomes/2026-06.md");
    expect(prompt).toContain("/newsletters/2026-06-13/agent-weekly.md");
    expect(prompt).toContain("Personal list summaries for memory quality review:");
    expect(prompt).toContain("active_items=2");
    expect(prompt).toContain("Arrival!");
    expect(prompt).toContain("Existing monthly memory-review note:");
    expect(prompt).toContain("Existing finding to preserve");
  });

  it("lets memory-review write a monthly markdown note through MCP without outbound messages", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone"
    });
    const session = await store.createDevelopmentSession(settings, "worker-memory-review-write-login");
    const context = {
      userId: session.user.id,
      actorType: "system" as const,
      permissions: ["user", "system"],
      requestId: "worker-memory-review-write-test",
      session
    };
    const task = await store.createTask(context, {
      title: "Memory quality review",
      prompt: "Run memory quality review.",
      dueAt: "2026-06-14T10:00:00.000Z",
      priority: 7,
      scheduleRationale: "Test memory quality review.",
      recurrencePolicy: "weekly around Sunday 10:00 local/server time"
    });

    const result = await daemonOnce({
      store,
      context,
      settings,
      modelClient: new MockModelClient({
        tools: [
          {
            toolName: "write_file",
            arguments: {
              path: "/assistant/memory-review/2026-06.md",
              content: "# Memory Review: 2026-06\n\n## 2026-06-14\n\n- Evidence: `/personal/lists/movies.md` has near-duplicate Arrival entries.\n- Uncertainty: likely duplicate; owner confirmation needed before cleanup.",
              rationale: "Record compact memory quality findings."
            }
          }
        ]
      }),
      now: new Date("2026-06-14T10:00:00.000Z")
    });

    expect(result).toMatchObject({ claimedTasks: 1, ranTasks: 1, outboundAttempted: 0 });
    await expect(store.getMarkdownDocument(context, "/assistant/memory-review/2026-06.md")).resolves.toMatchObject({
      markdown: expect.stringContaining("near-duplicate Arrival entries")
    });
    await expect(store.getTask(context, task.id)).resolves.toMatchObject({ status: "completed" });
    await expect(store.listToolCalls(context)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        toolName: "write_file",
        status: "accepted",
        result: expect.objectContaining({
          execution: expect.objectContaining({
            path: "/assistant/memory-review/2026-06.md"
          })
        })
      })
    ]));
    await expect(store.listOutboundMessages(context)).resolves.toEqual([]);
    expect((await store.listTasks(context)).filter((entry) =>
      entry.title === "Memory quality review" &&
      entry.status === "pending" &&
      entry.id !== task.id
    )).toHaveLength(1);
  });

  it("records completed scheduled task outcomes once in monthly markdown memory", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone"
    });
    const session = await store.createDevelopmentSession(settings, "worker-outcome-complete-login");
    const context = {
      userId: session.user.id,
      actorType: "system" as const,
      permissions: ["user", "system"],
      requestId: "worker-outcome-complete-test",
      session
    };
    const task = await store.createTask(context, {
      title: "Summarize project notes",
      prompt: "Summarize the current project notes.",
      dueAt: "2026-06-13T12:00:00.000Z",
      sourceMemoryPath: "/projects/alpha/notes.md",
      scheduleRationale: "Owner asked for a compact summary."
    });

    await daemonOnce({
      store,
      context,
      settings,
      modelClient: new MockModelClient({
        tools: [
          {
            toolName: "record_observation",
            arguments: {
              summary: "Project notes were already current.",
              source: "unit-test"
            }
          }
        ]
      }),
      now: new Date("2026-06-13T12:00:00.000Z")
    });
    await recordTaskOutcomeMemory({
      store,
      context,
      taskId: task.id,
      now: new Date("2026-06-13T12:01:00.000Z")
    });

    const document = await store.getMarkdownDocument(context, "/tasks/outcomes/2026-06.md");
    expect(document).toMatchObject({
      userId: session.user.id,
      markdown: expect.stringContaining(`<!-- task-outcome:${task.id}:completed -->`)
    });
    expect(document?.markdown).toContain("Summarize project notes");
    expect(document?.markdown).toContain("- Final status: completed");
    expect(document?.markdown).toContain("memory /projects/alpha/notes.md");
    expect((document?.markdown.match(new RegExp(`task-outcome:${task.id}:completed`, "g")) ?? [])).toHaveLength(1);
    await expect(store.getMarkdownIndexStatus(context, "/tasks/outcomes")).resolves.toEqual([
      expect.objectContaining({
        path: "/tasks/outcomes/2026-06.md",
        pendingJobs: 1
      })
    ]);
    await expect(store.listAudit(context, false)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "markdown.write",
        entityType: "markdown_document",
        details: expect.objectContaining({
          path: "/tasks/outcomes/2026-06.md"
        })
      })
    ]));
  });

  it("records scheduled task failure reasons in outcome memory", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone"
    });
    const session = await store.createDevelopmentSession(settings, "worker-outcome-failure-login");
    const context = {
      userId: session.user.id,
      actorType: "system" as const,
      permissions: ["user", "system"],
      requestId: "worker-outcome-failure-test",
      session
    };
    const task = await store.createTask(context, {
      title: "Run fragile model task",
      prompt: "This will fail.",
      dueAt: "2026-06-13T12:00:00.000Z"
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

    await expect(store.getMarkdownDocument(context, "/tasks/outcomes/2026-06.md")).resolves.toMatchObject({
      markdown: expect.stringContaining(`<!-- task-outcome:${task.id}:failed -->`)
    });
    const document = await store.getMarkdownDocument(context, "/tasks/outcomes/2026-06.md");
    expect(document?.markdown).toContain("- Failure reason: model unavailable");
    const ledger = await store.getMarkdownDocument(context, "/assistant/decisions/2026-06.md");
    expect(ledger?.markdown).toContain("recorded scheduled task failure");
    expect(ledger?.markdown).toContain("model unavailable");
  });

  it("preserves split and follow-up source task links in outcome memory", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone"
    });
    const session = await store.createDevelopmentSession(settings, "worker-outcome-links-login");
    const context = {
      userId: session.user.id,
      actorType: "system" as const,
      permissions: ["user", "system"],
      requestId: "worker-outcome-links-test",
      session
    };
    const source = await store.createTask(context, {
      title: "Plan travel",
      prompt: "Split the travel planning work."
    });
    const child = await store.createTask(context, {
      title: "Book hotel",
      prompt: "Find hotels.",
      sourceTaskId: source.id
    });
    await store.recordTaskEvent(context, source.id, "task.split", {
      child_task_ids: [child.id],
      rationale: "Separate booking from research.",
      summary: "Agent split this task into follow-up tasks."
    });
    await store.recordTaskEvent(context, source.id, "task.followup_created", {
      followup_task_id: child.id,
      rationale: "Book the hotel after destination is known.",
      summary: "Agent created a follow-up task."
    });
    await store.updateTask(context, source.id, { status: "completed" });

    await recordTaskOutcomeMemory({
      store,
      context,
      taskId: source.id,
      now: new Date("2026-06-13T12:00:00.000Z")
    });

    const document = await store.getMarkdownDocument(context, "/tasks/outcomes/2026-06.md");
    expect(document?.markdown).toContain(`child task ${child.id}`);
    expect(document?.markdown).toContain(`followup task id ${child.id}`);
    expect(document?.markdown).toContain("Use the linked follow-up/source tasks");
  });

  it("keeps task outcome markdown user scoped and includes it in scheduled prompts", async () => {
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
    const ownerSession = await store.createDevelopmentSession(ownerSettings, "owner-outcome-login");
    const otherSession = await store.createDevelopmentSession(otherSettings, "other-outcome-login");
    const owner = {
      userId: ownerSession.user.id,
      actorType: "system" as const,
      permissions: ["user", "system"],
      requestId: "owner-outcome-test",
      session: ownerSession
    };
    const other = {
      userId: otherSession.user.id,
      actorType: "system" as const,
      permissions: ["user", "system"],
      requestId: "other-outcome-test",
      session: otherSession
    };
    const completed = await store.createTask(owner, {
      title: "Finish owner-only task",
      prompt: "Owner scoped work."
    });
    await store.updateTask(owner, completed.id, { status: "completed" });
    await recordTaskOutcomeMemory({
      store,
      context: owner,
      taskId: completed.id,
      now: new Date("2026-06-13T12:00:00.000Z")
    });
    const wake = await store.createTask(owner, {
      title: "Autonomous agent wake review",
      prompt: "Wake and reassess work.",
      dueAt: "2026-06-13T15:00:00.000Z"
    });

    await expect(store.getMarkdownDocument(other, "/tasks/outcomes/2026-06.md")).resolves.toBeUndefined();
    const prompt = await buildScheduledTaskPrompt({
      store,
      context: owner,
      task: wake,
      now: new Date("2026-06-13T15:00:00.000Z")
    });
    expect(prompt).toContain("Recent task outcome memory:");
    expect(prompt).toContain("Finish owner-only task");
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

  it("schedules the next memory-review even when the review run fails", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone"
    });
    const session = await store.createDevelopmentSession(settings, "worker-memory-review-failure-login");
    const context = {
      userId: session.user.id,
      actorType: "system" as const,
      permissions: ["user", "system"],
      requestId: "worker-memory-review-failure-test",
      session
    };
    const review = await store.createTask(context, {
      title: "Memory quality review",
      prompt: "Run memory quality review.",
      dueAt: "2026-06-14T10:00:00.000Z",
      priority: 7,
      scheduleRationale: "Test memory quality review.",
      recurrencePolicy: "weekly around Sunday 10:00 local/server time"
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
      now: new Date("2026-06-14T10:00:00.000Z")
    });

    await expect(store.getTask(context, review.id)).resolves.toMatchObject({ status: "failed" });
    expect((await store.listTasks(context)).filter((entry) =>
      entry.title === "Memory quality review" &&
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
        throw Object.assign(new Error("Command failed password=topsecret https://private.example/path"), {
          response: "NO IMAP disabled token=raw-secret-token"
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
        message: "Command failed password=[redacted] [url]",
        response: "NO IMAP disabled token=[redacted]"
      })
    });
    expect(JSON.stringify(audit[0])).not.toContain("topsecret");
    expect(JSON.stringify(audit[0])).not.toContain("private.example");
    expect(JSON.stringify(audit[0])).not.toContain("raw-secret-token");
  });
});
