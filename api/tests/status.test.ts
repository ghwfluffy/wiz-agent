import { describe, expect, it } from "vitest";
import { loadSettings } from "../src/config/settings.js";
import { buildApp } from "../src/http/app.js";

describe("status route", () => {
  it("returns application status", async () => {
    const app = buildApp({
      settings: loadSettings({
        APP_ENV: "test",
        APP_VERSION: "9.9.9",
        AUTH_MODE: "standalone",
        APP_BASE_PATH: "/agent/"
      })
    });

    const response = await app.request("/api/v1/status");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      app: "ai-assistant",
      version: "9.9.9",
      auth_mode: "standalone",
      base_path: "/agent"
    });
  });
});
