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
import { buildApp } from "../src/http/app.js";
import { buildCapabilityContext, getIntegrationAction, listAppCapabilities } from "../src/integrations/capabilityRegistry.js";
import { recordDecisionLedgerForToolCall } from "../src/memory/decisionLedger.js";
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
  it("documents registered app purpose, access, and actions for model context", () => {
    const apps = listAppCapabilities();
    const context = buildCapabilityContext();

    expect(apps.map((app) => app.id)).toEqual(["goals", "budget", "apartment_gate"]);
    expect(context).toContain("Personal goal tracking");
    expect(context).toContain("Personal finance planning");
    expect(context).toContain("Federated-login protected mobile web app");
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
        expect.objectContaining({ name: "list_app_capabilities", access: "read", sideEffect: "none" }),
        expect.objectContaining({ name: "list_goals", access: "read", sideEffect: "cross_app_api" }),
        expect.objectContaining({ name: "create_goal", access: "write", sideEffect: "local_persistence" }),
        expect.objectContaining({ name: "list_budget_accounts", access: "read", sideEffect: "cross_app_api" }),
        expect.objectContaining({ name: "create_budget_contract", access: "write", sideEffect: "local_persistence" }),
        expect.objectContaining({ name: "create_budget_expense", access: "write", sideEffect: "local_persistence" }),
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

  it("blocks agent runs after the per-user hourly guardrail is reached", async () => {
    const { context, store } = await testContext();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      AGENT_MAX_RUNS_PER_USER_PER_HOUR: "1"
    });
    await store.createAgentRun(context, {
      taskId: null,
      status: "completed",
      modelTier: "fast",
      modelId: "test-model",
      promptVersion: "test"
    });

    const result = await runAgentTask({
      context,
      store,
      settings,
      modelClient: new MockModelClient(),
      request: {
        prompt: "This should be blocked before model execution."
      }
    });

    expect(result).toMatchObject({
      status: "failed",
      toolStatus: "none",
      failureMessage: "Agent run hourly guardrail exceeded."
    });
    await expect(store.listAgentRuns(context)).resolves.toHaveLength(1);
    await expect(store.listAudit(context, true)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "guardrail.exceeded",
        details: expect.objectContaining({
          guardrail: "maxAgentRunsPerUserPerHour",
          limit: 1
        })
      })
    ]));
  });

  it("fails a run cleanly when the MCP/tool-call guardrail is exceeded", async () => {
    const { context, store } = await testContext();
    await store.updateAiConfig(context, {
      fastModel: "gpt-5-mini",
      smartModel: "gpt-5",
      orchestratorModel: "gpt-5",
      repairModel: "gpt-5-mini",
      maxToolCalls: 0,
      maxRuntimeSec: 120,
      repairAttemptLimit: 1
    });

    const result = await runAgentTask({
      context,
      store,
      toolClient: new LocalToolClient(),
      modelClient: new MockModelClient({
        tools: [
          {
            toolName: "record_observation",
            arguments: {
              summary: "Should not execute.",
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
      status: "failed",
      toolStatus: "rejected",
      toolName: "record_observation",
      failureMessage: "MCP/tool call guardrail exceeded for this run."
    });
    await expect(store.listToolCalls(context)).resolves.toEqual([
      expect.objectContaining({
        toolName: "record_observation",
        status: "rejected",
        validationError: "guardrail_exceeded:maxToolCallsPerRun",
        result: expect.objectContaining({
          status: "guardrail_exceeded",
          reason: "maxToolCallsPerRun",
          limit: 0
        })
      })
    ]);
    await expect(store.listAudit(context, true)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "guardrail.exceeded",
        details: expect.objectContaining({
          guardrail: "maxToolCallsPerRun",
          tool_name: "record_observation"
        })
      })
    ]));
  });

  it("blocks owner-visible outbound proposals after the daily guardrail is reached", async () => {
    const { context, store } = await testContext();
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone",
      AGENT_MAX_OWNER_VISIBLE_OUTBOUND_MESSAGES_PER_USER_PER_DAY: "1"
    });
    await store.upsertConnector(context, {
      kind: "owner-contact",
      status: "enabled",
      config: {
        sms_gateway: "owner-sms@example.test"
      }
    });
    await store.queueOutboundMessage(context, {
      channel: "sms",
      status: "requires_approval",
      toAddr: "owner-sms@example.test",
      bodyText: "Existing owner-visible proposal."
    });

    const result = await runAgentTask({
      context,
      store,
      settings,
      toolClient: new LocalToolClient(),
      modelClient: new MockModelClient({
        tools: [
          {
            toolName: "propose_outbound_message",
            arguments: {
              intent: "reply",
              body: "This should be blocked."
            }
          }
        ]
      }),
      request: {
        prompt: "Queue an owner-visible message."
      }
    });

    expect(result).toMatchObject({
      status: "failed",
      toolStatus: "rejected",
      toolName: "propose_outbound_message",
      failureMessage: "Owner-visible outbound message daily guardrail exceeded."
    });
    await expect(store.listOutboundMessages(context)).resolves.toHaveLength(1);
    await expect(store.listApprovals(context, ["pending"])).resolves.toEqual([]);
    await expect(store.listToolCalls(context)).resolves.toEqual([
      expect.objectContaining({
        toolName: "propose_outbound_message",
        status: "failed",
        validationError: "guardrail_exceeded:maxOwnerVisibleOutboundMessagesPerUserPerDay",
        result: expect.objectContaining({
          status: "guardrail_exceeded",
          reason: "maxOwnerVisibleOutboundMessagesPerUserPerDay",
          limit: 1
        })
      })
    ]);
  });

  it("records cross-app approval decisions in the monthly decision ledger", async () => {
    const { context, store } = await testContext();

    const result = await runAgentTask({
      context,
      store,
      toolClient: new LocalToolClient(),
      modelClient: new MockModelClient({
        tools: [
          {
            toolName: "create_goal",
            arguments: {
              goalType: "checklist",
              title: "Ship phase 03",
              startDate: "2026-06-13",
              userIntentSummary: "Create a goal for finishing the decision ledger phase."
            }
          }
        ]
      }),
      request: {
        prompt: "Create a goal."
      }
    });

    expect(result).toMatchObject({
      status: "completed",
      toolStatus: "accepted",
      executionResult: expect.objectContaining({
        approval_required: true,
        action_id: "goals.create_goal"
      })
    });
    const [approval] = await store.listApprovals(context, ["pending"]);
    const [toolCall] = await store.listToolCalls(context);
    const ledger = await store.getMarkdownDocument(context, "/assistant/decisions/2026-06.md");
    expect(ledger).toMatchObject({
      userId: context.userId,
      markdown: expect.stringContaining("queued cross-app write approval")
    });
    expect(ledger?.markdown).toContain(`approvalId: ${approval.id}`);
    expect(ledger?.markdown).toContain(`toolCallId: ${toolCall.id}`);
    expect(ledger?.markdown).toContain("actionId: goals.create_goal");
    await expect(store.getMarkdownIndexStatus(context, "/assistant/decisions")).resolves.toEqual([
      expect.objectContaining({
        path: "/assistant/decisions/2026-06.md",
        pendingJobs: 1
      })
    ]);
  });

  it("does not duplicate a decision ledger entry for the same persisted tool call", async () => {
    const { context, store } = await testContext();
    const toolCall = await store.recordToolCall(context, {
      runId: null,
      toolName: "record_observation",
      status: "accepted",
      arguments: {
        summary: "Stayed quiet because there was nothing useful to do.",
        source: "unit-test"
      },
      result: {
        accepted: true,
        side_effect_executed: false,
        side_effect: "none",
        execution: {
          recorded: true,
          source: "unit-test",
          summary: "Stayed quiet because there was nothing useful to do."
        }
      }
    });

    await recordDecisionLedgerForToolCall({
      store,
      context,
      toolCall,
      now: new Date("2026-06-13T12:00:00.000Z")
    });
    await recordDecisionLedgerForToolCall({
      store,
      context,
      toolCall,
      now: new Date("2026-06-13T12:00:00.000Z")
    });

    const ledger = await store.getMarkdownDocument(context, "/assistant/decisions/2026-06.md");
    expect(ledger?.markdown.match(new RegExp(`assistant-decision:tool-call:${toolCall.id}`, "g"))).toHaveLength(1);
  });

  it("does not claim no-op accepted tool calls wrote decision side effects", async () => {
    const { context, store } = await testContext();
    const toolCall = await store.recordToolCall(context, {
      runId: null,
      toolName: "write_file",
      status: "accepted",
      arguments: {
        path: "/assistant/self-review/2026-06-13.md",
        content: "# Self Review",
        rationale: "Write a self-review note."
      },
      result: {
        accepted: true,
        side_effect_executed: false,
        side_effect: "none",
        execution: {
          code: "conflict",
          path: "/assistant/self-review/2026-06-13.md"
        }
      }
    });

    await expect(recordDecisionLedgerForToolCall({
      store,
      context,
      toolCall,
      now: new Date("2026-06-13T12:00:00.000Z")
    })).resolves.toMatchObject({ wrote: false, reason: "not_meaningful" });
    await expect(store.getMarkdownDocument(context, "/assistant/decisions/2026-06.md")).resolves.toBeUndefined();
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

  it("exposes app capability registry through a read-only MCP tool", async () => {
    const { context, store } = await testContext();
    const app = buildMcpApp({
      settings: loadSettings({ APP_ENV: "test", AUTH_MODE: "standalone" }),
      store
    });
    const session = await store.createAgentMcpSession(context, {
      ttlSeconds: 60,
      allowedTools: ["list_app_capabilities"]
    });

    const response = await app.request("/mcp/v1/tools/list_app_capabilities/call", {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ appId: "apartment_gate" })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      tool: "list_app_capabilities",
      sideEffect: "none",
      result: {
        apps: [
          expect.objectContaining({
            id: "apartment_gate",
            display_name: "Apartment Gate",
            action_count: 0,
            actions: []
          })
        ]
      }
    });
  });

  it("executes simplified read-only app wrapper tools through the integration gateway", async () => {
    const { context, store } = await testContext();
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ([{ id: "acct-1", name: "Chase" }])
    });
    const app = buildMcpApp({
      settings: loadSettings({
        APP_ENV: "test",
        AUTH_MODE: "standalone",
        BUDGET_API_BASE_URL: "https://budget.example.test/api"
      }),
      store,
      integrationTokenProvider: {
        async tokenFor(_context, appId, scope) {
          return `${appId}:${scope}:token`;
        }
      },
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    const session = await store.createAgentMcpSession(context, {
      ttlSeconds: 60,
      allowedTools: ["list_budget_accounts"]
    });

    const response = await app.request("/mcp/v1/tools/list_budget_accounts/call", {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ reason: "Find the Chase card account id." })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      tool: "list_budget_accounts",
      sideEffect: "cross_app_api",
      result: {
        status: 200,
        data: [{ id: "acct-1", name: "Chase" }]
      }
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL("https://budget.example.test/api/accounts"),
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          authorization: "Bearer budget:budget.list_accounts:token"
        })
      })
    );
  });

  it("queues simplified budget contract and expense writes for approval", async () => {
    const { context, store } = await testContext();
    const app = buildMcpApp({
      settings: loadSettings({ APP_ENV: "test", AUTH_MODE: "standalone" }),
      store
    });
    const session = await store.createAgentMcpSession(context, {
      ttlSeconds: 60,
      allowedTools: ["create_budget_contract", "create_budget_expense"]
    });

    const contractResponse = await app.request("/mcp/v1/tools/create_budget_contract/call", {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        name: "Codex",
        type: "payment",
        amountCents: 19900,
        organization: "OpenAI",
        linkedAccountId: "acct-chase",
        paymentPeriod: "monthly",
        paymentDay: 9,
        billingDay: 9,
        userIntentSummary: "Add Codex as a monthly Chase card bill."
      })
    });
    expect(contractResponse.status).toBe(200);

    const expenseResponse = await app.request("/mcp/v1/tools/create_budget_expense/call", {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        name: "Taco Bell",
        category: "Dining",
        estimatedAmountCents: 2000,
        linkedAccountId: "acct-chase",
        generalFrequency: "{\"kind\":\"weekly_weekday\",\"weekday\":5}",
        userIntentSummary: "Add observed Saturday Taco Bell spending to projected expenses."
      })
    });
    expect(expenseResponse.status).toBe(200);

    await expect(store.listApprovals(context, ["pending"])).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        actionType: "cross_app_write_action",
        sourceRef: "budget.create_contract",
        proposedPayload: expect.objectContaining({
          action_id: "budget.create_contract",
          body: expect.objectContaining({
            name: "Codex",
            amount_cents: 19900,
            linked_account_id: "acct-chase",
            payment_period: "monthly",
            payment_day: 9
          })
        })
      }),
      expect.objectContaining({
        actionType: "cross_app_write_action",
        sourceRef: "budget.create_expense",
        proposedPayload: expect.objectContaining({
          action_id: "budget.create_expense",
          body: expect.objectContaining({
            name: "Taco Bell",
            estimated_amount_cents: 2000,
            linked_account_id: "acct-chase",
            general_frequency: "{\"kind\":\"weekly_weekday\",\"weekday\":5}"
          })
        })
      })
    ]));
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

  it("includes intent-based personal memory list guidance in owner prompts", async () => {
    const { context, store } = await testContext();
    const message = await store.recordInboundMessage(context, {
      providerMessageId: "owner-memory-list-guidance",
      fromAddr: "owner-sms@example.test",
      toAddr: "agent@example.test",
      bodyText: "That is one for movie night.",
      source: "sms"
    }, "owner");

    const prompt = await buildOwnerInboundPrompt({ context, store, message });

    expect(prompt).toContain("When the owner expresses intent to preserve an item for later recall");
    expect(prompt).toContain("The owner may not say remember, add, or list.");
    expect(prompt).toContain("add_memory_list_item");
    expect(prompt).toContain("Do not create a task unless the owner asks you to do work.");
    expect(prompt).toContain("use search_memory_lists before broad markdown/RAG search");
  });

  it("includes intent-based owner feedback guidance in owner prompts", async () => {
    const { context, store } = await testContext();
    const message = await store.recordInboundMessage(context, {
      providerMessageId: "owner-feedback-guidance",
      fromAddr: "owner-sms@example.test",
      toAddr: "agent@example.test",
      bodyText: "Don't text me this early.",
      source: "sms"
    }, "owner");

    const prompt = await buildOwnerInboundPrompt({ context, store, message });

    expect(prompt).toContain("Owner feedback signals:");
    expect(prompt).toContain("record_owner_feedback");
    expect(prompt).toContain("The owner may use inconsistent wording");
    expect(prompt).toContain("don't text me this early");
    expect(prompt).toContain("Feedback capture is additive review evidence.");
    expect(prompt).toContain("Do not automatically rewrite communication preferences");
  });

  it("rejects owner feedback records without original context", async () => {
    const result = await validateOrRepairToolCall(
      {
        toolName: "record_owner_feedback",
        arguments: {
          feedbackType: "communication",
          correctionText: "Don't text me this early.",
          durability: "durable",
          followUpTarget: "communication_preferences",
          rationale: "Owner corrected contact timing."
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
      expect(result.validationErrors.join(" ")).toContain("originalBehaviorSummary");
    }
  });

  it("records owner feedback through MCP as monthly markdown with audit and RAG indexing", async () => {
    const { context, store } = await testContext();
    const app = buildMcpApp({
      settings: loadSettings({ APP_ENV: "test", AUTH_MODE: "standalone" }),
      store
    });
    const session = await store.createAgentMcpSession(context, {
      ttlSeconds: 60,
      allowedTools: ["record_owner_feedback"]
    });

    const response = await app.request("/mcp/v1/tools/record_owner_feedback/call", {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        feedbackType: "communication",
        correctionText: "Don't text me this early.",
        originalBehaviorSummary: "The assistant proposed an SMS before the owner wanted contact.",
        affectedMessageIds: ["msg-early"],
        affectedTaskIds: ["task\nwith newline"],
        durability: "durable",
        followUpTarget: "communication_preferences",
        rationale: "Owner corrected proactive contact timing."
      })
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      tool: "record_owner_feedback",
      sideEffect: "local_persistence",
      result: {
        path: expect.stringMatching(/^\/assistant\/feedback\/\d{4}-\d{2}\.md$/),
        feedback_type: "communication",
        durability: "durable",
        follow_up_target: "communication_preferences"
      }
    });
    const path = String(body.result.path);
    await expect(store.getMarkdownDocument(context, path)).resolves.toMatchObject({
      markdown: expect.stringContaining("Don't text me this early.")
    });
    await expect(store.getMarkdownDocument(context, path)).resolves.toMatchObject({
      markdown: expect.stringContaining("Do not automatically rewrite preferences")
    });
    await expect(store.getMarkdownDocument(context, path)).resolves.toMatchObject({
      markdown: expect.stringContaining("  - task with newline")
    });
    await expect(store.listAudit(context, true)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "markdown.write" }),
      expect.objectContaining({
        action: "owner_feedback.recorded",
        details: expect.objectContaining({
          path,
          feedback_type: "communication",
          follow_up_target: "communication_preferences"
        })
      }),
      expect.objectContaining({ action: "mcp.tool.ok" })
    ]));
    await expect(store.listRagIndexJobs(context, false, ["pending"])).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ jobType: "index_markdown" })
    ]));
  });

  it("routes inconsistent owner correction wording into feedback without rewriting preferences", async () => {
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone"
    });
    const store = createMemoryStore();
    const app = buildApp({
      settings,
      store,
      modelClient: new MockModelClient({
        tools: [
          {
            toolName: "record_owner_feedback",
            arguments: {
              feedbackType: "task",
              correctionText: "That was not a task, just remember it.",
              originalBehaviorSummary: "The assistant treated an owner memory offload as task creation.",
              affectedTaskIds: ["task-wrong-kind"],
              durability: "tentative",
              followUpTarget: "list_memory",
              rationale: "Owner corrected categorization of memory offload versus task work."
            }
          }
        ]
      })
    });
    const login = await app.request("/api/v1/auth/dev-login", { method: "POST" });
    const cookie = login.headers.get("set-cookie") ?? "";

    const response = await app.request("/api/v1/agent/prompts", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        prompt: "That was not a task, just remember it.",
        mode: "normal"
      })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "completed",
      selectedAction: "record_owner_feedback",
      toolStatus: "accepted",
      toolResult: {
        path: expect.stringMatching(/^\/assistant\/feedback\/\d{4}-\d{2}\.md$/),
        follow_up_target: "list_memory"
      }
    });
    const session = await store.getSession(cookie.match(/agent_session=([^;]+)/)?.[1]);
    expect(session).toBeTruthy();
    const context = {
      userId: session!.user.id,
      actorType: "admin" as const,
      permissions: ["user", "admin"],
      requestId: "web-feedback-prompt-test",
      session: session!
    };
    const feedbackFiles = await store.listMarkdownDirectory(context, "/assistant/feedback");
    expect(feedbackFiles).toHaveLength(1);
    await expect(store.getMarkdownDocument(context, feedbackFiles[0]!.path)).resolves.toMatchObject({
      markdown: expect.stringContaining("That was not a task, just remember it.")
    });
    await expect(store.getMarkdownDocument(context, "/assistant/preferences/communication.md")).resolves.toBeUndefined();
    await expect(store.getMarkdownDocument(context, "/assistant/preferences/newsletters.md")).resolves.toBeUndefined();
  });

  it("routes alternate owner list wording through personal memory list tools", async () => {
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone"
    });
    const store = createMemoryStore();
    const app = buildApp({
      settings,
      store,
      modelClient: new MockModelClient({
        tools: [
          {
            toolName: "add_memory_list_item",
            arguments: {
              listName: "movie night",
              item: "Desperado",
              notes: "Owner phrased this as one for movie night.",
              rationale: "Authenticated owner prompt expressed intent to save a movie for later recall."
            }
          }
        ]
      })
    });
    const login = await app.request("/api/v1/auth/dev-login", { method: "POST" });
    const cookie = login.headers.get("set-cookie") ?? "";

    const response = await app.request("/api/v1/agent/prompts", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        prompt: "Desperado is one for movie night.",
        mode: "normal"
      })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "completed",
      selectedAction: "add_memory_list_item",
      toolStatus: "accepted",
      toolResult: {
        path: "/personal/lists/movies.md",
        duplicate: false
      }
    });
    const session = await store.getSession(cookie.match(/agent_session=([^;]+)/)?.[1]);
    expect(session).toBeTruthy();
    await expect(store.getMarkdownDocument({
      userId: session!.user.id,
      actorType: "admin",
      permissions: ["user", "admin"],
      requestId: "web-list-prompt-test",
      session: session!
    }, "/personal/lists/movies.md")).resolves.toMatchObject({
      markdown: expect.stringContaining("Desperado")
    });
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

  it("exposes a read-only recent owner conversation lookup tool", async () => {
    const { context, store } = await testContext();
    await store.recordInboundMessage(context, {
      providerMessageId: "owner-conversation-tool",
      fromAddr: "owner-sms@example.test",
      toAddr: "agent@example.test",
      bodyText: "Use the west entrance for the appointment.",
      source: "sms"
    }, "owner");
    await store.queueOutboundMessage(context, {
      channel: "sms",
      status: "sent",
      toAddr: "owner-sms@example.test",
      bodyText: "I added that to the appointment notes."
    });

    const result = await runAgentTask({
      context,
      store,
      modelClient: new MockModelClient({
        tools: [
          {
            toolName: "list_recent_owner_conversations",
            arguments: {
              reason: "Resolve a short owner follow-up.",
              limit: 4
            }
          }
        ]
      }),
      request: {
        prompt: "Look up recent owner conversation."
      }
    });

    expect(result).toMatchObject({
      status: "completed",
      toolName: "list_recent_owner_conversations",
      sideEffect: "none"
    });
    expect(result.executionResult?.conversations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          direction: "inbound",
          body_excerpt: "Use the west entrance for the appointment."
        }),
        expect.objectContaining({
          direction: "outbound",
          body_excerpt: "I added that to the appointment notes."
        })
      ])
    );
  });

  it("exposes recent bot activity insights through MCP", async () => {
    const { context, store } = await testContext();
    await store.recordInboundMessage(context, {
      providerMessageId: "activity-owner-1",
      fromAddr: "owner-sms@example.test",
      toAddr: "agent@example.test",
      bodyText: "Any updates?",
      source: "sms"
    }, "owner");
    for (const bodyText of ["First update.", "Second update.", "Third update.", "Fourth update."]) {
      await store.queueOutboundMessage(context, {
        channel: "sms",
        status: "sent",
        toAddr: "owner-sms@example.test",
        bodyText
      });
    }
    await store.createApproval(context, {
      actionType: "send_outbound_message",
      proposedPayload: { body_text: "Pending owner-visible update." },
      riskLevel: "high",
      summary: "Pending owner-visible update.",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });

    const result = await runAgentTask({
      context,
      store,
      modelClient: new MockModelClient({
        tools: [
          {
            toolName: "get_recent_bot_activity",
            arguments: {
              reason: "Decide whether I have been contacting the owner too often.",
              lookbackHours: 24,
              limit: 3
            }
          }
        ]
      }),
      request: {
        prompt: "Check recent bot activity."
      }
    });

    expect(result).toMatchObject({
      status: "completed",
      toolName: "get_recent_bot_activity",
      sideEffect: "none",
      executionResult: {
        lookback_hours: 24,
        counts: expect.objectContaining({
          owner_visible_contact_attempts: 4,
          owner_inbound_messages: 1,
          pending_approvals: 1
        }),
        contact_cadence: expect.objectContaining({
          level: "high",
          outbound_attempts_per_day: 4
        }),
        recent_outbound: expect.arrayContaining([
          expect.objectContaining({
            status: "sent",
            body_excerpt: expect.stringContaining("update")
          })
        ])
      }
    });
    expect(modelToolDescriptors()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "get_recent_bot_activity",
        access: "read",
        sideEffect: "none"
      })
    ]));
  });

  it("updates task schedules with rationale through the decision tool", async () => {
    const { context, store } = await testContext();
    const task = await store.createTask(context, {
      title: "Renew passport",
      prompt: "Schedule passport renewal."
    });
    const dueAt = "2026-07-01T15:00:00.000Z";

    const result = await runAgentTask({
      context,
      store,
      modelClient: new MockModelClient({
        tools: [
          {
            toolName: "update_task_schedule",
            arguments: {
              taskId: task.id,
              dueAt,
              rationale: "Owner asked to handle it after the July holiday week.",
              confidence: "high"
            }
          }
        ]
      }),
      request: {
        prompt: "Reschedule the passport task.",
        taskId: task.id
      }
    });

    expect(result).toMatchObject({
      status: "completed",
      toolName: "update_task_schedule",
      executionResult: {
        task_id: task.id,
        due_at: dueAt,
        rationale: "Owner asked to handle it after the July holiday week.",
        confidence: "high"
      }
    });
    await expect(store.getTask(context, task.id)).resolves.toMatchObject({ dueAt });
    await expect(store.listTaskEvents(context, task.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "task.schedule_updated",
          details: expect.objectContaining({
            rationale: "Owner asked to handle it after the July holiday week.",
            confidence: "high"
          })
        })
      ])
    );
  });

  it("rejects schedule updates without rationale", async () => {
    const result = await validateOrRepairToolCall(
      {
        toolName: "update_task_schedule",
        arguments: {
          taskId: "task-1",
          dueAt: "2026-07-01T15:00:00.000Z",
          confidence: "high"
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
      expect(result.validationErrors.join(" ")).toContain("rationale");
    }
  });

  it("records durable task schedule rationale through the decision tool", async () => {
    const { context, store } = await testContext();
    const task = await store.createTask(context, {
      title: "Prepare quarterly review",
      prompt: "Collect review notes."
    });

    const result = await runAgentTask({
      context,
      store,
      modelClient: new MockModelClient({
        tools: [
          {
            toolName: "record_schedule_rationale",
            arguments: {
              taskId: task.id,
              rationale: "Review should happen after June metrics are final.",
              sourceMemoryPath: "/assistant/schedule.md",
              recurrencePolicy: "review during the next planning cycle",
              nextReviewAt: "2026-06-14T15:00:00.000Z"
            }
          }
        ]
      }),
      request: {
        prompt: "Record why this task is scheduled.",
        taskId: task.id
      }
    });

    expect(result).toMatchObject({
      status: "completed",
      toolName: "record_schedule_rationale",
      executionResult: {
        task_id: task.id,
        rationale: "Review should happen after June metrics are final."
      }
    });
    await expect(store.getTask(context, task.id)).resolves.toMatchObject({
      scheduleRationale: "Review should happen after June metrics are final.",
      sourceMemoryPath: "/assistant/schedule.md",
      recurrencePolicy: "review during the next planning cycle",
      nextReviewAt: "2026-06-14T15:00:00.000Z"
    });
  });

  it("preserves waiting and blocked context when updating only task status", async () => {
    const { context, store } = await testContext();
    const task = await store.createTask(context, {
      title: "Vendor follow-up",
      prompt: "Wait for the vendor quote."
    });
    await store.updateTask(context, task.id, {
      status: "waiting",
      waitingOn: "vendor quote",
      blockedReason: "Need external pricing.",
      ownerClarificationNeeded: true
    });

    const result = await runAgentTask({
      context,
      store,
      modelClient: new MockModelClient({
        tools: [
          {
            toolName: "update_task_status",
            arguments: {
              taskId: task.id,
              status: "pending",
              rationale: "Wake review should check whether the vendor replied."
            }
          }
        ]
      }),
      request: {
        prompt: "Resume the vendor task.",
        taskId: task.id
      }
    });

    expect(result).toMatchObject({
      status: "completed",
      toolName: "update_task_status"
    });
    await expect(store.getTask(context, task.id)).resolves.toMatchObject({
      status: "pending",
      waitingOn: "vendor quote",
      blockedReason: "Need external pricing.",
      ownerClarificationNeeded: true,
      scheduleRationale: "Wake review should check whether the vendor replied."
    });
  });

  it("turns ambiguous owner messages into clarification requests", async () => {
    const { context, store } = await testContext();
    await store.upsertConnector(context, {
      kind: "owner-contact",
      status: "enabled",
      config: {
        sms_gateway: "owner-sms@example.test"
      }
    });
    const message = await store.recordInboundMessage(context, {
      providerMessageId: "owner-clarify-1",
      fromAddr: "owner-sms@example.test",
      toAddr: "agent@example.test",
      bodyText: "Move it to after the thing.",
      source: "sms"
    }, "owner");

    const result = await runOwnerInboundAgent({
      context,
      store,
      message,
      modelClient: new MockModelClient({
        tools: [
          {
            toolName: "ask_owner_clarification",
            arguments: {
              question: "Which task should I move, and what date do you mean?",
              urgency: "now"
            }
          }
        ]
      })
    });

    expect(result).toMatchObject({
      status: "completed",
      toolName: "ask_owner_clarification",
      executionResult: {
        outbound_message_id: expect.any(String),
        clarification_request_id: expect.any(String),
        urgency: "now",
        destination: "inbound_owner_message"
      }
    });
    await expect(store.listOutboundMessages(context)).resolves.toEqual([
      expect.objectContaining({
        channel: "sms",
        toAddr: "owner-sms@example.test",
        bodyText: "Which task should I move, and what date do you mean?"
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
        status: "requires_approval",
        toAddr: "owner-sms@example.test",
        bodyText: "Yes, I am online."
      })
    ]);
    await expect(store.listApprovals(context, ["pending"])).resolves.toEqual([
      expect.objectContaining({
        actionType: "send_outbound_message",
        riskLevel: "high"
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

  it("lets authenticated web prompts use the same owner decision loop", async () => {
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone"
    });
    const store = createMemoryStore();
    const app = buildApp({
      settings,
      store,
      modelClient: new MockModelClient({
        tools: [
          {
            toolName: "write_memory",
            arguments: {
              slug: "personal-profile",
              title: "Personal Profile",
              appendMarkdown: "- The owner prefers concise morning briefings.",
              rationale: "Authenticated owner web prompt stated a durable preference."
            }
          }
        ]
      })
    });
    const login = await app.request("/api/v1/auth/dev-login", { method: "POST" });
    const cookie = login.headers.get("set-cookie") ?? "";

    const response = await app.request("/api/v1/agent/prompts", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        prompt: "Remember that I prefer concise morning briefings.",
        mode: "normal"
      })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "completed",
      selectedAction: "write_memory",
      toolStatus: "accepted",
      links: {
        memorySlug: "personal-profile"
      }
    });
    const session = await store.getSession(cookie.match(/agent_session=([^;]+)/)?.[1]);
    expect(session).toBeTruthy();
    await expect(store.getMemoryDocument({
      userId: session!.user.id,
      actorType: "admin",
      permissions: ["user", "admin"],
      requestId: "web-prompt-test",
      session: session!
    }, PERSONAL_PROFILE_SLUG)).resolves.toMatchObject({
      body: expect.stringContaining("concise morning briefings")
    });
  });

  it("requires auth before web prompts can reach decision tools", async () => {
    const app = buildApp({
      settings: loadSettings({
        APP_ENV: "test",
        AUTH_MODE: "standalone"
      }),
      modelClient: new MockModelClient({
        tools: [
          {
            toolName: "create_task",
            arguments: {
              title: "Should not happen",
              prompt: "Unauthenticated prompt."
            }
          }
        ]
      })
    });

    const response = await app.request("/api/v1/agent/prompts", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ prompt: "Create a task." })
    });

    expect(response.status).toBe(401);
  });

  it("limits web-created MCP sessions to read-only memory tools", async () => {
    const settings = loadSettings({
      APP_ENV: "test",
      AUTH_MODE: "standalone"
    });
    const store = createMemoryStore();
    const app = buildApp({ settings, store });
    const mcp = buildMcpApp({ settings, store });
    const login = await app.request("/api/v1/auth/dev-login", { method: "POST" });
    const cookie = login.headers.get("set-cookie") ?? "";

    const sessionResponse = await app.request("/api/v1/agent/mcp-sessions", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json"
      },
      body: JSON.stringify({ ttlSeconds: 60 })
    });
    expect(sessionResponse.status).toBe(201);
    const session = await sessionResponse.json() as { token: string; allowedTools: string[] };
    expect(session.allowedTools).toContain("read_file");
    expect(session.allowedTools).not.toContain("create_task");

    const readOnly = await mcp.request("/mcp/v1/tools/list_dir/call", {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ path: "/" })
    });
    expect(readOnly.status).toBe(200);

    const forbidden = await mcp.request("/mcp/v1/tools/create_task/call", {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ title: "Bypass", prompt: "Should not run." })
    });
    expect(forbidden.status).toBe(403);
    await expect(store.listTasks({
      userId: "dev-user",
      actorType: "admin",
      permissions: ["user", "admin"],
      requestId: "web-mcp-test",
      session: (await store.getSession(cookie.match(/agent_session=([^;]+)/)?.[1]))!
    })).resolves.toEqual([]);
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
