import { describe, expect, it } from "vitest";
import { loadSettings, normalizeBasePath } from "../src/config/settings.js";

describe("settings", () => {
  it("loads standalone defaults", () => {
    const settings = loadSettings({});

    expect(settings.authMode).toBe("standalone");
    expect(settings.appBasePath).toBe("");
    expect(settings.devUserEmail).toBe("dev@example.test");
  });

  it("normalizes base paths", () => {
    expect(normalizeBasePath("")).toBe("");
    expect(normalizeBasePath("/")).toBe("");
    expect(normalizeBasePath("agent")).toBe("/agent");
    expect(normalizeBasePath("/agent/")).toBe("/agent");
  });
});
