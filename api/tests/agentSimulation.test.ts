import { describe, expect, it } from "vitest";
import { buildScheduledTaskPrompt } from "../src/scheduler/autonomousTasks.js";
import { createAgentSimulation } from "./helpers/agentSimulation.js";

describe("agent simulation harness", () => {
  it("keeps newsletter ingestion knowledge-only until a scheduled interest check proposes one owner message", async () => {
    const sim = await createAgentSimulation({ loginLabel: "scenario-newsletter" });
    await sim.configureOwnerContact();
    await sim.trustNewsletterSender("infra@example.test");

    const inbound = await sim.receiveNewsletter({
      fromAddr: "infra@example.test",
      subject: "Infra Weekly",
      bodyText: "A surprising database outage writeup with practical lessons.",
      receivedAt: "2026-06-13T08:00:00.000Z"
    });

    expect(inbound).toMatchObject({ classification: "newsletter", action: "accepted_newsletter" });
    expect((await sim.snapshot()).inbound[0]).toMatchObject({ source: "email" });
    await sim.expectMarkdown("/newsletters/2026-06-13/infra-weekly.md", /knowledge input only/);
    let snapshot = await sim.snapshot();
    expect(snapshot.runs).toHaveLength(0);
    expect(snapshot.outbound).toHaveLength(0);

    await sim.runWorkerTick();
    sim.advanceTime(5 * 60 * 60 * 1000);
    await sim.makeTaskDue("Newsletter interest check");
    sim.model.stageToolCall("propose_outbound_message", {
      intent: "reply",
      body: "Infra Weekly had a useful outage writeup worth reading later."
    });

    const tick = await sim.runWorkerTick();

    expect(tick).toMatchObject({ claimedTasks: 1, ranTasks: 1 });
    snapshot = await sim.snapshot();
    expect(snapshot.outbound).toEqual([
      expect.objectContaining({
        status: "requires_approval",
        bodyText: expect.stringContaining("outage writeup")
      })
    ]);
    expect(snapshot.approvals).toEqual([
      expect.objectContaining({
        status: "pending",
        actionType: "send_outbound_message"
      })
    ]);
  });

  it("remembers Desperado as a movie-night list item and later recalls it by Banderas", async () => {
    const sim = await createAgentSimulation({ loginLabel: "scenario-memory-list" });

    sim.model.stageToolCall("add_memory_list_item", {
      listName: "movie night",
      item: "Desperado",
      notes: "Antonio Banderas movie the owner flagged for movie night.",
      rationale: "Owner said this is one for movie night."
    });
    const saved = await sim.sendOwnerMessage("Desperado is one for movie night");

    expect(saved).toMatchObject({ classification: "owner", action: "routed_to_agent" });
    await sim.expectMarkdown("/personal/lists/movies.md", /Desperado/);

    sim.model.stageToolCall("search_memory_lists", {
      query: "Banderas movie",
      limit: 5
    });
    const recalled = await sim.sendOwnerMessage("what was the remembered Banderas movie?");

    expect(recalled).toMatchObject({ classification: "owner", action: "routed_to_agent" });
    const { toolCalls } = await sim.snapshot();
    expect(toolCalls.find((toolCall) => toolCall.toolName === "search_memory_lists")).toMatchObject({
      toolName: "search_memory_lists",
      status: "accepted",
      result: expect.objectContaining({
        execution: expect.objectContaining({
          candidates: expect.arrayContaining([
            expect.objectContaining({
              matched_items: expect.arrayContaining([
                expect.objectContaining({
                  item: "Desperado"
                })
              ])
            })
          ])
        })
      })
    });
  });

  it("surfaces a repeated tool-loop guardrail failure to self-review and memory-review context", async () => {
    const sim = await createAgentSimulation({ loginLabel: "scenario-loop-guardrail" });
    const aiConfig = await sim.store.getAiConfig();
    await sim.store.updateAiConfig(sim.ownerContext, {
      ...aiConfig,
      maxToolCalls: 0
    });
    await sim.createDueTask({
      title: "Looping scheduled task",
      prompt: "The model keeps trying the same tool.",
      scheduleRationale: "Scenario guardrail exercise."
    });
    sim.model.stageToolCall("record_observation", {
      summary: "This tool call should be blocked by the per-run guardrail.",
      source: "scenario-loop"
    });

    const failedTick = await sim.runWorkerTick();

    expect(failedTick).toMatchObject({ claimedTasks: 1, ranTasks: 1 });
    await sim.expectAudit("guardrail.exceeded");
    await sim.expectMarkdown("/tasks/outcomes/2026-06.md", /MCP\/tool call guardrail exceeded for this run/);

    await sim.store.updateAiConfig(sim.ownerContext, {
      ...aiConfig,
      maxToolCalls: 1
    });
    await sim.runWorkerTick();
    await sim.makeTaskDue("Assistant self-review");
    sim.model.stageToolCall("get_recent_bot_activity", {
      reason: "Inspect failed runs and tool loops.",
      lookbackHours: 24,
      limit: 10
    });

    const reviewTick = await sim.runWorkerTick();

    expect(reviewTick).toMatchObject({ claimedTasks: 1, ranTasks: 1 });
    const { toolCalls, tasks } = await sim.snapshot();
    const botActivityCall = toolCalls.find((toolCall) => toolCall.toolName === "get_recent_bot_activity");
    expect(botActivityCall).toMatchObject({
      toolName: "get_recent_bot_activity",
      status: "accepted",
      result: expect.objectContaining({
        execution: expect.objectContaining({
          counts: expect.objectContaining({
            failed_agent_runs: expect.any(Number),
            failed_or_rejected_tool_calls: expect.any(Number)
          })
        })
      })
    });
    const activityCounts = (botActivityCall?.result?.execution as { counts?: Record<string, number> } | undefined)?.counts;
    expect(activityCounts?.failed_agent_runs).toBeGreaterThanOrEqual(1);
    expect(activityCounts?.failed_or_rejected_tool_calls).toBeGreaterThanOrEqual(1);

    const memoryReviewTask = tasks.find((task) =>
      task.title === "Memory quality review" && !["completed", "cancelled", "failed"].includes(task.status)
    );
    expect(memoryReviewTask).toBeTruthy();
    const memoryReviewPrompt = await buildScheduledTaskPrompt({
      store: sim.store,
      context: sim.systemContext,
      task: memoryReviewTask!,
      settings: sim.settings,
      now: sim.now()
    });
    expect(memoryReviewPrompt).toContain("MCP/tool call guardrail exceeded for this run");
  });

  it("records owner correction as feedback and includes it in future review prompt context", async () => {
    const sim = await createAgentSimulation({ loginLabel: "scenario-owner-feedback" });

    sim.model.stageToolCall("record_owner_feedback", {
      feedbackType: "tool",
      correctionText: "That was not a task; just remember things like that.",
      originalBehaviorSummary: "Assistant treated a lightweight memory offload as task-shaped work.",
      affectedMemoryPaths: [],
      affectedTaskIds: [],
      affectedToolCallIds: [],
      affectedMessageIds: [],
      affectedAppIds: [],
      durability: "durable",
      followUpTarget: "list_memory",
      rationale: "Owner corrected storage behavior for future similar messages."
    });

    const result = await sim.sendOwnerMessage("That was not a task; just remember things like that.");

    expect(result).toMatchObject({ classification: "owner", action: "routed_to_agent" });
    await sim.expectMarkdown("/assistant/feedback/2026-06.md", /not a task; just remember/);
    await sim.runWorkerTick();
    const prompt = await sim.buildScheduledPrompt("Assistant self-review");
    expect(prompt).toContain("Recent owner feedback signals:");
    expect(prompt).toContain("not a task; just remember");
  });

  it("keeps conversation thread continuity across an owner follow-up", async () => {
    const sim = await createAgentSimulation({ loginLabel: "scenario-thread-continuity" });

    sim.model.stageToolCall("create_task", {
      title: "Plan bathroom project",
      prompt: "Plan the bathroom project with the owner."
    });
    const first = await sim.sendOwnerMessage("Can you plan the bathroom project?");
    const firstSnapshot = await sim.snapshot();
    const task = firstSnapshot.tasks.find((entry) => entry.title === "Plan bathroom project");

    expect(first.conversationThreadId).toBeTruthy();
    expect(task).toBeTruthy();

    sim.model.stageToolCall("append_task_prompt", {
      taskId: task!.id,
      prompt: "Owner asked for an update on the bathroom project.",
      status: "pending"
    });
    const followup = await sim.sendOwnerMessage("Any update on that from earlier?");
    const snapshot = await sim.snapshot();
    const thread = snapshot.threads.find((entry) => entry.id === first.conversationThreadId);

    expect(followup.conversationThreadId).toBe(first.conversationThreadId);
    expect(thread).toMatchObject({
      linkedTaskIds: expect.arrayContaining([task!.id]),
      linkedMessageIds: expect.arrayContaining([first.messageId, followup.messageId])
    });
    expect(snapshot.inbound.map((message) => message.conversationThreadId)).toEqual([
      first.conversationThreadId,
      first.conversationThreadId
    ]);
    await expect(sim.store.listTaskEvents(sim.ownerContext, task!.id)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: "task.prompt_added",
        details: expect.objectContaining({
          prompt: "Owner asked for an update on the bathroom project."
        })
      })
    ]));
  });
});
