import { defineStore } from "pinia";
import { api, type AuthUser } from "../lib/api";
import { authLoginUrl } from "../lib/basePath";

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
let restoreInFlight: Promise<void> | null = null;

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

function messageFromError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message : fallback;
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
    applyAuth(response: { authenticated: boolean; user?: AuthUser | null }): void {
      const user = response.user ?? null;
      this.authenticated = response.authenticated && user !== null;
      this.user = this.authenticated ? user : null;
      this.loaded = true;
      this.error = null;
      if (this.authenticated) {
        clearOAuthStateAutoRetry();
      }
    },
    async restore(): Promise<void> {
      if (restoreInFlight !== null) {
        return restoreInFlight;
      }

      restoreInFlight = this.restoreOnce().finally(() => {
        restoreInFlight = null;
      });
      return restoreInFlight;
    },
    async restoreOnce(): Promise<void> {
      this.loading = true;
      const oauthError = consumeOAuthError();
      let redirectStarted = false;
      try {
        this.applyAuth(await api.me());
        if (oauthError?.code === "oauth_state" && usesOAuthMode() && !this.authenticated && claimOAuthStateAutoRetry()) {
          redirectStarted = true;
          window.location.assign(authLoginUrl());
          return;
        }
        if (oauthError && !this.authenticated) {
          this.error = oauthError.message;
        }
      } catch (error) {
        this.applyAuth({ authenticated: false, user: null });
        if (oauthError?.code === "oauth_state" && usesOAuthMode() && claimOAuthStateAutoRetry()) {
          redirectStarted = true;
          window.location.assign(authLoginUrl());
          return;
        }
        this.error = oauthError?.message ?? messageFromError(error, "Unable to restore the current session.");
      } finally {
        if (!redirectStarted) {
          this.loading = false;
        }
      }
    },
    async signIn(): Promise<void> {
      if (usesOAuthMode()) {
        this.loading = true;
        window.location.assign(authLoginUrl());
        return;
      }

      this.loading = true;
      try {
        this.applyAuth(await api.devLogin());
      } catch (error) {
        this.error = messageFromError(error, "Unable to sign in.");
      } finally {
        this.loading = false;
      }
    },
    async signOut(): Promise<void> {
      this.loading = true;
      try {
        this.applyAuth(await api.logout());
        if (usesOAuthMode()) {
          this.error = "You have been signed out.";
        }
      } catch (error) {
        this.error = messageFromError(error, "Unable to sign out.");
      } finally {
        this.loading = false;
      }
    }
  }
});
