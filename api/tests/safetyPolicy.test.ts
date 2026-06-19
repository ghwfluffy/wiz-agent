import { describe, expect, it } from "vitest";
import { loadSettings } from "../src/config/settings.js";
import { createMemoryStore } from "../src/domain/store.js";
import type { RequestContext } from "../src/domain/types.js";
import {
  GuardrailExceededError,
  guardrailResult,
  recordGuardrailExceeded,
  sanitizeSafetyAuditDetails
} from "../src/security/safetyPolicy.js";

async function testContext(): Promise<{ context: RequestContext; store: ReturnType<typeof createMemoryStore> }> {
  const store = createMemoryStore();
  const settings = loadSettings({
    APP_ENV: "test",
    AUTH_MODE: "standalone"
  });
  const session = await store.createDevelopmentSession(settings, "safety-policy-login");
  return {
    store,
    context: {
      userId: session.user.id,
      actorType: "system",
      permissions: ["user", "system"],
      requestId: "safety-policy-test",
      session
    }
  };
}

describe("safety policy", () => {
  it("redacts secret-like guardrail detail keys and strings", () => {
    expect(sanitizeSafetyAuditDetails({
      count: 3,
      token: "fake-token-value",
      nested: {
        authorization: "Bearer fake-token-value",
        phase: "tool_execution"
      },
      evidence: ["ordinary count detail", "api key fake-token-value"]
    })).toEqual({
      count: 3,
      token: "[redacted]",
      nested: {
        authorization: "[redacted]",
        phase: "tool_execution"
      },
      evidence: ["ordinary count detail", "[redacted]"]
    });
  });

  it("records sanitized guardrail audit payloads without letting details override the guardrail", async () => {
    const { context, store } = await testContext();

    await recordGuardrailExceeded({
      context,
      store,
      guardrail: "maxToolCallsPerRun",
      entityType: "agent_run",
      entityId: "run-1",
      details: {
        guardrail: "caller-supplied",
        count: 11,
        authorization: "Bearer fake-token-value"
      }
    });

    await expect(store.listAudit(context, true)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "guardrail.exceeded",
        entityId: "run-1",
        details: {
          guardrail: "maxToolCallsPerRun",
          count: 11,
          authorization: "[redacted]"
        }
      })
    ]));
  });

  it("returns sanitized guardrail result envelopes with reserved fields intact", () => {
    const result = guardrailResult(new GuardrailExceededError(
      "maxToolCallsPerRun",
      "Tool budget exceeded.",
      {
        status: "caller-status",
        reason: "caller-reason",
        message: "caller-message",
        count: 11,
        token: "fake-token-value"
      }
    ));

    expect(result).toEqual({
      status: "guardrail_exceeded",
      reason: "maxToolCallsPerRun",
      message: "Tool budget exceeded.",
      count: 11,
      token: "[redacted]"
    });
  });
});
