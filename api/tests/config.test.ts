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
    expect(settings.agentOwnerEmails).toEqual(["dev@example.test"]);
    expect(settings.agentMaxToolCalls).toBe(50);
    expect(settings.agentMaxRuntimeSec).toBe(500);
    expect(settings.agentMaxRunsPerUserPerBurstWindow).toBe(60);
    expect(settings.agentRunBurstWindowSeconds).toBe(600);
    expect(settings.agentMaxOwnerVisibleOutboundMessagesPerUserPerDay).toBe(10);
    expect(settings.agentOutboundMessagesPerWorkerTick).toBe(1);
    expect(settings.inboundMaxUntrustedReviewNotificationsPerSenderPerDay).toBe(5);
    expect(settings.agentWebResearchEnabled).toBe(false);
    expect(settings.agentWebResearchSearchContextSize).toBe("medium");
    expect(settings.agentWebResearchRetentionDays).toBe(30);
  });

  it("loads runaway guardrail overrides", () => {
    const settings = loadSettings({
      AGENT_MAX_RUNS_PER_USER_PER_BURST_WINDOW: "7",
      AGENT_RUN_BURST_WINDOW_SECONDS: "120",
      AGENT_MAX_AUTONOMOUS_RUNS_PER_WORKER_TICK: "3",
      AGENT_MAX_TOOL_CALLS: "12",
      AGENT_MAX_RUNTIME_SEC: "240",
      AGENT_MAX_OWNER_VISIBLE_OUTBOUND_MESSAGES_PER_USER_PER_DAY: "4",
      AGENT_OUTBOUND_MESSAGES_PER_WORKER_TICK: "2",
      AGENT_MAX_NEWSLETTER_DOCUMENTS_PER_INTEREST_CHECK: "11",
      INBOUND_MAX_UNTRUSTED_REVIEW_NOTIFICATIONS_PER_SENDER_PER_DAY: "2"
    });

    expect(settings.agentMaxRunsPerUserPerBurstWindow).toBe(7);
    expect(settings.agentRunBurstWindowSeconds).toBe(120);
    expect(settings.agentMaxAutonomousRunsPerWorkerTick).toBe(3);
    expect(settings.agentMaxToolCalls).toBe(12);
    expect(settings.agentMaxRuntimeSec).toBe(240);
    expect(settings.agentMaxOwnerVisibleOutboundMessagesPerUserPerDay).toBe(4);
    expect(settings.agentOutboundMessagesPerWorkerTick).toBe(2);
    expect(settings.agentMaxNewsletterDocumentsPerInterestCheck).toBe(11);
    expect(settings.inboundMaxUntrustedReviewNotificationsPerSenderPerDay).toBe(2);
  });

  it("treats the old hourly run guardrail env as a burst-window limit alias", () => {
    const settings = loadSettings({
      AGENT_MAX_RUNS_PER_USER_PER_HOUR: "8"
    });

    expect(settings.agentMaxRunsPerUserPerBurstWindow).toBe(8);
    expect(settings.agentRunBurstWindowSeconds).toBe(600);
  });

  it("normalizes base paths", () => {
    expect(normalizeBasePath("")).toBe("");
    expect(normalizeBasePath("/")).toBe("");
    expect(normalizeBasePath("agent")).toBe("/agent");
    expect(normalizeBasePath("/agent/")).toBe("/agent");
  });

  it("rejects unsafe base paths", () => {
    expect(() => normalizeBasePath("https://example.test/agent")).toThrow(/Base paths/);
    expect(() => normalizeBasePath("/../agent")).toThrow(/dot segments/);
    expect(() => normalizeBasePath("/agent?debug=true")).toThrow(/Base paths/);
  });

  it("rejects malformed env booleans, lists, paths, urls, and numeric budgets", () => {
    expect(() => loadSettings({ AGENT_OUTBOUND_ENABLED: "sometimes" })).toThrow();
    expect(() => loadSettings({ POSTGRES_PORT: "70000" })).toThrow();
    expect(() => loadSettings({ AGENT_MAX_TOOL_CALLS: "0" })).toThrow();
    expect(() => loadSettings({ AGENT_MAX_TOOL_CALLS: "1", AGENT_REPAIR_ATTEMPT_LIMIT: "2" })).toThrow(/REPAIR/);
    expect(() => loadSettings({ AGENT_OWNER_EMAILS: "not-an-email" })).toThrow();
    expect(() => loadSettings({ PUBLIC_URL: "https://example.test/agent" })).toThrow();
    expect(() => loadSettings({ SESSION_COOKIE_PATH: "/agent?debug=true" })).toThrow(/Base paths/);
    expect(() => loadSettings({ AGENT_WEB_RESEARCH_SEARCH_CONTEXT_SIZE: "unbounded" })).toThrow();
    expect(() => loadSettings({ AGENT_WEB_RESEARCH_MAX_SOURCES: "0" })).toThrow();
  });

  it("fails closed for unsafe production auth and deployment settings", () => {
    expect(() => loadSettings({
      APP_ENV: "production",
      AUTH_MODE: "standalone",
      POSTGRES_PASSWORD: "not-the-development-default",
      PUBLIC_URL: "https://agent.example.test",
      OAUTH_SERVER_BASE_URL: "http://auth-api:8000",
      AGENT_INTEGRATION_TOKEN_SECRET: "test-integration-secret"
    })).toThrow(/AUTH_MODE/);

    expect(() => loadSettings({
      APP_ENV: "production",
      AUTH_MODE: "oauth",
      POSTGRES_PASSWORD: "not-the-development-default",
      PUBLIC_URL: "http://localhost:18081",
      OAUTH_SERVER_BASE_URL: "http://auth-api:8000",
      AGENT_INTEGRATION_TOKEN_SECRET: "test-integration-secret"
    })).toThrow(/PUBLIC_URL/);

    expect(() => loadSettings({
      APP_ENV: "production",
      AUTH_MODE: "oauth",
      APP_BASE_PATH: "/agent",
      SESSION_COOKIE_PATH: "/",
      POSTGRES_PASSWORD: "not-the-development-default",
      PUBLIC_URL: "https://agent.example.test",
      OAUTH_SERVER_BASE_URL: "http://auth-api:8000",
      AGENT_INTEGRATION_TOKEN_SECRET: "test-integration-secret"
    })).toThrow(/SESSION_COOKIE_PATH/);
  });

  it("fails closed for production app integrations without a signing secret", () => {
    expect(() => loadSettings({
      APP_ENV: "production",
      AUTH_MODE: "oauth",
      POSTGRES_PASSWORD: "not-the-development-default",
      PUBLIC_URL: "https://agent.example.test",
      OAUTH_SERVER_BASE_URL: "http://auth-api:8000",
      GOALS_API_BASE_URL: "http://goals-api:8000"
    })).toThrow(/AGENT_INTEGRATION_TOKEN_SECRET/);

    expect(() => loadSettings({
      APP_ENV: "production",
      AUTH_MODE: "oauth",
      POSTGRES_PASSWORD: "not-the-development-default",
      PUBLIC_URL: "https://agent.example.test",
      OAUTH_SERVER_BASE_URL: "http://auth-api:8000",
      NOTES_API_BASE_URL: "http://notes-api:8000/api/agent/v1"
    })).toThrow(/AGENT_INTEGRATION_TOKEN_SECRET/);
  });

  it("does not bootstrap the development owner address in production", () => {
    const settings = loadSettings({
      APP_ENV: "production",
      AUTH_MODE: "oauth",
      POSTGRES_PASSWORD: "not-the-development-default",
      PUBLIC_URL: "https://agent.example.test",
      OAUTH_SERVER_BASE_URL: "http://auth-api:8000",
      AGENT_INTEGRATION_TOKEN_SECRET: "test-integration-secret"
    });

    expect(settings.agentOwnerEmails).toEqual([]);
  });

  it("requires an auxiliary OpenAI credential when production web research is enabled", () => {
    expect(() => loadSettings({
      APP_ENV: "production",
      AUTH_MODE: "oauth",
      POSTGRES_PASSWORD: "not-the-development-default",
      PUBLIC_URL: "https://agent.example.test",
      OAUTH_SERVER_BASE_URL: "http://auth-api:8000",
      AGENT_INTEGRATION_TOKEN_SECRET: "test-integration-secret",
      AGENT_WEB_RESEARCH_ENABLED: "true"
    })).toThrow(/AGENT_OPENAI_API_KEY/);
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
