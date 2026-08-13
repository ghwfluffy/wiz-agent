import { describe, expect, it } from "vitest";
import { MockModelClient } from "../src/agent/modelClient.js";
import { runAgentTask } from "../src/agent/runAgentTask.js";
import { loadSettings } from "../src/config/settings.js";
import { createMemoryStore } from "../src/domain/store.js";
import type { RequestContext } from "../src/domain/types.js";
import {
  MAX_RUNTIME_CPU_MODEL_CHARS,
  runtimeCpuModel,
  runtimeCpuOwnerMessage
} from "../src/tools/ownerMessaging.js";
import { executeToolCall } from "../src/tools/toolExecutor.js";
import { validateToolArguments } from "../src/tools/validator.js";

async function testContext(): Promise<{
  context: RequestContext;
  store: ReturnType<typeof createMemoryStore>;
}> {
  const settings = loadSettings({
    APP_ENV: "test",
    AUTH_MODE: "standalone"
  });
  const store = createMemoryStore();
  const session = await store.createDevelopmentSession(settings, "runtime-cpu-test-login");
  return {
    store,
    context: {
      userId: session.user.id,
      actorType: "user",
      permissions: ["user"],
      requestId: "runtime-cpu-test",
      session
    }
  };
}

describe("runtime CPU owner messaging", () => {
  it("normalizes and bounds the CPU model without returning other CPU details", () => {
    const longModel = `  Example\nCPU\u0000Model ${"x".repeat(MAX_RUNTIME_CPU_MODEL_CHARS)}  `;

    const model = runtimeCpuModel([{ model: longModel }]);

    expect(model).toBeTruthy();
    expect(model).toHaveLength(MAX_RUNTIME_CPU_MODEL_CHARS);
    expect(model).toMatch(/^Example CPU Model /);
    expect(model).not.toContain("\n");
    expect(model).not.toContain("\u0000");
  });

  it("uses a bounded explicit fallback when the runtime has no usable CPU model", () => {
    expect(runtimeCpuModel([])).toBeNull();
    expect(runtimeCpuModel([{ model: " \n\u0000 " }])).toBeNull();
    expect(runtimeCpuOwnerMessage(null)).toBe(
      "The AI assistant is running on a CPU whose model could not be determined from this runtime."
    );
    expect(runtimeCpuOwnerMessage(null).length).toBeLessThan(200);
  });

  it("queues the host-generated CPU model message to the configured owner destination", async () => {
    const { context, store } = await testContext();
    await store.upsertConnector(context, {
      kind: "owner-contact",
      status: "enabled",
      config: { sms_gateway: "owner-sms@example.test" }
    });

    const result = await runAgentTask({
      context,
      store,
      modelClient: new MockModelClient({
        tools: [{ toolName: "send_runtime_cpu_model", arguments: {} }]
      }),
      request: {
        prompt: "Send me a message naming the CPU you are running on.",
        ownerInitiated: true
      }
    });

    const detectedModel = result.executionResult?.cpu_model;
    expect(result).toMatchObject({
      status: "completed",
      toolStatus: "accepted",
      toolName: "send_runtime_cpu_model",
      sideEffect: "local_persistence",
      executionResult: {
        status: "pending",
        destination: "owner-contact",
        fallback_used: detectedModel === null
      }
    });
    await expect(store.listOutboundMessages(context)).resolves.toEqual([
      expect.objectContaining({
        channel: "sms",
        status: "pending",
        toAddr: "owner-sms@example.test",
        bodyText: runtimeCpuOwnerMessage(
          typeof detectedModel === "string" ? detectedModel : null
        )
      })
    ]);
  });

  it("rejects autonomous use and recipient-like tool arguments", async () => {
    const { context, store } = await testContext();
    await store.upsertConnector(context, {
      kind: "owner-contact",
      status: "enabled",
      config: { email: "owner@example.test" }
    });

    const result = await executeToolCall({
      context,
      store,
      toolName: "send_runtime_cpu_model",
      args: {}
    });

    expect(result).toEqual({
      executed: false,
      sideEffect: "none",
      result: {
        rejected: true,
        reason: "owner_command_required",
        approval_required: false
      }
    });
    await expect(store.listOutboundMessages(context)).resolves.toEqual([]);
    expect(validateToolArguments("send_runtime_cpu_model", {
      to: "attacker@example.test"
    }).ok).toBe(false);
  });
});
