import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { loadSettings } from "../src/config/settings.js";
import {
  BACKGROUND_POSTGRES_POOL_OPTIONS,
  checkDatabaseReadiness,
  DATABASE_READINESS_TIMEOUT_MS
} from "../src/db/pool.js";
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
          }),
          expect.objectContaining({
            name: "notes",
            status: "missing_optional"
          }),
          expect.objectContaining({
            name: "omni_dev",
            status: "missing_optional"
          })
        ])
      }
    });
    expect(JSON.stringify(payload)).not.toContain("/private-agent-path");
    expect(JSON.stringify(payload)).not.toContain("goals.internal.example");
  });

  it("keeps healthz minimal for liveness probes", async () => {
    const readinessCheck = vi.fn(async () => {
      throw new Error("database unavailable");
    });
    const app = buildApp({
      settings: loadSettings({
        APP_ENV: "test",
        AUTH_MODE: "standalone"
      }),
      readinessCheck
    });

    const response = await app.request("/healthz");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
    expect(readinessCheck).not.toHaveBeenCalled();
  });

  it("reports bounded database readiness through an injectable check", async () => {
    const readinessCheck = vi.fn(async () => undefined);
    const app = buildApp({
      settings: loadSettings({ APP_ENV: "test", AUTH_MODE: "standalone" }),
      readinessCheck
    });

    const response = await app.request("/readyz");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ready" });
    expect(readinessCheck).toHaveBeenCalledTimes(1);
  });

  it("fails readiness closed without exposing database errors", async () => {
    const app = buildApp({
      settings: loadSettings({ APP_ENV: "test", AUTH_MODE: "standalone" }),
      readinessCheck: async () => {
        throw new Error("password=secret host=private-db.example.test");
      }
    });

    const response = await app.request("/readyz");
    const text = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(text)).toEqual({ status: "not_ready" });
    expect(text).not.toContain("secret");
    expect(text).not.toContain("private-db");
  });

  it("returns not ready when an injected readiness check exceeds its deadline", async () => {
    const app = buildApp({
      settings: loadSettings({ APP_ENV: "test", AUTH_MODE: "standalone" }),
      readinessCheck: () => new Promise<void>(() => undefined),
      readinessTimeoutMs: 10
    });

    const response = await app.request("/readyz");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ status: "not_ready" });
  });

  it("uses a read-only query with a driver-enforced readiness timeout", async () => {
    const query = vi.fn(async () => ({ rows: [{ ready: 1 }] }));

    await checkDatabaseReadiness({ query } as unknown as Pick<Pool, "query">);

    expect(query).toHaveBeenCalledWith({
      text: "SELECT 1 AS ready",
      query_timeout: DATABASE_READINESS_TIMEOUT_MS
    });
  });

  it("bounds background-worker Postgres connection and statement work", () => {
    expect(BACKGROUND_POSTGRES_POOL_OPTIONS).toEqual({
      connectionTimeoutMillis: 5_000,
      query_timeout: 20_000,
      statement_timeout: 20_000
    });
  });
});
