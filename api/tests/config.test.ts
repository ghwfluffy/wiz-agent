import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings, normalizeBasePath } from "../src/config/settings.js";

describe("settings", () => {
  it("loads standalone defaults", () => {
    const settings = loadSettings({});

    expect(settings.authMode).toBe("standalone");
    expect(settings.authBaseUrl).toBe("/auth");
    expect(settings.appBasePath).toBe("");
    expect(settings.devUserEmail).toBe("dev@example.test");
    expect(settings.agentMaxRunsPerUserPerHour).toBe(20);
    expect(settings.agentMaxOwnerVisibleOutboundMessagesPerUserPerDay).toBe(10);
    expect(settings.agentOutboundMessagesPerWorkerTick).toBe(1);
    expect(settings.inboundMaxUntrustedReviewNotificationsPerSenderPerDay).toBe(5);
  });

  it("loads runaway guardrail overrides", () => {
    const settings = loadSettings({
      AGENT_MAX_RUNS_PER_USER_PER_HOUR: "7",
      AGENT_MAX_AUTONOMOUS_RUNS_PER_WORKER_TICK: "3",
      AGENT_MAX_OWNER_VISIBLE_OUTBOUND_MESSAGES_PER_USER_PER_DAY: "4",
      AGENT_OUTBOUND_MESSAGES_PER_WORKER_TICK: "2",
      AGENT_MAX_NEWSLETTER_DOCUMENTS_PER_INTEREST_CHECK: "11",
      INBOUND_MAX_UNTRUSTED_REVIEW_NOTIFICATIONS_PER_SENDER_PER_DAY: "2"
    });

    expect(settings.agentMaxRunsPerUserPerHour).toBe(7);
    expect(settings.agentMaxAutonomousRunsPerWorkerTick).toBe(3);
    expect(settings.agentMaxOwnerVisibleOutboundMessagesPerUserPerDay).toBe(4);
    expect(settings.agentOutboundMessagesPerWorkerTick).toBe(2);
    expect(settings.agentMaxNewsletterDocumentsPerInterestCheck).toBe(11);
    expect(settings.inboundMaxUntrustedReviewNotificationsPerSenderPerDay).toBe(2);
  });

  it("normalizes base paths", () => {
    expect(normalizeBasePath("")).toBe("");
    expect(normalizeBasePath("/")).toBe("");
    expect(normalizeBasePath("agent")).toBe("/agent");
    expect(normalizeBasePath("/agent/")).toBe("/agent");
  });

  it("loads the OpenAI API key from a configured file", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-config-"));
    const keyPath = join(dir, "openai.txt");
    writeFileSync(keyPath, "test-key\n", "utf8");

    const settings = loadSettings({
      AGENT_OPENAI_API_KEY_FILE: keyPath
    });

    expect(settings.agentOpenaiApiKey).toBe("test-key");
  });
});
