import { describe, expect, it, vi } from "vitest";
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

  it("redirects OAuth mode login to the configured authorization endpoint", async () => {
    const app = buildApp({
      settings: loadSettings({
        APP_ENV: "test",
        AUTH_MODE: "oauth",
        AUTH_BASE_URL: "/central-auth",
        APP_BASE_PATH: "/agent",
        PUBLIC_URL: "https://agent.example.test"
      })
    });

    const response = await app.request("/api/v1/auth/login");

    expect(response.status).toBe(302);
    const location = response.headers.get("location") ?? "";
    expect(location).toContain("/central-auth/oauth/authorize?");
    expect(location).toContain("client_id=agent");
    expect(location).toContain("redirect_uri=https%3A%2F%2Fagent.example.test%2Fagent%2Fapi%2Fv1%2Fauth%2Foauth%2Fcallback");
    expect(location).toContain("code_challenge_method=S256");
  });

  it("redirects failed OAuth callbacks back to the app UI", async () => {
    const app = buildApp({
      settings: loadSettings({
        APP_ENV: "test",
        AUTH_MODE: "oauth",
        APP_BASE_PATH: "/agent"
      })
    });

    const response = await app.request("/api/v1/auth/oauth/callback?code=bad&state=bad");

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/agent/?oauth_error=oauth_state");
  });

  it("exchanges OAuth callbacks for local sessions", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: "access-token" })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sub: "central-user-1",
          preferred_username: "ghw",
          name: "GHW",
          is_admin: true
        })
      });
    const app = buildApp({
      settings: loadSettings({
        APP_ENV: "test",
        AUTH_MODE: "oauth",
        AUTH_BASE_URL: "/central-auth",
        OAUTH_SERVER_BASE_URL: "http://central-api.test",
        APP_BASE_PATH: "/agent",
        PUBLIC_URL: "https://agent.example.test"
      }),
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    const login = await app.request("/api/v1/auth/login?next=/tasks");
    const authorize = new URL(`https://agent.example.test${login.headers.get("location") ?? ""}`);
    const state = authorize.searchParams.get("state");
    expect(state).toBeTruthy();

    const callback = await app.request(`/api/v1/auth/oauth/callback?code=code-1&state=${state}`);
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/agent/tasks");
    const cookie = callback.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("agent_session=");

    const me = await app.request("/api/v1/auth/me", {
      headers: { cookie }
    });
    await expect(me.json()).resolves.toMatchObject({
      authenticated: true,
      user: {
        displayName: "GHW",
        isAdmin: true
      }
    });
  });
});
