import { describe, expect, it } from "vitest";
import { loadSettings } from "../src/config/settings.js";
import { buildApp } from "../src/http/app.js";

describe("status route", () => {
  it("returns safe application and configuration status", async () => {
    const app = buildApp({
      settings: loadSettings({
        APP_ENV: "test",
        APP_VERSION: "9.9.9",
        AUTH_MODE: "standalone",
        APP_BASE_PATH: "/private-agent-path/",
        GOALS_API_BASE_URL: "https://goals.internal.example/api"
      })
    });

    const response = await app.request("/api/v1/status");

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({
      status: "degraded",
      app: "ai-assistant",
      version: "9.9.9",
      configuration: {
        environment: "test",
        authMode: "standalone",
        deployment: {
          appBasePathConfigured: true
        },
        integrations: expect.arrayContaining([
          expect.objectContaining({
            name: "goals",
            status: "misconfigured_missing_token_secret"
          }),
          expect.objectContaining({
            name: "budget",
            status: "missing_optional"
          })
        ])
      }
    });
    expect(JSON.stringify(payload)).not.toContain("/private-agent-path");
    expect(JSON.stringify(payload)).not.toContain("goals.internal.example");
  });

  it("keeps healthz minimal for liveness probes", async () => {
    const app = buildApp({
      settings: loadSettings({
        APP_ENV: "test",
        AUTH_MODE: "standalone"
      })
    });

    const response = await app.request("/healthz");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });
});
