import { describe, expect, it } from "vitest";
import { loadSettings } from "../src/config/settings.js";
import { buildApp } from "../src/http/app.js";

describe("standalone auth", () => {
  it("starts anonymous and signs in through the development endpoint", async () => {
    const app = buildApp({
      settings: loadSettings({
        APP_ENV: "test",
        AUTH_MODE: "standalone",
        DEV_USER_EMAIL: "person@example.test",
        DEV_USER_DISPLAY_NAME: "Local Tester"
      })
    });

    const anonymous = await app.request("/api/v1/auth/me");
    await expect(anonymous.json()).resolves.toEqual({
      authenticated: false,
      user: null,
      tenant: null
    });

    const login = await app.request("/api/v1/auth/dev-login", { method: "POST" });
    expect(login.status).toBe(200);
    await expect(login.clone().json()).resolves.toMatchObject({
      authenticated: true,
      user: {
        email: "person@example.test",
        displayName: "Local Tester",
        isAdmin: true
      },
      tenant: {
        id: "dev-tenant"
      }
    });

    const cookie = login.headers.get("set-cookie");
    expect(cookie).toBeTruthy();
    const authenticated = await app.request("/api/v1/auth/me", {
      method: "GET",
      headers: {
        cookie: cookie ?? ""
      }
    });

    await expect(authenticated.json()).resolves.toMatchObject({
      authenticated: true,
      user: {
        email: "person@example.test"
      }
    });
  });

  it("disables the development endpoint outside standalone mode", async () => {
    const app = buildApp({
      settings: loadSettings({
        APP_ENV: "test",
        AUTH_MODE: "oauth"
      })
    });

    const response = await app.request("/api/v1/auth/dev-login", { method: "POST" });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "not_found",
        message: "Development sign-in is not available."
      }
    });
  });
});
