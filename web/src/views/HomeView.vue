<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { api, type AuditEvent, type OutboxMessage, type Task } from "../lib/api";
import { apiUrl } from "../lib/basePath";
import { useAuthStore } from "../stores/auth";

const auth = useAuthStore();
const authMode = import.meta.env.VITE_AUTH_MODE || "standalone";
const signInLabel = computed(() => (authMode === "standalone" ? "Sign in" : "Continue with central sign-in"));
const tasks = ref<Task[]>([]);
const outbox = ref<OutboxMessage[]>([]);
const audit = ref<AuditEvent[]>([]);
const dashboardError = ref<string | null>(null);

async function loadDashboard(): Promise<void> {
  if (!auth.authenticated) {
    return;
  }
  try {
    const data = await api.dashboard();
    tasks.value = data.tasks;
    outbox.value = data.outbox;
    audit.value = data.audit;
    dashboardError.value = null;
  } catch {
    dashboardError.value = "Unable to load agent activity.";
  }
}

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

watch(() => auth.authenticated, (authenticated) => {
  if (authenticated) {
    void loadDashboard();
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
      <header class="dashboard-header">
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
      </header>

      <div v-if="dashboardError" class="status status-error" role="alert">
        {{ dashboardError }}
      </div>

      <div class="metric-grid" aria-label="Operational summary">
        <section>
          <p class="label">Tasks</p>
          <p class="value">{{ tasks.length }}</p>
        </section>
        <section>
          <p class="label">Outbox</p>
          <p class="value">{{ outbox.length }}</p>
        </section>
        <section>
          <p class="label">Audit events</p>
          <p class="value">{{ audit.length }}</p>
        </section>
      </div>

      <section class="activity-section" aria-label="Scheduled tasks">
        <h2>Scheduled tasks</h2>
        <p v-if="tasks.length === 0" class="empty">No tasks scheduled.</p>
        <ul v-else>
          <li v-for="task in tasks" :key="task.id">
            <span>{{ task.title }}</span>
            <span>{{ task.status }}</span>
          </li>
        </ul>
      </section>

      <section class="activity-section" aria-label="Outbound queue">
        <h2>Outbound queue</h2>
        <p v-if="outbox.length === 0" class="empty">No queued messages.</p>
        <ul v-else>
          <li v-for="message in outbox" :key="message.id">
            <span>{{ message.channel }} to {{ message.toAddr }}</span>
            <span>{{ message.status }}</span>
          </li>
        </ul>
      </section>
    </section>
  </section>
</template>
