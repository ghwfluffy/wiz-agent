<script setup lang="ts">
import { computed, onMounted } from "vue";
import { apiUrl } from "../lib/basePath";
import { useAuthStore } from "../stores/auth";

const auth = useAuthStore();
const authMode = import.meta.env.VITE_AUTH_MODE || "standalone";
const signInLabel = computed(() => (authMode === "standalone" ? "Sign in" : "Continue with central sign-in"));

function signIn(): void {
  if (authMode === "standalone") {
    void auth.signIn();
    return;
  }
  window.location.assign(apiUrl("/auth/login"));
}

onMounted(() => {
  if (!auth.loaded) {
    void auth.restore();
  }
});
</script>

<template>
  <section class="home-view">
    <header class="home-header">
      <p class="eyebrow">AI Assistant</p>
      <h1>Tasks, messages, and agent activity</h1>
    </header>

    <div v-if="auth.error" class="status status-error" role="alert">
      {{ auth.error }}
    </div>

    <section v-if="!auth.authenticated" class="auth-panel" aria-label="Sign in">
      <p>Use the local development account to start testing the assistant.</p>
      <button class="cds--btn cds--btn--primary" type="button" :disabled="auth.loading" @click="signIn">
        {{ signInLabel }}
      </button>
    </section>

    <section v-else class="dashboard" aria-label="Agent dashboard">
      <div>
        <p class="label">Signed in as</p>
        <p class="value">{{ auth.user?.displayName }}</p>
      </div>
      <div>
        <p class="label">Tenant</p>
        <p class="value">{{ auth.tenant?.name }}</p>
      </div>
      <button class="cds--btn cds--btn--secondary" type="button" :disabled="auth.loading" @click="auth.signOut">
        Sign out
      </button>
    </section>
  </section>
</template>
