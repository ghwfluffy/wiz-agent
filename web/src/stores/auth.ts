import { defineStore } from "pinia";
import { api, type AuthUser, type Tenant } from "../lib/api";

type AuthState = {
  loaded: boolean;
  loading: boolean;
  authenticated: boolean;
  user: AuthUser | null;
  tenant: Tenant | null;
  error: string | null;
};

export const useAuthStore = defineStore("auth", {
  state: (): AuthState => ({
    loaded: false,
    loading: false,
    authenticated: false,
    user: null,
    tenant: null,
    error: null
  }),
  actions: {
    applyAuth(response: { authenticated: boolean; user: AuthUser | null; tenant: Tenant | null }): void {
      this.authenticated = response.authenticated;
      this.user = response.user;
      this.tenant = response.tenant;
      this.loaded = true;
      this.error = null;
    },
    async restore(): Promise<void> {
      this.loading = true;
      try {
        this.applyAuth(await api.me());
      } catch {
        this.loaded = true;
        this.error = "Unable to restore the current session.";
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
