import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  apiUrl,
  authLoginUrl,
  currentAppPath,
  normalizeAppNextPath,
  normalizeBasePath,
  normalizedApiBaseUrl
} from "../src/lib/basePath";

describe("base path helpers", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    window.history.replaceState({}, "", "/");
  });

  it("normalizes empty and root paths", () => {
    expect(normalizeBasePath("")).toBe("");
    expect(normalizeBasePath("/")).toBe("");
    expect(normalizeBasePath(undefined)).toBe("");
  });

  it("normalizes non-root paths", () => {
    expect(normalizeBasePath("agent")).toBe("/agent");
    expect(normalizeBasePath("/agent/")).toBe("/agent");
  });

  it("builds the default API base under the app base path", () => {
    vi.stubEnv("VITE_APP_BASE_PATH", "/agent");
    vi.stubEnv("VITE_API_BASE_URL", "");

    expect(normalizedApiBaseUrl()).toBe("/agent/api/v1");
    expect(apiUrl("/auth/me")).toBe("/agent/api/v1/auth/me");
  });

  it("respects explicit API base URLs", () => {
    vi.stubEnv("VITE_APP_BASE_PATH", "/agent");
    vi.stubEnv("VITE_API_BASE_URL", "/custom/api/");

    expect(normalizedApiBaseUrl()).toBe("/custom/api");
    expect(apiUrl("auth/me")).toBe("/custom/api/auth/me");
  });

  it("preserves absolute API base URLs", () => {
    vi.stubEnv("VITE_API_BASE_URL", "https://api.example.test/api/v1/");

    expect(apiUrl("/auth/me")).toBe("https://api.example.test/api/v1/auth/me");
  });

  it("returns an app-local next path from the current browser URL", () => {
    vi.stubEnv("VITE_APP_BASE_PATH", "/agent");
    window.history.replaceState({}, "", "/agent/?tab=outbox#message-1");

    expect(currentAppPath()).toBe("/?tab=outbox#message-1");
  });

  it("rejects unsafe OAuth next paths", () => {
    vi.stubEnv("VITE_APP_BASE_PATH", "/agent");

    expect(normalizeAppNextPath("https://example.test/app")).toBe("/");
    expect(normalizeAppNextPath("//example.test/app")).toBe("/");
    expect(normalizeAppNextPath("/agent?tab=tasks")).toBe("/?tab=tasks");
  });

  it("adds a safe next path to OAuth login URLs", () => {
    vi.stubEnv("VITE_APP_BASE_PATH", "/agent");
    vi.stubEnv("VITE_API_BASE_URL", "");
    window.history.replaceState({}, "", "/agent/?tab=memory");

    expect(authLoginUrl()).toBe("/agent/api/v1/auth/login?next=%2F%3Ftab%3Dmemory");
    expect(apiUrl("/auth/login?next=%2Ftasks")).toBe("/agent/api/v1/auth/login?next=%2Ftasks");
  });
});
