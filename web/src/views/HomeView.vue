<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import {
  api,
  type AiConfig,
  type AuditEvent,
  type JobStatus,
  type OutboxMessage,
  type Sender,
  type Task
} from "../lib/api";
import { apiUrl } from "../lib/basePath";
import { useAuthStore } from "../stores/auth";

const auth = useAuthStore();
const authMode = import.meta.env.VITE_AUTH_MODE || "standalone";
const signInLabel = computed(() => (authMode === "standalone" ? "Sign in" : "Continue with central sign-in"));
const tasks = ref<Task[]>([]);
const outbox = ref<OutboxMessage[]>([]);
const audit = ref<AuditEvent[]>([]);
const senders = ref<Sender[]>([]);
const aiConfig = ref<AiConfig | null>(null);
const jobs = ref<JobStatus[]>([]);
const dashboardError = ref<string | null>(null);
const saving = ref(false);
const taskForm = reactive({
  title: "",
  prompt: "",
  dueAt: "",
  priority: 0
});
const senderForm = reactive({
  address: "",
  status: "trusted" as Sender["status"]
});
const configForm = reactive<AiConfig>({
  fastModel: "",
  smartModel: "",
  orchestratorModel: "",
  repairModel: "",
  maxToolCalls: 10,
  maxRuntimeSec: 120,
  repairAttemptLimit: 1
});

const pendingOutbox = computed(() => outbox.value.filter((message) => ["requires_approval", "pending", "approved", "failed"].includes(message.status)));
const recentAudit = computed(() => audit.value.slice(0, 12));

function applyAiConfig(config: AiConfig | null): void {
  aiConfig.value = config;
  if (!config) {
    return;
  }
  Object.assign(configForm, config);
}

async function loadDashboard(): Promise<void> {
  if (!auth.authenticated) {
    return;
  }
  try {
    const data = await api.dashboard();
    tasks.value = data.tasks;
    outbox.value = data.outbox;
    audit.value = data.audit;
    senders.value = data.senders;
    jobs.value = data.jobs;
    applyAiConfig(data.aiConfig);
    dashboardError.value = null;
  } catch {
    dashboardError.value = "Unable to load agent activity.";
  }
}

async function createTask(): Promise<void> {
  saving.value = true;
  try {
    await api.createTask({
      title: taskForm.title,
      prompt: taskForm.prompt,
      dueAt: taskForm.dueAt || null,
      priority: Number(taskForm.priority) || 0
    });
    taskForm.title = "";
    taskForm.prompt = "";
    taskForm.dueAt = "";
    taskForm.priority = 0;
    await loadDashboard();
  } catch {
    dashboardError.value = "Unable to save the task.";
  } finally {
    saving.value = false;
  }
}

async function updateTaskStatus(task: Task, status: string): Promise<void> {
  try {
    await api.updateTask(task.id, { status });
    await loadDashboard();
  } catch {
    dashboardError.value = "Unable to update the task.";
  }
}

function updateTaskFromEvent(task: Task, event: Event): void {
  const target = event.target as HTMLSelectElement;
  void updateTaskStatus(task, target.value);
}

async function updateOutboxStatus(message: OutboxMessage, status: "approved" | "cancelled"): Promise<void> {
  try {
    await api.updateOutbox(message.id, status);
    await loadDashboard();
  } catch {
    dashboardError.value = "Unable to update the outbound message.";
  }
}

async function saveSender(): Promise<void> {
  saving.value = true;
  try {
    const response = await api.setSender(senderForm.address, senderForm.status);
    senders.value = response.senders;
    senderForm.address = "";
  } catch {
    dashboardError.value = "Unable to save the sender.";
  } finally {
    saving.value = false;
  }
}

async function saveAiConfig(): Promise<void> {
  saving.value = true;
  try {
    applyAiConfig(await api.updateAiConfig({
      fastModel: configForm.fastModel,
      smartModel: configForm.smartModel,
      orchestratorModel: configForm.orchestratorModel,
      repairModel: configForm.repairModel,
      maxToolCalls: Number(configForm.maxToolCalls),
      maxRuntimeSec: Number(configForm.maxRuntimeSec),
      repairAttemptLimit: Number(configForm.repairAttemptLimit)
    }));
  } catch {
    dashboardError.value = "Unable to save AI configuration.";
  } finally {
    saving.value = false;
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
      <h1>Tasks, messages, and agent operations</h1>
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
        <div class="header-actions">
          <button class="cds--btn cds--btn--secondary" type="button" :disabled="saving" @click="loadDashboard">
            Refresh
          </button>
          <button class="cds--btn cds--btn--secondary" type="button" :disabled="auth.loading" @click="auth.signOut">
            Sign out
          </button>
        </div>
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
          <p class="label">Senders</p>
          <p class="value">{{ senders.length }}</p>
        </section>
        <section>
          <p class="label">Audit events</p>
          <p class="value">{{ audit.length }}</p>
        </section>
      </div>

      <section class="activity-section" aria-label="Scheduled tasks">
        <div class="section-heading">
          <h2>Scheduled tasks</h2>
        </div>
        <form class="inline-form" @submit.prevent="createTask">
          <label>
            <span>Title</span>
            <input v-model="taskForm.title" required type="text">
          </label>
          <label>
            <span>Prompt</span>
            <textarea v-model="taskForm.prompt" required rows="3" />
          </label>
          <label>
            <span>Due</span>
            <input v-model="taskForm.dueAt" type="datetime-local">
          </label>
          <label>
            <span>Priority</span>
            <input v-model.number="taskForm.priority" type="number" min="0" step="1">
          </label>
          <button class="cds--btn cds--btn--primary" type="submit" :disabled="saving">
            Add task
          </button>
        </form>
        <p v-if="tasks.length === 0" class="empty">No tasks scheduled.</p>
        <ul v-else>
          <li v-for="task in tasks" :key="task.id">
            <div>
              <strong>{{ task.title }}</strong>
              <p>{{ task.prompt }}</p>
              <small>{{ task.dueAt || "No due date" }}</small>
            </div>
            <select :value="task.status" @change="updateTaskFromEvent(task, $event)">
              <option value="pending">pending</option>
              <option value="running">running</option>
              <option value="completed">completed</option>
              <option value="cancelled">cancelled</option>
              <option value="failed">failed</option>
            </select>
          </li>
        </ul>
      </section>

      <section class="activity-section" aria-label="Outbound queue">
        <h2>Outbound queue</h2>
        <p v-if="pendingOutbox.length === 0" class="empty">No queued messages.</p>
        <ul v-else>
          <li v-for="message in pendingOutbox" :key="message.id">
            <div>
              <strong>{{ message.channel }} to {{ message.toAddr }}</strong>
              <p>{{ message.bodyText }}</p>
              <small v-if="message.failureMessage">Failure: {{ message.failureMessage }}</small>
              <small v-else>{{ message.status }}</small>
            </div>
            <div class="row-actions">
              <button class="cds--btn cds--btn--primary" type="button" :disabled="message.status === 'sent'" @click="updateOutboxStatus(message, 'approved')">
                Approve
              </button>
              <button class="cds--btn cds--btn--secondary" type="button" @click="updateOutboxStatus(message, 'cancelled')">
                Cancel
              </button>
            </div>
          </li>
        </ul>
      </section>

      <section class="activity-section" aria-label="Sender trust">
        <h2>Sender trust</h2>
        <form class="inline-form compact" @submit.prevent="saveSender">
          <label>
            <span>Address</span>
            <input v-model="senderForm.address" required type="email">
          </label>
          <label>
            <span>Status</span>
            <select v-model="senderForm.status">
              <option value="owner">owner</option>
              <option value="newsletter">newsletter</option>
              <option value="trusted">trusted</option>
              <option value="blocked">blocked</option>
              <option value="untrusted">untrusted</option>
            </select>
          </label>
          <button class="cds--btn cds--btn--primary" type="submit" :disabled="saving">
            Save sender
          </button>
        </form>
        <p v-if="senders.length === 0" class="empty">No senders configured.</p>
        <ul v-else>
          <li v-for="sender in senders" :key="sender.id">
            <span>{{ sender.address }}</span>
            <strong>{{ sender.status }}</strong>
          </li>
        </ul>
      </section>

      <section class="activity-section" aria-label="Worker jobs">
        <h2>Worker jobs</h2>
        <p v-if="jobs.length === 0" class="empty">No worker status available.</p>
        <ul v-else>
          <li v-for="job in jobs" :key="job.name">
            <div>
              <strong>{{ job.name }}</strong>
              <p>{{ job.status }}</p>
            </div>
            <span>
              {{ job.pendingTasks ?? job.pendingMessages ?? 0 }} pending
            </span>
          </li>
        </ul>
      </section>

      <section v-if="aiConfig" class="activity-section" aria-label="AI configuration">
        <h2>AI configuration</h2>
        <form class="inline-form config-form" @submit.prevent="saveAiConfig">
          <label>
            <span>Fast model</span>
            <input v-model="configForm.fastModel" required type="text">
          </label>
          <label>
            <span>Smart model</span>
            <input v-model="configForm.smartModel" required type="text">
          </label>
          <label>
            <span>Orchestrator model</span>
            <input v-model="configForm.orchestratorModel" required type="text">
          </label>
          <label>
            <span>Repair model</span>
            <input v-model="configForm.repairModel" required type="text">
          </label>
          <label>
            <span>Max tool calls</span>
            <input v-model.number="configForm.maxToolCalls" required type="number" min="1">
          </label>
          <label>
            <span>Max runtime sec</span>
            <input v-model.number="configForm.maxRuntimeSec" required type="number" min="1">
          </label>
          <label>
            <span>Repair attempts</span>
            <input v-model.number="configForm.repairAttemptLimit" required type="number" min="0">
          </label>
          <button class="cds--btn cds--btn--primary" type="submit" :disabled="saving">
            Save config
          </button>
        </form>
      </section>

      <section class="activity-section" aria-label="Audit history">
        <h2>Audit history</h2>
        <p v-if="recentAudit.length === 0" class="empty">No audit events.</p>
        <ul v-else>
          <li v-for="event in recentAudit" :key="event.id">
            <span>{{ event.action }}</span>
            <small>{{ event.createdAt }}</small>
          </li>
        </ul>
      </section>
    </section>
  </section>
</template>
