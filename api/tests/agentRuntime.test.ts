import { describe, expect, it, vi } from "vitest";
import { MockModelClient, OpenAIModelClient } from "../src/agent/modelClient.js";
import { buildOwnerInboundPrompt, runOwnerInboundAgent } from "../src/agent/inboundMessageAgent.js";
import { chooseModelTier, modelTierConfigFromSettings, resolveModelId } from "../src/agent/modelTiers.js";
import { buildAgentPrompt, modelToolDescriptors } from "../src/agent/promptContext.js";
import { runAgentTask } from "../src/agent/runAgentTask.js";
import { LocalToolClient } from "../src/agent/toolClient.js";
import { loadSettings } from "../src/config/settings.js";
import { createMemoryStore } from "../src/domain/store.js";
import type { RequestContext } from "../src/domain/types.js";
import { buildCapabilityContext, getIntegrationAction, listAppCapabilities } from "../src/integrations/capabilityRegistry.js";
import { PERSONAL_PROFILE_SLUG } from "../src/memory/personalMemory.js";
import { buildMcpApp } from "../src/mcp/server.js";
import { validateOrRepairToolCall } from "../src/tools/validator.js";

async function testContext(isAdmin = true): Promise<{ context: RequestContext; store: ReturnType<typeof createMemoryStore> }> {
  const settings = loadSettings({
    APP_ENV: "test",
    AUTH_MODE: "standalone",
    DEV_USER_IS_ADMIN: String(isAdmin)
  });
  const store = createMemoryStore();
  const session = await store.createDevelopmentSession(settings, "agent-test-login");
  return {
    store,
    context: {
      userId: session.user.id,
      actorType: session.user.isAdmin ? "admin" : "user",
      permissions: session.user.isAdmin ? ["user", "admin"] : ["user"],
      requestId: "agent-test",
      session
    }
  };
}

describe("model tiers", () => {
  it("selects tiers from task complexity", () => {
    expect(chooseModelTier({})).toBe("fast");
    expect(chooseModelTier({ ambiguous: true })).toBe("smart");
    expect(chooseModelTier({ orchestration: true })).toBe("orchestrator");
    expect(chooseModelTier({ repair: true })).toBe("repair");
  });

  it("resolves model ids from settings", () => {
    const settings = loadSettings({
      AGENT_OPENAI_MODEL_FAST: "fast-model",
      AGENT_OPENAI_MODEL_SMART: "smart-model",
      AGENT_OPENAI_MODEL_ORCHESTRATOR: "orchestrator-model",
      AGENT_OPENAI_MODEL_REPAIR: "repair-model"
    });

    const config = modelTierConfigFromSettings(settings);

    expect(resolveModelId(config, "fast")).toBe("fast-model");
    expect(resolveModelId(config, "smart")).toBe("smart-model");
    expect(resolveModelId(config, "orchestrator")).toBe("orchestrator-model");
    expect(resolveModelId(config, "repair")).toBe("repair-model");
  });
});

describe("tool validation and repair", () => {
  it("accepts valid tool arguments without repair", async () => {
    const result = await validateOrRepairToolCall(
      {
        toolName: "create_task",
        arguments: {
          title: "Check mail",
          prompt: "Summarize messages."
        }
      },
      {
        modelClient: new MockModelClient(),
        repairModel: "repair-model",
        repairAttemptLimit: 1
      }
    );

    expect(result).toMatchObject({
      ok: true,
      repaired: false
    });
  });

  it("repairs malformed tool arguments through the repair tier", async () => {
    const result = await validateOrRepairToolCall(
      {
        toolName: "create_task",
        arguments: {
          prompt: "Missing title."
        }
      },
      {
        modelClient: new MockModelClient({
          repairs: [
            {
              title: "Repaired task",
              prompt: "Missing title."
            }
          ]
        }),
        repairModel: "repair-model",
        repairAttemptLimit: 1
      }
    );

    expect(result).toMatchObject({
      ok: true,
      repaired: true,
      arguments: {
        title: "Repaired task"
      }
    });
  });

  it("fails closed when repair cannot satisfy the contract", async () => {
    const result = await validateOrRepairToolCall(
      {
        toolName: "create_task",
        arguments: {
          prompt: "Still missing title."
        }
      },
      {
        modelClient: new MockModelClient({
          repairs: [
            {
              prompt: "Still missing title."
            }
          ]
        }),
        repairModel: "repair-model",
        repairAttemptLimit: 1
      }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.repaired).toBe(true);
      expect(result.validationErrors.join(" ")).toContain("title");
    }
  });
});

describe("app capability registry", () => {
  it("documents goals and budget purpose, access, and registered actions for model context", () => {
    const apps = listAppCapabilities();
    const context = buildCapabilityContext();

    expect(apps.map((app) => app.id)).toEqual(["goals", "budget"]);
    expect(context).toContain("Personal goal tracking");
    expect(context).toContain("Personal finance planning");
    expect(context).toContain("goals.record_metric_entry");
    expect(context).toContain("budget.get_net_worth_forecast");
    expect(getIntegrationAction("budget.update_account_value")).toMatchObject({
      app: "budget",
      access: "write",
      risk: "high",
      method: "PUT",
      pathTemplate: "/accounts/:account_id/value"
    });
  });

  it("adds integration capability context and tool schemas to model requests", async () => {
    const prompt = buildAgentPrompt("How are my goals and budget doing?");
    const tools = modelToolDescriptors();

    expect(prompt).toContain("GHWIZ app capability registry");
    expect(prompt).toContain("goals.list_goals");
    expect(prompt).toContain("budget.list_accounts");
    expect(tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "integration_action" }),
        expect.objectContaining({ name: "create_task" })
      ])
    );
  });
});

describe("agent task execution", () => {
  it("executes accepted task tool calls through the default MCP client", async () => {
    const { context, store } = await testContext();

    const result = await runAgentTask({
      context,
      store,
      modelClient: new MockModelClient({
        tools: [
          {
            toolName: "create_task",
            arguments: {
              title: "Proposed task",
              prompt: "Do useful work."
            }
          }
        ]
      }),
      request: {
        prompt: "Create a task."
      }
    });

    expect(result).toMatchObject({
      status: "completed",
      toolStatus: "accepted",
      repaired: false
    });

    const audit = await store.listAudit(context, true);
    const tasks = await store.listTasks(context);
    expect(tasks).toEqual([
      expect.objectContaining({
        title: "Proposed task",
        prompt: "Do useful work."
      })
    ]);
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "agent_run.create" }),
        expect.objectContaining({ action: "mcp.session.create" }),
        expect.objectContaining({ action: "mcp.tool.ok" }),
        expect.objectContaining({ action: "task.create" }),
        expect.objectContaining({ action: "tool_call.accepted" }),
        expect.objectContaining({ action: "agent_run.completed" })
      ])
    );
  });

  it("keeps the local tool client as a deterministic compatibility fallback", async () => {
    const { context, store } = await testContext();

    const result = await runAgentTask({
      context,
      store,
      toolClient: new LocalToolClient(),
      modelClient: new MockModelClient({
        tools: [
          {
            toolName: "record_observation",
            arguments: {
              summary: "No side effects required.",
              source: "unit-test"
            }
          }
        ]
      }),
      request: {
        prompt: "Record an observation."
      }
    });

    expect(result).toMatchObject({
      status: "completed",
      toolStatus: "accepted",
      sideEffect: "none",
      executionResult: {
        recorded: true,
        source: "unit-test"
      }
    });
    const audit = await store.listAudit(context, true);
    expect(audit).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "mcp.session.create" })
      ])
    );
  });

  it("enforces MCP session auth, expiration, allowlists, and agent-tool validation", async () => {
    const { context, store } = await testContext();
    const app = buildMcpApp({
      settings: loadSettings({ APP_ENV: "test", AUTH_MODE: "standalone" }),
      store
    });

    const expired = await store.createAgentMcpSession(context, {
      ttlSeconds: -1,
      allowedTools: ["list_ongoing_tasks"]
    });
    const expiredResponse = await app.request("/mcp/v1/tools/list_ongoing_tasks/call", {
      method: "POST",
      headers: {
        authorization: `Bearer ${expired.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({})
    });
    expect(expiredResponse.status).toBe(401);

    const session = await store.createAgentMcpSession(context, {
      ttlSeconds: 60,
      allowedTools: ["list_ongoing_tasks"]
    });
    const forbidden = await app.request("/mcp/v1/tools/create_task/call", {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ title: "Blocked", prompt: "Should not run." })
    });
    expect(forbidden.status).toBe(403);

    const malformed = await app.request("/mcp/v1/tools/list_ongoing_tasks/call", {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ reason: "" })
    });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({
      error: { code: "mcp_validation_failed" }
    });

    const ok = await app.request("/mcp/v1/tools/list_ongoing_tasks/call", {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ reason: "Allowed lookup." })
    });
    expect(ok.status).toBe(200);
    await expect(ok.json()).resolves.toMatchObject({
      ok: true,
      tool: "list_ongoing_tasks",
      sideEffect: "none",
      result: { tasks: [] }
    });
  });

  it("records a failed tool call when the MCP boundary rejects execution", async () => {
    const { context, store } = await testContext();

    const result = await runAgentTask({
      context,
      store,
      toolClient: {
        async execute() {
          throw new Error("MCP tool arguments failed validation.");
        }
      },
      modelClient: new MockModelClient({
        tools: [
          {
            toolName: "create_task",
            arguments: {
              title: "Boundary rejected task",
              prompt: "This should not be created."
            }
          }
        ]
      }),
      request: {
        prompt: "Create a task."
      }
    });

    expect(result).toMatchObject({
      status: "failed",
      toolStatus: "rejected",
      toolName: "create_task",
      failureMessage: "MCP tool arguments failed validation."
    });
    await expect(store.listTasks(context)).resolves.toEqual([]);
    await expect(store.listAudit(context, true)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "tool_call.failed" }),
        expect.objectContaining({ action: "agent_run.failed" })
      ])
    );
  });

  it("lets owner inbound messages continue an existing task", async () => {
    const { context, store } = await testContext();
    const task = await store.createTask(context, {
      title: "Call the dentist",
      prompt: "Find an appointment."
    });
    const message = await store.recordInboundMessage(context, {
      providerMessageId: "owner-inbound-1",
      fromAddr: "owner-sms@example.test",
      toAddr: "agent@example.test",
      bodyText: "This is for the dentist task. Try mornings.",
      source: "sms"
    }, "owner");

    const prompt = await buildOwnerInboundPrompt({ context, store, message });
    expect(prompt).toContain(task.id);
    expect(prompt).toContain("If it belongs to an active or completed task, use append_task_prompt");

    const result = await runOwnerInboundAgent({
      context,
      store,
      message,
      modelClient: new MockModelClient({
        tools: [
          {
            toolName: "append_task_prompt",
            arguments: {
              taskId: task.id,
              prompt: "Owner added a morning preference."
            }
          }
        ]
      })
    });

    expect(result).toMatchObject({
      status: "completed",
      toolName: "append_task_prompt",
      taskId: task.id
    });
    expect(result.taskEventId).toBeTruthy();
    await expect(store.getTask(context, task.id)).resolves.toMatchObject({
      status: "pending",
      prompt: expect.stringContaining("Owner added a morning preference.")
    });
  });

  it("includes bounded recent owner context so short SMS follow-ups can refer to completed work", async () => {
    const { context, store } = await testContext();
    const task = await store.createTask(context, {
      title: "Send the atom joke",
      prompt: "Tell the owner the atom joke."
    });
    await store.updateTask(context, task.id, { status: "completed" });
    const prior = await store.recordInboundMessage(context, {
      providerMessageId: "owner-memory-prior",
      fromAddr: "owner-sms@example.test",
      toAddr: "agent@example.test",
      bodyText: "Your joke got cut off.",
      source: "sms"
    }, "owner");
    await store.updateInboundMessageHandling(context, prior.id, {
      action: "routed_to_agent",
      taskId: task.id
    });
    await store.queueOutboundMessage(context, {
      channel: "sms",
      status: "sent",
      toAddr: "owner-sms@example.test",
      bodyText: "Why don't scientists trust atoms? Because they make up everything."
    });
    const message = await store.recordInboundMessage(context, {
      providerMessageId: "owner-memory-current",
      fromAddr: "owner-sms@example.test",
      toAddr: "agent@example.test",
      bodyText: "send the full joke",
      source: "sms"
    }, "owner");

    const prompt = await buildOwnerInboundPrompt({ context, store, message });

    expect(prompt).toContain("Recent memory/context:");
    expect(prompt).toContain("Send the atom joke");
    expect(prompt).toContain(task.id);
    expect(prompt).toContain("Your joke got cut off.");
    expect(prompt).toContain("Why don't scientists trust atoms?");
    expect(prompt).not.toContain("providerMessageId");
  });

  it("includes saved personal memory in owner inbound prompts", async () => {
    const { context, store } = await testContext();
    await store.upsertMemoryDocument(context, {
      slug: PERSONAL_PROFILE_SLUG,
      title: "Personal Profile",
      body: "# Personal Profile\n\n- The owner's cat is named Pierre."
    });
    const message = await store.recordInboundMessage(context, {
      providerMessageId: "owner-memory-profile-current",
      fromAddr: "owner-sms@example.test",
      toAddr: "agent@example.test",
      bodyText: "What should I do next?",
      source: "sms"
    }, "owner");

    const prompt = await buildOwnerInboundPrompt({ context, store, message });

    expect(prompt).toContain("Saved personal memory:");
    expect(prompt).toContain("The owner's cat is named Pierre.");
  });

  it("exposes a read-only recent context lookup tool", async () => {
    const { context, store } = await testContext();
    const task = await store.createTask(context, {
      title: "Remember this task",
      prompt: "Context to remember."
    });
    await store.updateTask(context, task.id, { status: "completed" });
    await store.recordInboundMessage(context, {
      providerMessageId: "owner-context-tool",
      fromAddr: "owner-sms@example.test",
      toAddr: "agent@example.test",
      bodyText: "This is useful history.",
      source: "sms"
    }, "owner");

    const result = await runAgentTask({
      context,
      store,
      modelClient: new MockModelClient({
        tools: [
          {
            toolName: "list_recent_context",
            arguments: {
              reason: "Check whether the new SMS relates to old work.",
              limit: 5
            }
          }
        ]
      }),
      request: {
        prompt: "Look up recent context."
      }
    });

    expect(result).toMatchObject({
      status: "completed",
      toolName: "list_recent_context",
      sideEffect: "none"
    });
    expect(result.executionResult?.tasks).toEqual([
      expect.objectContaining({
        task_id: task.id,
        title: "Remember this task",
        status: "completed"
      })
    ]);
    expect(result.executionResult?.inbound).toEqual([
      expect.objectContaining({
        body_excerpt: "This is useful history."
      })
    ]);
  });

  it("queues owner replies to the inbound SMS gateway without model-selected recipients", async () => {
    const { context, store } = await testContext();
    const message = await store.recordInboundMessage(context, {
      providerMessageId: "owner-reply-1",
      fromAddr: "owner-sms@example.test",
      toAddr: "agent@example.test",
      bodyText: "Are you online?",
      source: "sms"
    }, "owner");

    const result = await runOwnerInboundAgent({
      context,
      store,
      message,
      modelClient: new MockModelClient({
        tools: [
          {
            toolName: "propose_outbound_message",
            arguments: {
              intent: "reply",
              body: "Yes, I am online."
            }
          }
        ]
      })
    });

    expect(result).toMatchObject({
      status: "completed",
      toolName: "propose_outbound_message"
    });
    const outbox = await store.listOutboundMessages(context);
    expect(outbox).toEqual([
      expect.objectContaining({
        channel: "sms",
        status: "pending",
        toAddr: "owner-sms@example.test",
        bodyText: "Yes, I am online."
      })
    ]);
  });

  it("rejects model-selected outbound recipients", async () => {
    const result = await validateOrRepairToolCall(
      {
        toolName: "propose_outbound_message",
        arguments: {
          channel: "sms",
          to: "15555550100",
          body: "This should not validate."
        }
      },
      {
        modelClient: new MockModelClient(),
        repairModel: "repair-model",
        repairAttemptLimit: 0
      }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.validationErrors.join(" ")).toContain("Unrecognized");
    }
  });

  it("repairs a malformed tool call before accepting it", async () => {
    const { context, store } = await testContext();

    const result = await runAgentTask({
      context,
      store,
      modelClient: new MockModelClient({
        tools: [
          {
            toolName: "create_task",
            arguments: {
              prompt: "Needs a title."
            }
          }
        ],
        repairs: [
          {
            title: "Fixed",
            prompt: "Needs a title."
          }
        ]
      }),
      request: {
        prompt: "Create a task."
      }
    });

    expect(result).toMatchObject({
      status: "completed",
      toolStatus: "accepted",
      repaired: true
    });
  });

  it("rejects invalid tool calls after repair budget without side effects", async () => {
    const { context, store } = await testContext();

    const result = await runAgentTask({
      context,
      store,
      modelClient: new MockModelClient({
        tools: [
          {
            toolName: "create_task",
            arguments: {
              prompt: "Invalid."
            }
          }
        ],
        repairs: [
          {
            prompt: "Still invalid."
          }
        ]
      }),
      request: {
        prompt: "Create a task."
      }
    });

    expect(result).toMatchObject({
      status: "failed",
      toolStatus: "rejected",
      repaired: true
    });

    const tasks = await store.listTasks(context);
    expect(tasks).toEqual([]);
    const audit = await store.listAudit(context, true);
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "tool_call.rejected" }),
        expect.objectContaining({ action: "agent_run.failed" })
      ])
    );
  });

  it("fails clearly when OpenAI is selected without an API key", async () => {
    const client = new OpenAIModelClient();

    await expect(client.runWithTools({
      model: "test",
      tier: "fast",
      prompt: "hello",
      tools: []
    })).rejects.toThrow("OpenAI API key is not configured");
  });

  it("parses OpenAI Responses API function calls into internal tool proposals", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output: [
          {
            type: "function_call",
            name: "create_task",
            arguments: JSON.stringify({
              title: "From OpenAI",
              prompt: "Do the thing."
            })
          }
        ]
      })
    });
    const client = new OpenAIModelClient({
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    await expect(client.runWithTools({
      model: "gpt-test",
      tier: "fast",
      prompt: "Make a task",
      tools: modelToolDescriptors()
    })).resolves.toEqual({
      toolName: "create_task",
      arguments: {
        title: "From OpenAI",
        prompt: "Do the thing."
      }
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.openai.com/v1/responses",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer test-key"
        })
      })
    );
  });
});
