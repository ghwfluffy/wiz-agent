import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "../src/stores/auth";

describe("auth store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.unstubAllGlobals();
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
        },
        tenant: {
          id: "dev-tenant",
          name: "Development Tenant"
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
    expect(auth.tenant?.id).toBe("dev-tenant");
  });

  it("shows a friendly OAuth error and removes it from the URL", async () => {
    window.history.replaceState({}, "", "/agent/?oauth_error=oauth_state");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        authenticated: false,
        user: null,
        tenant: null
      })
    });
    vi.stubGlobal("fetch", fetchMock);

    const auth = useAuthStore();
    await auth.restore();

    expect(auth.error).toBe("Central sign-in expired. Please start again.");
    expect(window.location.search).toBe("");
  });
});
