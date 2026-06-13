import { describe, expect, it, vi } from "vitest";
import type { ToolModelRequest } from "../src/agent/modelClient.js";
import { MockModelClient } from "../src/agent/modelClient.js";
import { loadSettings } from "../src/config/settings.js";
import { createMemoryStore } from "../src/domain/store.js";
import { buildScheduledTaskPrompt } from "../src/scheduler/autonomousTasks.js";
import { daemonOnce } from "../src/scheduler/taskQueue.js";
import { recordTaskOutcomeMemory } from "../src/memory/taskOutcomeMemory.js";
import { isWorkerEntrypoint, workerTick } from "../src/worker.js";

describe("worker loop", () => {
  it("detects the worker entrypoint when node receives a relative script path", () => {
    expect(isWorkerEntrypoint(new URL("../src/worker.ts", import.meta.url).href, "src/worker.ts")).toBe(true);
  });

  it("keeps newsletter interest, autonomous wake, self-review, and memory-review tasks scheduled with durable rationale", async () => {
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
        title: "Newsletter interest check",
        prompt: expect.stringContaining("not a daily digest"),
        scheduleRationale: "Default preference-aware newsletter interest check.",
        recurrencePolicy: "preference-aware daily interest check around 17:00 local/server time"
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
      ["Daily newsletter synthesis", "Newsletter interest check"].includes(entry.title) &&
      !["completed", "cancelled", "failed"].includes(entry.status)
    )).toHaveLength(1);

    await daemonOnce({
      store,
      context,
      settings,
      modelClient: new MockModelClient({
        tools: [
          {
            toolName: "record_schedule_rationale",
            arguments: {
              taskId: legacyTask.id,
              rationale: "Stayed quiet and switch future checks to conversational interest timing."
            }
          }
        ]
      }),
      now: new Date("2026-06-13T17:00:00.000Z")
    });

    await expect(store.getTask(context, legacyTask.id)).resolves.toMatchObject({ status: "completed" });
    expect((await store.listTasks(context)).filter((entry) =>
      entry.title === "Newsletter interest check" &&
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
    const task = (await store.listTasks(context)).find((entry) => entry.title === "Newsletter interest check");
    expect(task).toBeTruthy();

    const prompt = await buildScheduledTaskPrompt({
      store,
      context,
      task: task!,
      now: new Date()
    });

    expect(prompt).toContain("This is not a daily digest");
    expect(prompt).toContain("Use get_recent_bot_activity");
    expect(prompt).toContain("/assistant/preferences/newsletters.md");
    expect(prompt).toContain("Communication preferences:");
    expect(prompt).toContain("Newsletter preferences:");
    expect(prompt).toContain("Recent bot activity evidence for newsletter timing:");
    expect(prompt).toContain("pending_approvals=");
    expect(prompt).toContain("owner_visible_contact_attempts=");
    expect(prompt).toContain("Prefer staying quiet when recent contact cadence is high");
    expect(prompt).toContain("A surprising database outage writeup");
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

  it("lets a scheduled newsletter interest check stay quiet and record rationale", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone"
    });
    const session = await store.createDevelopmentSession(settings, "worker-newsletter-quiet-login");
    const context = {
      userId: session.user.id,
      actorType: "system" as const,
      permissions: ["user", "system"],
      requestId: "worker-newsletter-quiet-test",
      session
    };
    const task = await store.createTask(context, {
      title: "Newsletter interest check",
      prompt: "Run newsletter interest check.",
      dueAt: "2026-06-13T17:00:00.000Z",
      scheduleRationale: "Test quiet newsletter check.",
      recurrencePolicy: "preference-aware daily interest check around 17:00 local/server time"
    });

    const result = await daemonOnce({
      store,
      context,
      settings,
      modelClient: new MockModelClient({
        tools: [
          {
            toolName: "record_schedule_rationale",
            arguments: {
              taskId: task.id,
              rationale: "Stayed quiet: recent newsletter material was routine and an approval was already pending.",
              sourceMemoryPath: "/assistant/newsletter-interest/2026-06.md",
              recurrencePolicy: "check again tomorrow unless owner preference changes",
              nextReviewAt: "2026-06-14T17:00:00.000Z"
            }
          }
        ]
      }),
      now: new Date("2026-06-13T17:00:00.000Z")
    });

    expect(result).toMatchObject({ claimedTasks: 1, ranTasks: 1, outboundAttempted: 0 });
    await expect(store.getTask(context, task.id)).resolves.toMatchObject({
      status: "completed",
      scheduleRationale: "Stayed quiet: recent newsletter material was routine and an approval was already pending."
    });
    await expect(store.listOutboundMessages(context)).resolves.toEqual([]);
    await expect(store.listTaskEvents(context, task.id)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "task.schedule_rationale_recorded" }),
      expect.objectContaining({ eventType: "scheduled_task.outcome" })
    ]));
    expect((await store.listTasks(context)).filter((entry) =>
      entry.title === "Newsletter interest check" &&
      entry.status === "pending" &&
      entry.id !== task.id
    )).toHaveLength(1);
  });

  it("lets a scheduled newsletter interest check propose an approval-gated conversational message", async () => {
    const store = createMemoryStore();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone"
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
        sms_gateway: "owner-sms@example.test"
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

    const result = await daemonOnce({
      store,
      context,
      settings,
      modelClient: new MockModelClient({
        tools: [
          {
            toolName: "propose_outbound_message",
            arguments: {
              intent: "reply",
              body: "One newsletter thing worth flagging: Agent Weekly had a useful approval pattern for keeping runtime actions gated. Might be relevant to the assistant work."
            }
          }
        ]
      }),
      now: new Date("2026-06-13T17:00:00.000Z")
    });

    expect(result).toMatchObject({ claimedTasks: 1, ranTasks: 1, outboundAttempted: 0 });
    await expect(store.listOutboundMessages(context)).resolves.toEqual([
      expect.objectContaining({
        channel: "sms",
        status: "requires_approval",
        toAddr: "owner-sms@example.test",
        bodyText: expect.stringContaining("One newsletter thing worth flagging")
      })
    ]);
    await expect(store.listApprovals(context, ["pending"])).resolves.toEqual([
      expect.objectContaining({
        actionType: "send_outbound_message",
        riskLevel: "high",
        summary: expect.stringContaining("One newsletter thing worth flagging")
      })
    ]);
    await expect(store.listToolCalls(context)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        toolName: "propose_outbound_message",
        status: "accepted",
        result: expect.objectContaining({
          execution: expect.objectContaining({
            status: "queued_approval"
          })
        })
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
    expect(prompt).toContain("Recent markdown writes for memory quality review:");
    expect(prompt).toContain("/personal/profile.md");
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
