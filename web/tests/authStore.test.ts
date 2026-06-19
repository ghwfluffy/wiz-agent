import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "../src/stores/auth";

describe("auth store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    window.sessionStorage.clear();
    window.history.replaceState({}, "", "/");
  });

  it("signs in through the standalone development endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        authenticated: true,
        user: {
          id: "dev-user",
          email: "dev@example.test",
          displayName: "Development User",
          isAdmin: true
        }
      })
    });
    vi.stubGlobal("fetch", fetchMock);

    const auth = useAuthStore();
    await auth.signIn();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/auth/dev-login",
      expect.objectContaining({
        method: "POST",
        credentials: "include"
      })
    );
    expect(auth.authenticated).toBe(true);
    expect(auth.user?.email).toBe("dev@example.test");
  });

  it("shows a friendly OAuth error and removes it from the URL", async () => {
    window.history.replaceState({}, "", "/agent/?oauth_error=oauth_state");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        authenticated: false,
        user: null
      })
    });
    vi.stubGlobal("fetch", fetchMock);

    const auth = useAuthStore();
    await auth.restore();

    expect(auth.error).toBe("Central sign-in expired. Please start again.");
    expect(window.location.search).toBe("");
  });

  it("uses API error envelope messages for standalone sign-in failures", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({
        error: {
          code: "not_found",
          message: "Development sign-in is not available."
        }
      })
    });
    vi.stubGlobal("fetch", fetchMock);

    const auth = useAuthStore();
    await auth.signIn();

    expect(auth.authenticated).toBe(false);
    expect(auth.error).toBe("Development sign-in is not available.");
  });

  it("clears auth state when logout omits a user payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        authenticated: false
      })
    });
    vi.stubGlobal("fetch", fetchMock);

    const auth = useAuthStore();
    auth.applyAuth({
      authenticated: true,
      user: {
        id: "dev-user",
        email: "dev@example.test",
        displayName: "Development User",
        isAdmin: true
      }
    });

    await auth.signOut();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/auth/logout",
      expect.objectContaining({
        method: "POST",
        credentials: "include"
      })
    );
    expect(auth.authenticated).toBe(false);
    expect(auth.user).toBeNull();
  });

  it("clears stale auth state when session restore fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({
        error: {
          code: "service_unavailable",
          message: "Session storage is unavailable."
        }
      })
    });
    vi.stubGlobal("fetch", fetchMock);

    const auth = useAuthStore();
    auth.applyAuth({
      authenticated: true,
      user: {
        id: "dev-user",
        email: "dev@example.test",
        displayName: "Development User",
        isAdmin: true
      }
    });

    await auth.restore();

    expect(auth.loaded).toBe(true);
    expect(auth.authenticated).toBe(false);
    expect(auth.user).toBeNull();
    expect(auth.error).toBe("Session storage is unavailable.");
  });

  it("deduplicates concurrent session restore calls", async () => {
    const fetchMock = vi.fn(async () => {
      await Promise.resolve();
      return {
        ok: true,
        json: async () => ({
          authenticated: false,
          user: null
        })
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const auth = useAuthStore();
    await Promise.all([auth.restore(), auth.restore()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(auth.loaded).toBe(true);
    expect(auth.authenticated).toBe(false);
  });
});
