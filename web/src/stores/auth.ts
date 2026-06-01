import { defineStore } from "pinia";
import { api, type AuthUser } from "../lib/api";

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

function consumeOAuthError(): string | null {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("oauth_error");
  if (!code) {
    return null;
  }
  url.searchParams.delete("oauth_error");
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  return oauthErrorMessages[code] ?? "Central sign-in could not be completed. Please try again.";
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
    },
    async restore(): Promise<void> {
      this.loading = true;
      const oauthError = consumeOAuthError();
      try {
        this.applyAuth(await api.me());
        if (oauthError && !this.authenticated) {
          this.error = oauthError;
        }
      } catch {
        this.loaded = true;
        this.error = oauthError ?? "Unable to restore the current session.";
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
