import { defineStore } from "pinia";
import { api, type AuthUser } from "../lib/api";
import { apiUrl } from "../lib/basePath";

type AuthState = {
  loaded: boolean;
  loading: boolean;
  authenticated: boolean;
  user: AuthUser | null;
  error: string | null;
};

const oauthErrorMessages: Record<string, string> = {
  oauth_callback: "Central sign-in could not be completed. Please try again.",
  oauth_failed: "Central sign-in could not be completed. Please try again.",
  oauth_not_enabled: "Central sign-in is not enabled for this deployment.",
  oauth_state: "Central sign-in expired. Please start again."
};

type OAuthError = {
  code: string;
  message: string;
};

const oauthAutoRetryKey = "agent.oauth_state_auto_retry";

function usesOAuthMode(): boolean {
  return import.meta.env.VITE_AUTH_MODE === "oauth";
}

function consumeOAuthError(): OAuthError | null {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("oauth_error");
  if (!code) {
    return null;
  }
  url.searchParams.delete("oauth_error");
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  return {
    code,
    message: oauthErrorMessages[code] ?? "Central sign-in could not be completed. Please try again."
  };
}

function claimOAuthStateAutoRetry(): boolean {
  try {
    if (window.sessionStorage.getItem(oauthAutoRetryKey) === "1") {
      return false;
    }
    window.sessionStorage.setItem(oauthAutoRetryKey, "1");
    return true;
  } catch {
    return false;
  }
}

function clearOAuthStateAutoRetry(): void {
  try {
    window.sessionStorage.removeItem(oauthAutoRetryKey);
  } catch {
    // Ignore unavailable session storage.
  }
}

export const useAuthStore = defineStore("auth", {
  state: (): AuthState => ({
    loaded: false,
    loading: false,
    authenticated: false,
    user: null,
    error: null
    }),
  actions: {
    applyAuth(response: { authenticated: boolean; user: AuthUser | null }): void {
      this.authenticated = response.authenticated;
      this.user = response.user;
      this.loaded = true;
      this.error = null;
      if (response.authenticated) {
        clearOAuthStateAutoRetry();
      }
    },
    async restore(): Promise<void> {
      this.loading = true;
      const oauthError = consumeOAuthError();
      try {
        this.applyAuth(await api.me());
        if (oauthError?.code === "oauth_state" && usesOAuthMode() && !this.authenticated && claimOAuthStateAutoRetry()) {
          window.location.assign(apiUrl("/auth/login"));
          return;
        }
        if (oauthError && !this.authenticated) {
          this.error = oauthError.message;
        }
      } catch {
        this.loaded = true;
        if (oauthError?.code === "oauth_state" && usesOAuthMode() && claimOAuthStateAutoRetry()) {
          window.location.assign(apiUrl("/auth/login"));
          return;
        }
        this.error = oauthError?.message ?? "Unable to restore the current session.";
      } finally {
        this.loading = false;
      }
    },
    async signIn(): Promise<void> {
      this.loading = true;
      try {
        this.applyAuth(await api.devLogin());
      } catch {
        this.error = "Unable to sign in.";
      } finally {
        this.loading = false;
      }
    },
    async signOut(): Promise<void> {
      this.loading = true;
      try {
        this.applyAuth(await api.logout());
      } finally {
        this.loading = false;
      }
    }
  }
});
