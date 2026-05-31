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
