<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  api,
  type AiConfig,
  type AuditEvent,
  type Connector,
  type ConnectorKind,
  type ConnectorStatus,
  type InboundMessage,
  type JobStatus,
  type OutboxMessage,
  type Sender,
  type Task,
  type TaskEvent
} from "../lib/api";
import { apiUrl } from "../lib/basePath";
import { useAuthStore } from "../stores/auth";

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
const authMode = import.meta.env.VITE_AUTH_MODE || "standalone";
const signInLabel = computed(() => (authMode === "standalone" ? "Sign in" : "Continue with central sign-in"));
const tabs = [
  { id: "overview", label: "Overview" },
  { id: "inbox", label: "Inbox" },
  { id: "outbox", label: "Outbox" },
  { id: "tasks", label: "Tasks" },
  { id: "senders", label: "Senders" },
  { id: "workers", label: "Workers" },
  { id: "logs", label: "Logs" },
  { id: "settings", label: "Settings" },
  { id: "admin", label: "Admin" }
] as const;
type TabId = typeof tabs[number]["id"];
const tabIds = new Set<TabId>(tabs.map((tab) => tab.id));
const dashboardPollIntervalMs = 10_000;
let dashboardPollHandle: number | null = null;
let activeTabRefreshInFlight = false;
const activeTab = ref<TabId>(tabFromRoute(route.query.tab));

const tasks = ref<Task[]>([]);
const inbox = ref<InboundMessage[]>([]);
const outbox = ref<OutboxMessage[]>([]);
const audit = ref<AuditEvent[]>([]);
const senders = ref<Sender[]>([]);
const connectors = ref<Connector[]>([]);
const aiConfig = ref<AiConfig | null>(null);
const jobs = ref<JobStatus[]>([]);
const dashboardError = ref<string | null>(null);
const saving = ref(false);
const taskPage = ref(1);
const inboxPage = ref(1);
const outboxPage = ref(1);
const tasksPerPage = 10;
const inboxPerPage = 10;
const outboxPerPage = 10;
const selectedTask = ref<Task | null>(null);
const selectedTaskEvents = ref<TaskEvent[]>([]);
const taskStatusDraft = ref("");
const taskFollowUpPrompt = ref("");
const taskModalError = ref<string | null>(null);

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
const ownerContactForm = reactive({
  status: "enabled" as ConnectorStatus,
  name: "",
  email: "",
  mobile: "",
  provider: "",
  smsGateway: "",
  mmsGateway: ""
});
const imapForm = reactive({
  status: "disabled" as ConnectorStatus,
  username: "",
  password: "",
  passwordSet: false,
  host: "",
  port: 993,
  secure: true,
  mailbox: "INBOX"
});
const smtpForm = reactive({
  status: "disabled" as ConnectorStatus,
  username: "",
  password: "",
  passwordSet: false,
  host: "",
  port: 587,
  secure: false,
  from: ""
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

const taskStatuses = ["pending", "claimed", "running", "completed", "cancelled", "failed"];
const activeOutbox = computed(() => outbox.value.filter((message) => ["requires_approval", "pending", "approved", "sending"].includes(message.status)));
const outboxHistory = computed(() => outbox.value.filter((message) => ["sent", "failed"].includes(message.status)));
const recentAudit = computed(() => audit.value.slice(0, 12));
const totalTaskPages = computed(() => Math.max(1, Math.ceil(tasks.value.length / tasksPerPage)));
const totalInboxPages = computed(() => Math.max(1, Math.ceil(inbox.value.length / inboxPerPage)));
const totalOutboxPages = computed(() => Math.max(1, Math.ceil(outboxHistory.value.length / outboxPerPage)));
const paginatedTasks = computed(() => {
  const page = Math.min(taskPage.value, totalTaskPages.value);
  const offset = (page - 1) * tasksPerPage;
  return tasks.value.slice(offset, offset + tasksPerPage);
});
const paginatedInbox = computed(() => {
  const page = Math.min(inboxPage.value, totalInboxPages.value);
  const offset = (page - 1) * inboxPerPage;
  return inbox.value.slice(offset, offset + inboxPerPage);
});
const paginatedOutbox = computed(() => {
  const page = Math.min(outboxPage.value, totalOutboxPages.value);
  const offset = (page - 1) * outboxPerPage;
  return outboxHistory.value.slice(offset, offset + outboxPerPage);
});
const selectedTaskOpen = computed(() => selectedTask.value !== null);
const taskModalTitle = computed(() => selectedTask.value?.title ?? "Task details");

function tabFromRoute(value: unknown): TabId {
  const tab = Array.isArray(value) ? value[0] : value;
  return typeof tab === "string" && tabIds.has(tab as TabId) ? tab as TabId : "overview";
}

function applyAiConfig(config: AiConfig | null): void {
  aiConfig.value = config;
  if (!config) {
    return;
  }
  Object.assign(configForm, config);
}

function configObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function configString(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  return typeof value === "string" ? value : "";
}

function configNumber(config: Record<string, unknown>, key: string, fallback: number): number {
  const value = config[key];
  return typeof value === "number" ? value : fallback;
}

function configBoolean(config: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = config[key];
  return typeof value === "boolean" ? value : fallback;
}

function findConnector(kind: ConnectorKind): Connector | undefined {
  return connectors.value.find((connector) => connector.kind === kind);
}

function applyConnectors(nextConnectors: Connector[]): void {
  connectors.value = nextConnectors;
  const ownerContact = findConnector("owner-contact");
  const ownerConfig = ownerContact?.config ?? {};
  ownerContactForm.status = ownerContact?.status ?? "enabled";
  ownerContactForm.name = configString(ownerConfig, "name");
  ownerContactForm.email = configString(ownerConfig, "email");
  ownerContactForm.mobile = configString(ownerConfig, "mobile");
  ownerContactForm.provider = configString(ownerConfig, "provider");
  ownerContactForm.smsGateway = configString(ownerConfig, "sms_gateway");
  ownerContactForm.mmsGateway = configString(ownerConfig, "mms_gateway");

  const imap = findConnector("imap");
  const imapConfig = imap?.config ?? {};
  const imapServer = configObject(imapConfig.imap);
  imapForm.status = imap?.status ?? "disabled";
  imapForm.username = configString(imapConfig, "username");
  imapForm.password = "";
  imapForm.passwordSet = configBoolean(imapServer, "password_set", false);
  imapForm.host = configString(imapServer, "host");
  imapForm.port = configNumber(imapServer, "port", 993);
  imapForm.secure = configBoolean(imapServer, "secure", true);
  imapForm.mailbox = configString(imapServer, "mailbox") || "INBOX";

  const smtp = findConnector("smtp");
  const smtpConfig = smtp?.config ?? {};
  const smtpServer = configObject(smtpConfig.smtp);
  smtpForm.status = smtp?.status ?? "disabled";
  smtpForm.username = configString(smtpConfig, "username");
  smtpForm.password = "";
  smtpForm.passwordSet = configBoolean(smtpServer, "password_set", false);
  smtpForm.host = configString(smtpServer, "host");
  smtpForm.port = configNumber(smtpServer, "port", 587);
  smtpForm.secure = configBoolean(smtpServer, "secure", false);
  smtpForm.from = configString(smtpServer, "from");
}

function formatDate(value: string | null | undefined): string {
  if (!value) {
    return "Not set";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function statusTagClass(status: string): string {
  if (["completed", "sent", "approved", "configured", "owner", "trusted"].includes(status)) {
    return "cds--tag--green";
  }
  if (["failed", "blocked"].includes(status)) {
    return "cds--tag--red";
  }
  if (["running", "claimed", "sending", "newsletter", "routed_to_agent", "accepted_newsletter"].includes(status)) {
    return "cds--tag--blue";
  }
  if (["cancelled", "untrusted"].includes(status)) {
    return "cds--tag--gray";
  }
  return "cds--tag--warm-gray";
}

function formatDetails(details: Record<string, unknown>): string {
  if (Object.keys(details).length === 0) {
    return "";
  }
  return JSON.stringify(details, null, 2);
}

function setActiveTab(tabId: TabId): void {
  activeTab.value = tabId;
  void router.replace({ query: { ...route.query, tab: tabId } });
}

function clampPages(): void {
  taskPage.value = Math.min(taskPage.value, totalTaskPages.value);
  inboxPage.value = Math.min(inboxPage.value, totalInboxPages.value);
  outboxPage.value = Math.min(outboxPage.value, totalOutboxPages.value);
}

function previousTaskPage(): void {
  taskPage.value = Math.max(1, taskPage.value - 1);
}

function nextTaskPage(): void {
  taskPage.value = Math.min(totalTaskPages.value, taskPage.value + 1);
}

function previousInboxPage(): void {
  inboxPage.value = Math.max(1, inboxPage.value - 1);
}

function nextInboxPage(): void {
  inboxPage.value = Math.min(totalInboxPages.value, inboxPage.value + 1);
}

function previousOutboxPage(): void {
  outboxPage.value = Math.max(1, outboxPage.value - 1);
}

function nextOutboxPage(): void {
  outboxPage.value = Math.min(totalOutboxPages.value, outboxPage.value + 1);
}

async function loadDashboard(): Promise<void> {
  if (!auth.authenticated) {
    return;
  }
  try {
    const data = await api.dashboard();
    tasks.value = data.tasks;
    inbox.value = data.inbox;
    outbox.value = data.outbox;
    audit.value = data.audit;
    senders.value = data.senders;
    jobs.value = data.jobs;
    applyConnectors(data.connectors);
    applyAiConfig(data.aiConfig);
    clampPages();
    dashboardError.value = null;
  } catch {
    dashboardError.value = "Unable to load agent activity.";
  }
}

async function loadActiveTab(): Promise<void> {
  if (!auth.authenticated || activeTabRefreshInFlight) {
    return;
  }
  activeTabRefreshInFlight = true;
  try {
    switch (activeTab.value) {
      case "overview": {
        await loadDashboard();
        return;
      }
      case "inbox": {
        const response = await api.listInbox();
        inbox.value = response.messages;
        break;
      }
      case "outbox": {
        const response = await api.listOutbox();
        outbox.value = response.messages;
        break;
      }
      case "tasks": {
        const response = await api.listTasks();
        tasks.value = response.tasks;
        break;
      }
      case "senders": {
        const response = await api.listSenders();
        senders.value = response.senders;
        break;
      }
      case "workers": {
        const response = await api.listJobs().catch(() => ({ jobs: [] }));
        jobs.value = response.jobs;
        break;
      }
      case "logs": {
        const response = await api.listAudit();
        audit.value = response.events;
        break;
      }
      case "settings": {
        const response = await api.listConnectors();
        applyConnectors(response.connectors);
        break;
      }
      case "admin": {
        applyAiConfig(await api.getAiConfig().catch(() => null));
        break;
      }
    }
    clampPages();
    dashboardError.value = null;
  } catch {
    dashboardError.value = "Unable to refresh the selected tab.";
  } finally {
    activeTabRefreshInFlight = false;
  }
}

function startDashboardPolling(): void {
  if (dashboardPollHandle) {
    return;
  }
  dashboardPollHandle = window.setInterval(() => {
    if (document.visibilityState === "hidden") {
      return;
    }
    void loadActiveTab();
  }, dashboardPollIntervalMs);
}

function stopDashboardPolling(): void {
  if (!dashboardPollHandle) {
    return;
  }
  window.clearInterval(dashboardPollHandle);
  dashboardPollHandle = null;
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
    taskPage.value = 1;
    await loadDashboard();
  } catch {
    dashboardError.value = "Unable to save the task.";
  } finally {
    saving.value = false;
  }
}

async function openTask(task: Task): Promise<void> {
  selectedTask.value = task;
  taskStatusDraft.value = task.status;
  taskFollowUpPrompt.value = "";
  taskModalError.value = null;
  try {
    const response = await api.listTaskEvents(task.id);
    selectedTaskEvents.value = response.events;
  } catch {
    selectedTaskEvents.value = [];
    taskModalError.value = "Unable to load task events.";
  }
}

async function openInboxTask(message: InboundMessage): Promise<void> {
  if (!message.taskId) {
    return;
  }
  const task = tasks.value.find((candidate) => candidate.id === message.taskId);
  if (!task) {
    dashboardError.value = "The linked task is not in the current task list.";
    return;
  }
  await openTask(task);
}

function closeTask(): void {
  selectedTask.value = null;
  selectedTaskEvents.value = [];
  taskFollowUpPrompt.value = "";
  taskModalError.value = null;
}

async function saveTaskStatus(): Promise<void> {
  if (!selectedTask.value) {
    return;
  }
  saving.value = true;
  try {
    const task = await api.updateTask(selectedTask.value.id, { status: taskStatusDraft.value });
    selectedTask.value = task;
    await loadDashboard();
    const response = await api.listTaskEvents(task.id);
    selectedTaskEvents.value = response.events;
    taskModalError.value = null;
  } catch {
    taskModalError.value = "Unable to update task status.";
  } finally {
    saving.value = false;
  }
}

async function addFollowUpPrompt(): Promise<void> {
  if (!selectedTask.value || !taskFollowUpPrompt.value.trim()) {
    return;
  }
  saving.value = true;
  try {
    const response = await api.addTaskPrompt(selectedTask.value.id, taskFollowUpPrompt.value);
    selectedTask.value = response.task;
    selectedTaskEvents.value = response.events;
    taskStatusDraft.value = response.task.status;
    taskFollowUpPrompt.value = "";
    await loadDashboard();
    taskModalError.value = null;
  } catch {
    taskModalError.value = "Unable to add the follow-up prompt.";
  } finally {
    saving.value = false;
  }
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

async function saveOwnerContactConfig(): Promise<void> {
  saving.value = true;
  try {
    await api.updateConnector("owner-contact", ownerContactForm.status, {
      name: ownerContactForm.name,
      email: ownerContactForm.email,
      mobile: ownerContactForm.mobile,
      provider: ownerContactForm.provider,
      smsGateway: ownerContactForm.smsGateway,
      mmsGateway: ownerContactForm.mmsGateway
    });
    const response = await api.listConnectors();
    applyConnectors(response.connectors);
    dashboardError.value = null;
  } catch {
    dashboardError.value = "Unable to save owner contact configuration.";
  } finally {
    saving.value = false;
  }
}

async function saveImapConfig(): Promise<void> {
  saving.value = true;
  try {
    await api.updateConnector("imap", imapForm.status, {
      username: imapForm.username,
      password: imapForm.password,
      host: imapForm.host,
      port: Number(imapForm.port),
      secure: imapForm.secure,
      mailbox: imapForm.mailbox
    });
    const response = await api.listConnectors();
    applyConnectors(response.connectors);
    dashboardError.value = null;
  } catch {
    dashboardError.value = "Unable to save IMAP configuration.";
  } finally {
    saving.value = false;
  }
}

async function saveSmtpConfig(): Promise<void> {
  saving.value = true;
  try {
    await api.updateConnector("smtp", smtpForm.status, {
      username: smtpForm.username,
      password: smtpForm.password,
      host: smtpForm.host,
      port: Number(smtpForm.port),
      secure: smtpForm.secure,
      from: smtpForm.from
    });
    const response = await api.listConnectors();
    applyConnectors(response.connectors);
    dashboardError.value = null;
  } catch {
    dashboardError.value = "Unable to save SMTP configuration.";
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
  } else if (auth.authenticated) {
    void loadDashboard();
  }
  startDashboardPolling();
});

watch(() => auth.authenticated, (authenticated) => {
  if (authenticated) {
    void loadDashboard();
  }
});

watch(() => route.query.tab, (tab) => {
  const nextTab = tabFromRoute(tab);
  if (nextTab !== activeTab.value) {
    activeTab.value = nextTab;
  }
});

watch(activeTab, () => {
  void loadActiveTab();
});

onUnmounted(() => {
  stopDashboardPolling();
});
</script>

<template>
  <section class="home-view">
    <header class="home-header">
      <p class="eyebrow">AI Assistant</p>
      <h1>Tasks, messages, and agent operations</h1>
    </header>

    <div v-if="auth.error" class="cds--inline-notification cds--inline-notification--error" role="alert">
      <div class="cds--inline-notification__details">
        <div class="cds--inline-notification__text-wrapper">
          <p class="cds--inline-notification__title">Sign-in error</p>
          <p class="cds--inline-notification__subtitle">{{ auth.error }}</p>
        </div>
      </div>
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

      <div v-if="dashboardError" class="cds--inline-notification cds--inline-notification--error" role="alert">
        <div class="cds--inline-notification__details">
          <div class="cds--inline-notification__text-wrapper">
            <p class="cds--inline-notification__title">Dashboard error</p>
            <p class="cds--inline-notification__subtitle">{{ dashboardError }}</p>
          </div>
        </div>
      </div>

      <nav class="cds--tabs" aria-label="Assistant sections">
        <div class="cds--tab--list" role="tablist">
          <button
            v-for="tab in tabs"
            :id="`tab-${tab.id}`"
            :key="tab.id"
            class="cds--tabs__nav-link"
            :class="{ 'cds--tabs__nav-item--selected': activeTab === tab.id }"
            type="button"
            role="tab"
            :aria-selected="activeTab === tab.id"
            :aria-controls="`panel-${tab.id}`"
            @click="setActiveTab(tab.id)"
          >
            {{ tab.label }}
          </button>
        </div>
      </nav>

      <section v-show="activeTab === 'overview'" id="panel-overview" class="tab-panel" role="tabpanel" aria-labelledby="tab-overview">
        <div class="metric-grid" aria-label="Operational summary">
          <section class="metric-card">
            <p class="label">Tasks</p>
            <p class="metric-value">{{ tasks.length }}</p>
          </section>
          <section class="metric-card">
            <p class="label">Outbox</p>
            <p class="metric-value">{{ outbox.length }}</p>
          </section>
          <section class="metric-card">
            <p class="label">Inbox</p>
            <p class="metric-value">{{ inbox.length }}</p>
          </section>
          <section class="metric-card">
            <p class="label">Senders</p>
            <p class="metric-value">{{ senders.length }}</p>
          </section>
          <section class="metric-card">
            <p class="label">Audit events</p>
            <p class="metric-value">{{ audit.length }}</p>
          </section>
        </div>

        <section class="activity-section" aria-label="Active outbound queue">
          <div class="section-heading">
            <h2>Needs attention</h2>
          </div>
          <p v-if="activeOutbox.length === 0" class="empty">No outbound messages need attention.</p>
          <table v-else class="cds--data-table cds--data-table--zebra">
            <thead>
              <tr>
                <th>Channel</th>
                <th>Recipient</th>
                <th>Status</th>
                <th>Message</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="message in activeOutbox" :key="message.id">
                <td>{{ message.channel }}</td>
                <td>{{ message.toAddr }}</td>
                <td>
                  <span class="cds--tag" :class="statusTagClass(message.status)">{{ message.status }}</span>
                </td>
                <td>
                  <span class="table-copy">{{ message.failureMessage ? `Failure: ${message.failureMessage}` : message.bodyText }}</span>
                </td>
                <td>
                  <div class="table-actions">
                    <button v-if="message.status === 'requires_approval'" class="cds--btn cds--btn--sm cds--btn--primary" type="button" @click="updateOutboxStatus(message, 'approved')">
                      Approve
                    </button>
                    <button v-if="message.status !== 'sending'" class="cds--btn cds--btn--sm cds--btn--secondary" type="button" @click="updateOutboxStatus(message, 'cancelled')">
                      Cancel
                    </button>
                    <span v-if="message.status !== 'requires_approval' && message.status !== 'sending'" class="label">Queued for delivery</span>
                    <span v-if="message.status === 'sending'" class="label">Sending</span>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      </section>

      <section v-show="activeTab === 'inbox'" id="panel-inbox" class="tab-panel" role="tabpanel" aria-labelledby="tab-inbox">
        <section class="activity-section" aria-label="Inbox">
          <div class="section-heading">
            <h2>Inbox</h2>
            <p class="label">{{ inbox.length }} messages</p>
          </div>
          <p v-if="inbox.length === 0" class="empty">No inbound messages recorded.</p>
          <template v-else>
            <table class="cds--data-table cds--data-table--zebra">
              <thead>
                <tr>
                  <th>Received</th>
                  <th>From</th>
                  <th>Source</th>
                  <th>Classification</th>
                  <th>Action</th>
                  <th>Task</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="message in paginatedInbox" :key="message.id">
                  <td>{{ formatDate(message.receivedAt || message.createdAt) }}</td>
                  <td>{{ message.fromAddr }}</td>
                  <td>{{ message.source || "imap" }}</td>
                  <td>
                    <span class="cds--tag" :class="statusTagClass(message.classification)">{{ message.classification }}</span>
                  </td>
                  <td>{{ message.handlingAction || "recorded" }}</td>
                  <td>
                    <button v-if="message.taskId" class="link-button" type="button" @click="openInboxTask(message)">
                      {{ message.taskId }}
                    </button>
                    <span v-else>none</span>
                  </td>
                  <td>
                    <span class="table-copy">{{ message.subject ? `${message.subject}: ${message.bodyText}` : message.bodyText }}</span>
                  </td>
                </tr>
              </tbody>
            </table>
            <div class="cds--pagination pagination-bar">
              <div class="cds--pagination__left">
                Page {{ inboxPage }} of {{ totalInboxPages }}
              </div>
              <div class="cds--pagination__right">
                <button class="cds--btn cds--btn--sm cds--btn--ghost" type="button" :disabled="inboxPage === 1" @click="previousInboxPage">
                  Previous
                </button>
                <button class="cds--btn cds--btn--sm cds--btn--ghost" type="button" :disabled="inboxPage === totalInboxPages" @click="nextInboxPage">
                  Next
                </button>
              </div>
            </div>
          </template>
        </section>
      </section>

      <section v-show="activeTab === 'outbox'" id="panel-outbox" class="tab-panel" role="tabpanel" aria-labelledby="tab-outbox">
        <section class="activity-section" aria-label="Outbox history">
          <div class="section-heading">
            <h2>Outbox</h2>
            <p class="label">{{ outboxHistory.length }} sent or failed</p>
          </div>
          <p v-if="outboxHistory.length === 0" class="empty">No sent or failed outbound messages.</p>
          <template v-else>
            <table class="cds--data-table cds--data-table--zebra">
              <thead>
                <tr>
                  <th>Created</th>
                  <th>Sent</th>
                  <th>Channel</th>
                  <th>Recipient</th>
                  <th>Status</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="message in paginatedOutbox" :key="message.id">
                  <td>{{ formatDate(message.createdAt) }}</td>
                  <td>{{ formatDate(message.sentAt) }}</td>
                  <td>{{ message.channel }}</td>
                  <td>{{ message.toAddr }}</td>
                  <td>
                    <span class="cds--tag" :class="statusTagClass(message.status)">{{ message.status }}</span>
                  </td>
                  <td>
                    <span class="table-copy">{{ message.failureMessage ? `Failure: ${message.failureMessage}` : message.bodyText }}</span>
                  </td>
                </tr>
              </tbody>
            </table>
            <div class="cds--pagination pagination-bar">
              <div class="cds--pagination__left">
                Page {{ outboxPage }} of {{ totalOutboxPages }}
              </div>
              <div class="cds--pagination__right">
                <button class="cds--btn cds--btn--sm cds--btn--ghost" type="button" :disabled="outboxPage === 1" @click="previousOutboxPage">
                  Previous
                </button>
                <button class="cds--btn cds--btn--sm cds--btn--ghost" type="button" :disabled="outboxPage === totalOutboxPages" @click="nextOutboxPage">
                  Next
                </button>
              </div>
            </div>
          </template>
        </section>
      </section>

      <section v-show="activeTab === 'tasks'" id="panel-tasks" class="tab-panel" role="tabpanel" aria-labelledby="tab-tasks">
        <section class="activity-section" aria-label="Create task">
          <div class="section-heading">
            <h2>Add task</h2>
          </div>
          <form class="form-grid" @submit.prevent="createTask">
            <div class="cds--form-item">
              <label class="cds--label" for="task-title">Title</label>
              <input id="task-title" v-model="taskForm.title" class="cds--text-input" required type="text">
            </div>
            <div class="cds--form-item form-wide">
              <label class="cds--label" for="task-prompt">Prompt</label>
              <textarea id="task-prompt" v-model="taskForm.prompt" class="cds--text-area" required rows="4" />
            </div>
            <div class="cds--form-item">
              <label class="cds--label" for="task-due">Due</label>
              <input id="task-due" v-model="taskForm.dueAt" class="cds--text-input" type="datetime-local">
            </div>
            <div class="cds--form-item">
              <label class="cds--label" for="task-priority">Priority</label>
              <input id="task-priority" v-model.number="taskForm.priority" class="cds--text-input" type="number" min="0" step="1">
            </div>
            <div class="form-actions">
              <button class="cds--btn cds--btn--primary" type="submit" :disabled="saving">
                Add task
              </button>
            </div>
          </form>
        </section>

        <section class="activity-section" aria-label="Tasks">
          <div class="section-heading">
            <h2>Tasks</h2>
            <p class="label">{{ tasks.length }} total</p>
          </div>
          <p v-if="tasks.length === 0" class="empty">No tasks scheduled.</p>
          <template v-else>
            <table class="cds--data-table cds--data-table--zebra">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Status</th>
                  <th>Due</th>
                  <th>Priority</th>
                  <th>Updated</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="task in paginatedTasks" :key="task.id">
                  <td>
                    <button class="link-button" type="button" @click="openTask(task)">
                      {{ task.title }}
                    </button>
                  </td>
                  <td>
                    <span class="cds--tag" :class="statusTagClass(task.status)">{{ task.status }}</span>
                  </td>
                  <td>{{ formatDate(task.dueAt) }}</td>
                  <td>{{ task.priority }}</td>
                  <td>{{ formatDate(task.updatedAt) }}</td>
                  <td>
                    <button class="cds--btn cds--btn--sm cds--btn--secondary" type="button" @click="openTask(task)">
                      View
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
            <div class="cds--pagination pagination-bar">
              <div class="cds--pagination__left">
                Page {{ taskPage }} of {{ totalTaskPages }}
              </div>
              <div class="cds--pagination__right">
                <button class="cds--btn cds--btn--sm cds--btn--ghost" type="button" :disabled="taskPage === 1" @click="previousTaskPage">
                  Previous
                </button>
                <button class="cds--btn cds--btn--sm cds--btn--ghost" type="button" :disabled="taskPage === totalTaskPages" @click="nextTaskPage">
                  Next
                </button>
              </div>
            </div>
          </template>
        </section>
      </section>

      <section v-show="activeTab === 'senders'" id="panel-senders" class="tab-panel" role="tabpanel" aria-labelledby="tab-senders">
        <section class="activity-section" aria-label="Sender trust">
          <div class="section-heading">
            <h2>Sender trust</h2>
          </div>
          <form class="form-grid sender-form" @submit.prevent="saveSender">
            <div class="cds--form-item">
              <label class="cds--label" for="sender-address">Address</label>
              <input id="sender-address" v-model="senderForm.address" class="cds--text-input" required type="email">
            </div>
            <div class="cds--form-item">
              <label class="cds--label" for="sender-status">Status</label>
              <select id="sender-status" v-model="senderForm.status" class="cds--select-input">
                <option value="owner">owner</option>
                <option value="newsletter">newsletter</option>
                <option value="trusted">trusted</option>
                <option value="blocked">blocked</option>
                <option value="untrusted">untrusted</option>
              </select>
            </div>
            <div class="form-actions">
              <button class="cds--btn cds--btn--primary" type="submit" :disabled="saving">
                Save sender
              </button>
            </div>
          </form>
          <p v-if="senders.length === 0" class="empty">No senders configured.</p>
          <table v-else class="cds--data-table cds--data-table--zebra">
            <thead>
              <tr>
                <th>Address</th>
                <th>Status</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="sender in senders" :key="sender.id">
                <td>{{ sender.address }}</td>
                <td>
                  <span class="cds--tag" :class="statusTagClass(sender.status)">{{ sender.status }}</span>
                </td>
                <td>{{ formatDate(sender.updatedAt) }}</td>
              </tr>
            </tbody>
          </table>
        </section>
      </section>

      <section v-show="activeTab === 'workers'" id="panel-workers" class="tab-panel" role="tabpanel" aria-labelledby="tab-workers">
        <section class="activity-section" aria-label="Worker jobs">
          <div class="section-heading">
            <h2>Worker jobs</h2>
          </div>
          <p v-if="jobs.length === 0" class="empty">No worker status available.</p>
          <table v-else class="cds--data-table cds--data-table--zebra">
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Pending</th>
                <th>Due</th>
                <th>Failed</th>
                <th>Last audit</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="job in jobs" :key="job.name">
                <td>{{ job.name }}</td>
                <td>
                  <span class="cds--tag" :class="statusTagClass(job.status)">{{ job.status }}</span>
                </td>
                <td>{{ job.pendingTasks ?? job.pendingMessages ?? 0 }}</td>
                <td>{{ job.dueTasks ?? 0 }}</td>
                <td>{{ job.failedMessages ?? 0 }}</td>
                <td>{{ formatDate(job.lastAuditAt) }}</td>
              </tr>
            </tbody>
          </table>
        </section>
      </section>

      <section v-show="activeTab === 'logs'" id="panel-logs" class="tab-panel" role="tabpanel" aria-labelledby="tab-logs">
        <section class="activity-section" aria-label="Audit history">
          <div class="section-heading">
            <h2>Audit history</h2>
          </div>
          <p v-if="recentAudit.length === 0" class="empty">No audit events.</p>
          <table v-else class="cds--data-table cds--data-table--zebra">
            <thead>
              <tr>
                <th>Action</th>
                <th>Entity</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="event in recentAudit" :key="event.id">
                <td>{{ event.action }}</td>
                <td>{{ event.entityType || "none" }} {{ event.entityId || "" }}</td>
                <td>{{ formatDate(event.createdAt) }}</td>
              </tr>
            </tbody>
          </table>
        </section>
      </section>

      <section v-show="activeTab === 'settings'" id="panel-settings" class="tab-panel" role="tabpanel" aria-labelledby="tab-settings">
        <section class="activity-section" aria-label="Connector configuration">
          <div class="section-heading">
            <h2>Account settings</h2>
          </div>
          <div class="connector-grid">
            <form class="form-grid connector-form" @submit.prevent="saveOwnerContactConfig">
              <h3>Owner contact</h3>
              <div class="cds--form-item">
                <label class="cds--label" for="owner-contact-status">Status</label>
                <select id="owner-contact-status" v-model="ownerContactForm.status" class="cds--select-input">
                  <option value="enabled">enabled</option>
                  <option value="disabled">disabled</option>
                </select>
              </div>
              <div class="cds--form-item">
                <label class="cds--label" for="owner-contact-name">Name</label>
                <input id="owner-contact-name" v-model="ownerContactForm.name" class="cds--text-input" type="text">
              </div>
              <div class="cds--form-item">
                <label class="cds--label" for="owner-contact-email">Email</label>
                <input id="owner-contact-email" v-model="ownerContactForm.email" class="cds--text-input" type="email">
              </div>
              <div class="cds--form-item">
                <label class="cds--label" for="owner-contact-mobile">Mobile</label>
                <input id="owner-contact-mobile" v-model="ownerContactForm.mobile" class="cds--text-input" type="tel">
              </div>
              <div class="cds--form-item">
                <label class="cds--label" for="owner-contact-provider">Mobile provider</label>
                <input id="owner-contact-provider" v-model="ownerContactForm.provider" class="cds--text-input" type="text">
              </div>
              <div class="cds--form-item">
                <label class="cds--label" for="owner-contact-sms">SMS gateway</label>
                <input id="owner-contact-sms" v-model="ownerContactForm.smsGateway" class="cds--text-input" type="email">
              </div>
              <div class="cds--form-item">
                <label class="cds--label" for="owner-contact-mms">MMS gateway</label>
                <input id="owner-contact-mms" v-model="ownerContactForm.mmsGateway" class="cds--text-input" type="email">
              </div>
              <div class="form-actions">
                <button class="cds--btn cds--btn--primary" type="submit" :disabled="saving">
                  Save owner contact
                </button>
              </div>
            </form>

            <form class="form-grid connector-form" @submit.prevent="saveImapConfig">
              <h3>IMAP inbox</h3>
              <div class="cds--form-item">
                <label class="cds--label" for="imap-status">Status</label>
                <select id="imap-status" v-model="imapForm.status" class="cds--select-input">
                  <option value="enabled">enabled</option>
                  <option value="disabled">disabled</option>
                </select>
              </div>
              <div class="cds--form-item">
                <label class="cds--label" for="imap-username">Username</label>
                <input id="imap-username" v-model="imapForm.username" class="cds--text-input" type="email">
              </div>
              <div class="cds--form-item">
                <label class="cds--label" for="imap-password">Password</label>
                <input id="imap-password" v-model="imapForm.password" class="cds--text-input" type="password" :placeholder="imapForm.passwordSet ? 'Saved' : ''" autocomplete="new-password">
              </div>
              <div class="cds--form-item">
                <label class="cds--label" for="imap-host">Host</label>
                <input id="imap-host" v-model="imapForm.host" class="cds--text-input" type="text">
              </div>
              <div class="cds--form-item">
                <label class="cds--label" for="imap-port">Port</label>
                <input id="imap-port" v-model.number="imapForm.port" class="cds--text-input" type="number" min="1">
              </div>
              <div class="cds--form-item checkbox-item">
                <input id="imap-secure" v-model="imapForm.secure" class="cds--checkbox" type="checkbox">
                <label class="cds--checkbox-label" for="imap-secure">Use TLS</label>
              </div>
              <div class="cds--form-item">
                <label class="cds--label" for="imap-mailbox">Mailbox</label>
                <input id="imap-mailbox" v-model="imapForm.mailbox" class="cds--text-input" type="text">
              </div>
              <div class="form-actions">
                <button class="cds--btn cds--btn--primary" type="submit" :disabled="saving">
                  Save IMAP
                </button>
              </div>
            </form>

            <form class="form-grid connector-form" @submit.prevent="saveSmtpConfig">
              <h3>SMTP outbox</h3>
              <div class="cds--form-item">
                <label class="cds--label" for="smtp-status">Status</label>
                <select id="smtp-status" v-model="smtpForm.status" class="cds--select-input">
                  <option value="enabled">enabled</option>
                  <option value="disabled">disabled</option>
                </select>
              </div>
              <div class="cds--form-item">
                <label class="cds--label" for="smtp-username">Username</label>
                <input id="smtp-username" v-model="smtpForm.username" class="cds--text-input" type="email">
              </div>
              <div class="cds--form-item">
                <label class="cds--label" for="smtp-password">Password</label>
                <input id="smtp-password" v-model="smtpForm.password" class="cds--text-input" type="password" :placeholder="smtpForm.passwordSet ? 'Saved' : ''" autocomplete="new-password">
              </div>
              <div class="cds--form-item">
                <label class="cds--label" for="smtp-host">Host</label>
                <input id="smtp-host" v-model="smtpForm.host" class="cds--text-input" type="text">
              </div>
              <div class="cds--form-item">
                <label class="cds--label" for="smtp-port">Port</label>
                <input id="smtp-port" v-model.number="smtpForm.port" class="cds--text-input" type="number" min="1">
              </div>
              <div class="cds--form-item checkbox-item">
                <input id="smtp-secure" v-model="smtpForm.secure" class="cds--checkbox" type="checkbox">
                <label class="cds--checkbox-label" for="smtp-secure">Use TLS</label>
              </div>
              <div class="cds--form-item">
                <label class="cds--label" for="smtp-from">From address</label>
                <input id="smtp-from" v-model="smtpForm.from" class="cds--text-input" type="email">
              </div>
              <div class="form-actions">
                <button class="cds--btn cds--btn--primary" type="submit" :disabled="saving">
                  Save SMTP
                </button>
              </div>
            </form>
          </div>
        </section>
      </section>

      <section v-show="activeTab === 'admin'" id="panel-admin" class="tab-panel" role="tabpanel" aria-labelledby="tab-admin">
        <section v-if="aiConfig" class="activity-section" aria-label="AI configuration">
          <div class="section-heading">
            <h2>AI configuration</h2>
          </div>
          <form class="form-grid config-form" @submit.prevent="saveAiConfig">
            <div class="cds--form-item">
              <label class="cds--label" for="fast-model">Fast model</label>
              <input id="fast-model" v-model="configForm.fastModel" class="cds--text-input" required type="text">
            </div>
            <div class="cds--form-item">
              <label class="cds--label" for="smart-model">Smart model</label>
              <input id="smart-model" v-model="configForm.smartModel" class="cds--text-input" required type="text">
            </div>
            <div class="cds--form-item">
              <label class="cds--label" for="orchestrator-model">Orchestrator model</label>
              <input id="orchestrator-model" v-model="configForm.orchestratorModel" class="cds--text-input" required type="text">
            </div>
            <div class="cds--form-item">
              <label class="cds--label" for="repair-model">Repair model</label>
              <input id="repair-model" v-model="configForm.repairModel" class="cds--text-input" required type="text">
            </div>
            <div class="cds--form-item">
              <label class="cds--label" for="max-tool-calls">Max tool calls</label>
              <input id="max-tool-calls" v-model.number="configForm.maxToolCalls" class="cds--text-input" required type="number" min="1">
            </div>
            <div class="cds--form-item">
              <label class="cds--label" for="max-runtime-sec">Max runtime sec</label>
              <input id="max-runtime-sec" v-model.number="configForm.maxRuntimeSec" class="cds--text-input" required type="number" min="1">
            </div>
            <div class="cds--form-item">
              <label class="cds--label" for="repair-attempts">Repair attempts</label>
              <input id="repair-attempts" v-model.number="configForm.repairAttemptLimit" class="cds--text-input" required type="number" min="0">
            </div>
            <div class="form-actions">
              <button class="cds--btn cds--btn--primary" type="submit" :disabled="saving">
                Save config
              </button>
            </div>
          </form>
        </section>
      </section>
    </section>

    <div v-if="selectedTaskOpen" class="cds--modal is-visible task-modal" role="dialog" aria-modal="true" aria-labelledby="task-modal-title">
      <div class="cds--modal-container">
        <div class="cds--modal-header">
          <p class="cds--modal-header__label">Task</p>
          <h2 id="task-modal-title" class="cds--modal-header__heading">{{ taskModalTitle }}</h2>
          <button class="cds--modal-close" type="button" aria-label="Close" @click="closeTask">
            <span aria-hidden="true">x</span>
          </button>
        </div>
        <div class="cds--modal-content">
          <div v-if="taskModalError" class="cds--inline-notification cds--inline-notification--error" role="alert">
            <div class="cds--inline-notification__details">
              <div class="cds--inline-notification__text-wrapper">
                <p class="cds--inline-notification__title">Task error</p>
                <p class="cds--inline-notification__subtitle">{{ taskModalError }}</p>
              </div>
            </div>
          </div>

          <dl class="task-detail-grid">
            <div>
              <dt>Status</dt>
              <dd><span class="cds--tag" :class="statusTagClass(selectedTask?.status || '')">{{ selectedTask?.status }}</span></dd>
            </div>
            <div>
              <dt>Due</dt>
              <dd>{{ formatDate(selectedTask?.dueAt) }}</dd>
            </div>
            <div>
              <dt>Priority</dt>
              <dd>{{ selectedTask?.priority }}</dd>
            </div>
          </dl>

          <section class="modal-section">
            <h3>Prompt</h3>
            <p class="prompt-copy">{{ selectedTask?.prompt }}</p>
          </section>

          <section class="modal-section">
            <h3>Status</h3>
            <div class="modal-control-row">
              <select v-model="taskStatusDraft" class="cds--select-input" aria-label="Task status">
                <option v-for="status in taskStatuses" :key="status" :value="status">{{ status }}</option>
              </select>
              <button class="cds--btn cds--btn--primary" type="button" :disabled="saving" @click="saveTaskStatus">
                Save status
              </button>
            </div>
          </section>

          <section class="modal-section">
            <h3>Continue task</h3>
            <label class="cds--label" for="follow-up-prompt">Follow-up prompt</label>
            <textarea id="follow-up-prompt" v-model="taskFollowUpPrompt" class="cds--text-area" rows="4" />
            <div class="modal-actions">
              <button class="cds--btn cds--btn--primary" type="button" :disabled="saving || !taskFollowUpPrompt.trim()" @click="addFollowUpPrompt">
                Add prompt
              </button>
            </div>
          </section>

          <section class="modal-section">
            <h3>Events</h3>
            <p v-if="selectedTaskEvents.length === 0" class="empty">No events recorded.</p>
            <ol v-else class="event-list">
              <li v-for="event in selectedTaskEvents" :key="event.id">
                <div class="event-heading">
                  <span class="cds--tag cds--tag--blue">{{ event.eventType }}</span>
                  <time>{{ formatDate(event.createdAt) }}</time>
                </div>
                <p>{{ event.summary }}</p>
                <pre v-if="formatDetails(event.details)">{{ formatDetails(event.details) }}</pre>
              </li>
            </ol>
          </section>
        </div>
        <div class="cds--modal-footer">
          <button class="cds--btn cds--btn--secondary" type="button" @click="closeTask">
            Close
          </button>
        </div>
      </div>
    </div>
  </section>
</template>
