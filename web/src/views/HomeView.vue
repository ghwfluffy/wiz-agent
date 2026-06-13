<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  api,
  type AgentPromptMode,
  type AgentPromptResponse,
  type AiConfig,
  type Approval,
  type AuditEvent,
  type Connector,
  type ConnectorKind,
  type ConnectorStatus,
  type InboundMessage,
  type JobStatus,
  type JobsResponse,
  type KnowledgeDocument,
  type KnowledgeEntry,
  type KnowledgeSection,
  type MemoryChange,
  type MemoryDocument,
  type OutboxMessage,
  type PersonalDashboard,
  type RagIndexHealth,
  type RagIndexJob,
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
const authPanelMessage = computed(() => {
  if (authMode === "standalone") {
    return "Use the local development account to start testing the assistant.";
  }
  if (auth.error) {
    return "Central sign-in did not complete.";
  }
  return "Redirecting to central sign-in.";
});
const tabs = [
  { id: "overview", label: "Overview" },
  { id: "chat", label: "Chat" },
  { id: "inbox", label: "Agent Inbox" },
  { id: "approvals", label: "Approvals" },
  { id: "outbox", label: "Outbox" },
  { id: "tasks", label: "Tasks" },
  { id: "memory", label: "Memory" },
  { id: "senders", label: "Senders" },
  { id: "workers", label: "Workers" },
  { id: "logs", label: "Logs" },
  { id: "settings", label: "Settings" },
  { id: "admin", label: "Admin" }
] as const;
type TabId = typeof tabs[number]["id"];
type ChatMessage = {
  id: string;
  role: "user" | "agent";
  text: string;
  status?: "error";
};
const tabIds = new Set<TabId>(tabs.map((tab) => tab.id));
const dashboardPollIntervalMs = 10_000;
let dashboardPollHandle: number | null = null;
let activeTabRefreshInFlight = false;
let chatMessageSequence = 0;
const activeTab = ref<TabId>(tabFromRoute(route.query.tab));

const tasks = ref<Task[]>([]);
const inbox = ref<InboundMessage[]>([]);
const outbox = ref<OutboxMessage[]>([]);
const approvals = ref<Approval[]>([]);
const audit = ref<AuditEvent[]>([]);
const senders = ref<Sender[]>([]);
const connectors = ref<Connector[]>([]);
const memoryDocuments = ref<MemoryDocument[]>([]);
const memoryChanges = ref<MemoryChange[]>([]);
const personalDashboard = ref<PersonalDashboard | null>(null);
const knowledgeTree = ref<KnowledgeEntry[]>([]);
const knowledgeDocument = ref<KnowledgeDocument | null>(null);
const knowledgeSections = ref<KnowledgeSection[]>([]);
const aiConfig = ref<AiConfig | null>(null);
const jobs = ref<JobStatus[]>([]);
const jobBudgets = ref<Record<string, number>>({});
const failedRagJobs = ref<RagIndexJob[]>([]);
const ragIndexHealth = ref<RagIndexHealth[]>([]);
const dashboardError = ref<string | null>(null);
const promptError = ref<string | null>(null);
const promptResult = ref<AgentPromptResponse | null>(null);
const chatDraft = ref("");
const chatMessages = ref<ChatMessage[]>([]);
const imapTestMessage = ref<string | null>(null);
const imapTestError = ref<string | null>(null);
const saving = ref(false);
const sendingPrompt = ref(false);
const loadingKnowledge = ref(false);
const savingKnowledge = ref(false);
const testingImap = ref(false);
const retryingRagJobId = ref<string | null>(null);
const aiConfigDirty = ref(false);
const taskPage = ref(1);
const inboxPage = ref(1);
const outboxPage = ref(1);
const tasksPerPage = 10;
const inboxPerPage = 10;
const outboxPerPage = 10;
const selectedTask = ref<Task | null>(null);
const selectedTaskEvents = ref<TaskEvent[]>([]);
const selectedMemorySlug = ref("");
const selectedMemoryChangeId = ref("");
const memorySearch = ref("");
const memoryChangePathFilter = ref("");
const memoryChangeActionFilter = ref("");
const knowledgeSearch = ref("");
const selectedKnowledgePath = ref("");
const knowledgeDraft = ref("");
const knowledgeEditMode = ref(false);
const taskStatusDraft = ref("");
const taskFollowUpPrompt = ref("");
const taskModalError = ref<string | null>(null);
const approvalEditDrafts = reactive<Record<string, string>>({});

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
const promptForm = reactive({
  prompt: "",
  mode: "normal" as AgentPromptMode,
  contextTaskId: "",
  contextMemoryPath: "",
  contextMessageId: ""
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
let oauthRedirectStarted = false;

const taskStatuses = ["pending", "claimed", "running", "completed", "cancelled", "failed"];
const senderStatuses: Sender["status"][] = ["owner", "newsletter", "trusted", "blocked", "untrusted"];
const promptModes: { value: AgentPromptMode; label: string }[] = [
  { value: "normal", label: "Normal" },
  { value: "planning", label: "Planning" },
  { value: "quick_reply", label: "Quick reply" }
];
const knowledgeRootPaths = ["/personal", "/preferences", "/assistant", "/tasks", "/projects", "/newsletters", "/legacy"];
const activeOutbox = computed(() => outbox.value.filter((message) => ["requires_approval", "pending", "approved", "sending"].includes(message.status)));
const pendingApprovals = computed(() => approvals.value.filter((approval) => approval.status === "pending"));
const approvalInboxCount = computed(() => approvals.value.length);
const outboxHistory = computed(() => outbox.value.filter((message) => ["sent", "failed"].includes(message.status)));
const dashboardMetrics = computed(() => personalDashboard.value?.metrics ?? {
  activeTasks: tasks.value.filter((task) => !["completed", "cancelled", "failed"].includes(task.status)).length,
  pendingApprovals: pendingApprovals.value.length,
  activeThreads: 0,
  recentMemoryChanges: memoryChanges.value.length,
  failedRuns: 0,
  guardrailTrips: 0,
  outboundLast24h: 0,
  outboundLast7d: outbox.value.filter((message) => ["requires_approval", "approved", "pending", "sending", "sent"].includes(message.status)).length
});
const recentAudit = computed(() => audit.value.slice(0, 12));
const agentRunEvents = computed(() => audit.value.filter((event) => event.action.startsWith("agent_run.")).slice(0, 12));
const toolCallEvents = computed(() => audit.value.filter((event) => event.action.startsWith("tool_call.") || event.action.startsWith("mcp.tool_call.")).slice(0, 12));
const ragJobs = computed(() => jobs.value.filter((job) => job.name.toLowerCase().includes("rag") || job.name.toLowerCase().includes("index")));
const canRetryRagJobs = computed(() => auth.user?.isAdmin === true);
const outboxById = computed(() => new Map(outbox.value.map((message) => [message.id, message])));
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
const selectedMemoryDocument = computed(() =>
  memoryDocuments.value.find((document) => document.slug === selectedMemorySlug.value) ?? memoryDocuments.value[0] ?? null
);
const flattenedKnowledgeEntries = computed(() => {
  const entries: KnowledgeEntry[] = [];
  const walk = (nodes: KnowledgeEntry[]) => {
    for (const node of nodes) {
      entries.push(node);
      if (node.children) {
        walk(node.children);
      }
    }
  };
  walk(knowledgeTree.value);
  return entries;
});
const knowledgeFileEntries = computed(() => flattenedKnowledgeEntries.value.filter((entry) => entry.type === "file"));
const knowledgeTreeWithRoots = computed(() => {
  const existingRootNames = new Set(knowledgeTree.value.map((entry) => entry.path));
  const missingRoots = knowledgeRootPaths
    .filter((path) => !existingRootNames.has(path))
    .map((path) => ({ path, name: path.slice(1), type: "directory" as const, children: [] }));
  return [...knowledgeTree.value, ...missingRoots].sort((a, b) => a.type.localeCompare(b.type) || a.path.localeCompare(b.path));
});
const filteredKnowledgeEntries = computed(() => {
  const query = knowledgeSearch.value.trim().toLowerCase();
  if (!query) {
    return knowledgeFileEntries.value;
  }
  const documentMatch = knowledgeDocument.value?.markdown.toLowerCase().includes(query) ? knowledgeDocument.value.path : "";
  return knowledgeFileEntries.value.filter((entry) =>
    entry.path.toLowerCase().includes(query) || entry.name.toLowerCase().includes(query) || entry.path === documentMatch
  );
});
const selectedMessage = computed(() => inbox.value.find((message) => message.id === promptForm.contextMessageId));
const selectedKnowledgeForPrompt = computed(() => knowledgeFileEntries.value.find((entry) => entry.path === promptForm.contextMemoryPath));
const editableKnowledgeDocument = computed(() => Boolean(knowledgeDocument.value?.path.startsWith("/assistant/")));
const filteredMemoryDocuments = computed(() => {
  const query = memorySearch.value.trim().toLowerCase();
  if (!query) {
    return memoryDocuments.value;
  }
  return memoryDocuments.value.filter((document) =>
    [document.title, document.slug, document.body].some((value) => value.toLowerCase().includes(query))
  );
});
const memoryChangeActions = computed(() => [...new Set(memoryChanges.value.map((change) => change.auditAction))].sort());
const selectedMemoryChange = computed(() =>
  memoryChanges.value.find((change) => change.id === selectedMemoryChangeId.value) ?? memoryChanges.value[0] ?? null
);
const memoryHeadings = computed(() => {
  const body = selectedMemoryDocument.value?.body ?? "";
  return body
    .split("\n")
    .filter((line) => /^#{1,3}\s+\S/.test(line))
    .map((line) => line.replace(/^#{1,3}\s+/, "").trim())
    .slice(0, 12);
});
const knowledgeHeadingFallback = computed(() => {
  const body = knowledgeDocument.value?.markdown ?? "";
  return body
    .split("\n")
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^#{1,4}\s+\S/.test(line))
    .map(({ line, index }) => ({
      id: `${knowledgeDocument.value?.id ?? "doc"}-${index}`,
      heading: line.replace(/^#{1,4}\s+/, "").trim(),
      level: line.match(/^#+/)?.[0].length ?? 1,
      lineStart: index + 1
    }))
    .slice(0, 18);
});

function tabFromRoute(value: unknown): TabId {
  const tab = Array.isArray(value) ? value[0] : value;
  return typeof tab === "string" && tabIds.has(tab as TabId) ? tab as TabId : "overview";
}

function applyAiConfig(config: AiConfig | null): void {
  aiConfig.value = config;
  if (!config || aiConfigDirty.value) {
    return;
  }
  Object.assign(configForm, config);
}

function markAiConfigDirty(): void {
  aiConfigDirty.value = true;
}

function applyJobsResponse(response: JobsResponse): void {
  jobs.value = Array.isArray(response.jobs) ? response.jobs : [];
  jobBudgets.value = response.budgets ?? {};
  failedRagJobs.value = response.recentFailures?.ragJobs ?? [];
  ragIndexHealth.value = response.ragIndexHealth ?? [];
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

function formatId(value: string | null | undefined): string {
  if (!value) {
    return "none";
  }
  return value.length > 12 ? `${value.slice(0, 8)}...` : value;
}

function statusTagClass(status: string): string {
  if (["completed", "sent", "approved", "configured", "owner", "trusted", "ok", "healthy"].includes(status)) {
    return "cds--tag--green";
  }
  if (["failed", "blocked", "dead", "degraded"].includes(status)) {
    return "cds--tag--red";
  }
  if (["running", "claimed", "sending", "newsletter", "trusted", "routed_to_agent", "accepted_newsletter", "accepted_trusted", "attention"].includes(status)) {
    return "cds--tag--blue";
  }
  if (["cancelled", "untrusted"].includes(status)) {
    return "cds--tag--gray";
  }
  return "cds--tag--warm-gray";
}

function jobFailedCount(job: JobStatus): number {
  return (job.failedMessages ?? 0) + (job.failedTasks ?? 0) + (job.failedRuns ?? 0) + (job.failedJobs ?? 0) + (job.deadJobs ?? 0) + (job.failedToolCalls ?? 0) + (job.unhealthyCollections ?? 0);
}

function linkedOutbox(message: InboundMessage): OutboxMessage | undefined {
  return message.outboundMessageId ? outboxById.value.get(message.outboundMessageId) : undefined;
}

function inboxActionLabel(message: InboundMessage): string {
  if (message.handlingAction === "queued_owner_review") {
    const linked = linkedOutbox(message);
    if (linked) {
      return `Owner review ${linked.status}`;
    }
    return "Owner review not sent";
  }
  if (message.handlingAction === "routed_to_agent") {
    return "Routed to agent";
  }
  if (message.handlingAction === "accepted_newsletter") {
    return "Accepted newsletter";
  }
  if (message.handlingAction === "sender_reviewed") {
    return "Sender reviewed";
  }
  if (message.handlingAction === "rate_limited") {
    return "Rate limited";
  }
  if (message.handlingAction === "blocked") {
    return "Blocked";
  }
  return "Recorded";
}

function fileTitle(path: string): string {
  const basename = path.split("/").filter(Boolean).at(-1) ?? path;
  return basename.replace(/\.md$/i, "").replace(/[-_]/g, " ");
}

function eventStatus(action: string): string {
  const suffix = action.split(".").at(-1) ?? action;
  return suffix.replace(/_/g, " ");
}

function formatDetails(details: Record<string, unknown>): string {
  if (Object.keys(details).length === 0) {
    return "";
  }
  return JSON.stringify(details, null, 2);
}

function detailRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function compactDetails(details: Record<string, unknown>): string {
  if (Object.keys(details).length === 0) {
    return "";
  }
  const message = typeof details.message === "string" ? details.message : undefined;
  const response = typeof details.response === "string" ? details.response : undefined;
  const error = typeof details.error === "object" && details.error !== null ? details.error as Record<string, unknown> : undefined;
  const errorMessage = typeof error?.message === "string" ? error.message : undefined;
  const errorResponse = typeof error?.response === "string" ? error.response : undefined;
  return response ?? errorResponse ?? message ?? errorMessage ?? JSON.stringify(details);
}

function detailString(details: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = details[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
  }
  return "";
}

function readableGoalSummary(goal: Record<string, unknown>): string {
  const title = typeof goal.title === "string" && goal.title.trim() ? goal.title.trim() : "Untitled goal";
  const status = typeof goal.status === "string" && goal.status.trim() ? goal.status.trim() : "";
  const goalType = typeof goal.goal_type === "string" && goal.goal_type.trim() ? goal.goal_type.trim().replace(/_/g, " ") : "";
  const progress = typeof goal.progress === "number" ? `, ${goal.progress}%` : "";
  const details = [status, goalType].filter(Boolean).join(", ");
  return `${title}${details ? ` (${details}${progress})` : progress ? ` (${progress.slice(2)})` : ""}`;
}

function goalsFromToolResult(toolResult: Record<string, unknown>): Record<string, unknown>[] {
  const data = detailRecord(toolResult.data);
  const rawGoals = data?.goals ?? toolResult.goals;
  return Array.isArray(rawGoals) ? rawGoals.flatMap((goal) => {
    const record = detailRecord(goal);
    return record ? [record] : [];
  }) : [];
}

function agentPromptReply(result: AgentPromptResponse): string {
  if (result.failureMessage) {
    return `I could not complete that: ${result.failureMessage}`;
  }

  if (result.responseText?.trim()) {
    return result.responseText.trim();
  }

  const toolResult = detailRecord(result.toolResult);
  if (!toolResult) {
    return result.status === "completed" ? "Done." : `The agent run finished with status ${result.status}.`;
  }

  const directText = detailString(toolResult, ["response", "message", "summary", "result"]);
  if (directText) {
    return directText;
  }

  if (result.selectedAction === "list_goals") {
    const goals = goalsFromToolResult(toolResult);
    if (goals.length === 0) {
      return "I do not see any goals yet.";
    }
    const shownGoals = goals.slice(0, 8).map((goal) => `- ${readableGoalSummary(goal)}`);
    const suffix = goals.length > shownGoals.length ? `\n\nShowing ${shownGoals.length} of ${goals.length} goals.` : "";
    return `I found ${goals.length} goal${goals.length === 1 ? "" : "s"}:\n${shownGoals.join("\n")}${suffix}`;
  }

  if (result.selectedAction === "create_task" && result.links.taskId) {
    const task = tasks.value.find((candidate) => candidate.id === result.links.taskId);
    return task ? `Created task: ${task.title}` : "Created the task.";
  }

  return result.status === "completed" ? "Done." : `The agent run finished with status ${result.status}.`;
}

function nextChatMessageId(role: ChatMessage["role"]): string {
  chatMessageSequence += 1;
  return `${role}-${chatMessageSequence}`;
}

function chatPromptWithContext(nextPrompt: string): string {
  const recentMessages = chatMessages.value.slice(-12);
  if (recentMessages.length === 0) {
    return nextPrompt;
  }
  const transcript = recentMessages
    .map((message) => `${message.role === "user" ? "Owner" : "Agent"}: ${message.text}`)
    .join("\n\n");
  return [
    "Recent browser chat context:",
    transcript,
    "",
    "Owner's new chat message:",
    nextPrompt,
    "",
    "Answer the new chat message in context. If the owner refers to prior goals, app data, or an earlier answer, use the recent browser chat context instead of repeating the previous lookup unless fresh data is necessary."
  ].join("\n");
}

function promptContextSummary(): string {
  const contextLines: string[] = [];
  if (selectedKnowledgeForPrompt.value) {
    contextLines.push(`Selected memory path: ${selectedKnowledgeForPrompt.value.path}`);
  }
  if (selectedMessage.value) {
    contextLines.push([
      `Selected recent assistant mailbox message: ${selectedMessage.value.id}`,
      `From: ${selectedMessage.value.fromAddr}`,
      `Subject: ${selectedMessage.value.subject ?? "(none)"}`,
      `Excerpt: ${selectedMessage.value.bodyText.replace(/\s+/g, " ").slice(0, 500)}`
    ].join("\n"));
  }
  if (contextLines.length === 0) {
    return promptForm.prompt.trim();
  }
  return [
    "Operator-selected context:",
    contextLines.join("\n\n"),
    "",
    "Prompt:",
    promptForm.prompt.trim()
  ].join("\n");
}

function approvalPayloadText(approval: Approval): string {
  const body = approval.proposedPayload.body_text;
  return typeof body === "string" ? body : "";
}

function approvalActionId(approval: Approval): string {
  const actionId = approval.proposedPayload.action_id;
  return typeof actionId === "string" && actionId.trim() ? actionId : approval.sourceRef || "none";
}

function approvalExecutionSummary(approval: Approval): string {
  if (approval.executionStatus === "succeeded") {
    return formatDetails(approval.executionResult ?? {});
  }
  if (approval.executionStatus === "failed") {
    return approval.executionError || "Execution failed.";
  }
  return approval.executionStatus.replace(/_/g, " ");
}

function memoryChangeSummary(change: MemoryChange): string {
  const added = change.addedLines ?? 0;
  const removed = change.removedLines ?? 0;
  if (added === 0 && removed === 0) {
    return "No line changes";
  }
  return `+${added} / -${removed}`;
}

function linkedChangeRefs(change: MemoryChange): string {
  const refs = [
    change.linkedRunId ? `run ${formatId(change.linkedRunId)}` : "",
    change.linkedToolCallId ? `tool ${formatId(change.linkedToolCallId)}` : "",
    change.linkedTaskId ? `task ${formatId(change.linkedTaskId)}` : "",
    change.linkedMessageId ? `message ${formatId(change.linkedMessageId)}` : "",
    change.linkedApprovalId ? `approval ${formatId(change.linkedApprovalId)}` : "",
    change.linkedOutboxMessageId ? `outbox ${formatId(change.linkedOutboxMessageId)}` : ""
  ].filter(Boolean);
  return refs.length > 0 ? refs.join(" · ") : "none";
}

function isPersonalDashboard(value: unknown): value is PersonalDashboard {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<PersonalDashboard>;
  return Boolean(candidate.metrics) &&
    Array.isArray(candidate.attention) &&
    Array.isArray(candidate.activeTasks) &&
    Array.isArray(candidate.pendingApprovals) &&
    Array.isArray(candidate.recentDecisions) &&
    Array.isArray(candidate.recentMemoryChanges) &&
    Array.isArray(candidate.recentFeedback) &&
    Array.isArray(candidate.activeThreads) &&
    Boolean(candidate.contactCadence) &&
    Array.isArray(candidate.personalLists) &&
    Boolean(candidate.safety);
}

function dashboardChangeSummary(change: PersonalDashboard["recentMemoryChanges"][number]): string {
  const added = change.summary.addedLines ?? 0;
  const removed = change.summary.removedLines ?? 0;
  return `+${added} / -${removed}${change.summary.diffTruncated ? " truncated" : ""}`;
}

function dashboardRefSummary(change: PersonalDashboard["recentMemoryChanges"][number]): string {
  const refs = [
    change.linkedRunId ? `run ${formatId(change.linkedRunId)}` : "",
    change.linkedToolCallId ? `tool ${formatId(change.linkedToolCallId)}` : "",
    change.linkedTaskId ? `task ${formatId(change.linkedTaskId)}` : "",
    change.linkedApprovalId ? `approval ${formatId(change.linkedApprovalId)}` : ""
  ].filter(Boolean);
  return refs.length > 0 ? refs.join(" · ") : "no links";
}

function dashboardProvenanceSummary(change: Pick<MemoryChange, "provenance"> | PersonalDashboard["recentMemoryChanges"][number]): string {
  const provenance = change.provenance;
  if (!provenance) {
    return "provenance unavailable";
  }
  return [
    provenance.confidence,
    provenance.sourceKind.replace(/_/g, " "),
    provenance.durability,
    provenance.sourceLabel
  ].filter(Boolean).join(" · ");
}

async function refreshApprovals(): Promise<void> {
  approvals.value = (await api.listApprovals("pending,approved,rejected,expired")).approvals;
}

function setActiveTab(tabId: TabId): void {
  activeTab.value = tabId;
  void router.replace({ query: { ...route.query, tab: tabId } });
}

function clampPages(): void {
  taskPage.value = Math.min(taskPage.value, totalTaskPages.value);
  inboxPage.value = Math.min(inboxPage.value, totalInboxPages.value);
  outboxPage.value = Math.min(outboxPage.value, totalOutboxPages.value);
  if (!selectedMemorySlug.value && memoryDocuments.value.length > 0) {
    selectedMemorySlug.value = memoryDocuments.value[0]?.slug ?? "";
  }
  if (selectedMemorySlug.value && !memoryDocuments.value.some((document) => document.slug === selectedMemorySlug.value)) {
    selectedMemorySlug.value = memoryDocuments.value[0]?.slug ?? "";
  }
  if (!promptForm.contextTaskId && selectedTask.value) {
    promptForm.contextTaskId = selectedTask.value.id;
  }
  if (promptForm.contextTaskId && !tasks.value.some((task) => task.id === promptForm.contextTaskId)) {
    promptForm.contextTaskId = "";
  }
  if (promptForm.contextMessageId && !inbox.value.some((message) => message.id === promptForm.contextMessageId)) {
    promptForm.contextMessageId = "";
  }
}

async function loadKnowledgeTree(): Promise<void> {
  loadingKnowledge.value = true;
  try {
    const response = await api.getKnowledgeTree("/", 6);
    knowledgeTree.value = Array.isArray(response.entries) ? response.entries : [];
    const firstFile = knowledgeFileEntries.value[0];
    if (!selectedKnowledgePath.value && firstFile) {
      await openKnowledgeFile(firstFile.path);
    } else if (selectedKnowledgePath.value && !knowledgeFileEntries.value.some((entry) => entry.path === selectedKnowledgePath.value)) {
      const fallback = knowledgeFileEntries.value[0];
      selectedKnowledgePath.value = "";
      knowledgeDocument.value = null;
      knowledgeSections.value = [];
      if (fallback) {
        await openKnowledgeFile(fallback.path);
      }
    }
  } catch {
    dashboardError.value = "Unable to load knowledge files.";
  } finally {
    loadingKnowledge.value = false;
  }
}

async function loadMemoryChanges(): Promise<void> {
  const response = await api.listMemoryChanges({
    pathPrefix: memoryChangePathFilter.value || undefined,
    action: memoryChangeActionFilter.value || undefined,
    limit: 50
  });
  memoryChanges.value = Array.isArray(response.changes) ? response.changes : [];
  if (!selectedMemoryChangeId.value && memoryChanges.value.length > 0) {
    selectedMemoryChangeId.value = memoryChanges.value[0]?.id ?? "";
  }
  if (selectedMemoryChangeId.value && !memoryChanges.value.some((change) => change.id === selectedMemoryChangeId.value)) {
    selectedMemoryChangeId.value = memoryChanges.value[0]?.id ?? "";
  }
}

async function openMemoryChangeFile(change: MemoryChange): Promise<void> {
  await openKnowledgeFile(change.path);
}

async function openKnowledgeFile(path: string): Promise<void> {
  selectedKnowledgePath.value = path;
  knowledgeEditMode.value = false;
  try {
    const [documentResponse, sectionsResponse] = await Promise.all([
      api.getKnowledgeFile(path),
      api.listKnowledgeSections(path).catch(() => ({ sections: [] }))
    ]);
    knowledgeDocument.value = documentResponse.document;
    knowledgeDraft.value = documentResponse.document.markdown;
    knowledgeSections.value = sectionsResponse.sections;
    dashboardError.value = null;
  } catch {
    knowledgeDocument.value = null;
    knowledgeSections.value = [];
    dashboardError.value = "Unable to load the selected knowledge file.";
  }
}

async function saveKnowledgeFile(): Promise<void> {
  if (!knowledgeDocument.value || !editableKnowledgeDocument.value) {
    return;
  }
  savingKnowledge.value = true;
  try {
    const response = await api.updateKnowledgeFile(
      knowledgeDocument.value.path,
      knowledgeDraft.value,
      knowledgeDocument.value.version
    );
    knowledgeDocument.value = response.document;
    knowledgeDraft.value = response.document.markdown;
    knowledgeEditMode.value = false;
    await loadKnowledgeTree();
    dashboardError.value = null;
  } catch {
    dashboardError.value = "Unable to save the knowledge file. Reload and try again.";
  } finally {
    savingKnowledge.value = false;
  }
}

function clearChat(): void {
  chatMessages.value = [];
  chatDraft.value = "";
  promptError.value = null;
}

function handleChatKeydown(event: KeyboardEvent): void {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) {
    return;
  }
  event.preventDefault();
  void submitAgentPrompt("chat");
}

async function submitAgentPrompt(source: "overview" | "chat" = "overview"): Promise<void> {
  const prompt = source === "chat" ? chatDraft.value.trim() : promptForm.prompt.trim();
  if (!prompt) {
    return;
  }
  sendingPrompt.value = true;
  promptError.value = null;
  promptResult.value = null;
  const requestPrompt = source === "chat" ? chatPromptWithContext(prompt) : promptContextSummary();
  if (source === "chat") {
    chatMessages.value.push({
      id: nextChatMessageId("user"),
      role: "user",
      text: prompt
    });
    chatDraft.value = "";
  }
  try {
    const result = await api.submitAgentPrompt({
      prompt: requestPrompt,
      mode: source === "chat" ? "normal" : promptForm.mode,
      contextTaskId: source === "chat" ? null : promptForm.contextTaskId || null
    });
    promptResult.value = result;
    if (source === "overview") {
      promptForm.prompt = "";
    }
    await loadDashboard();
    if (source === "chat") {
      chatMessages.value.push({
        id: nextChatMessageId("agent"),
        role: "agent",
        text: agentPromptReply(result)
      });
    }
    if (result.links.taskId) {
      const task = tasks.value.find((candidate) => candidate.id === result.links.taskId);
      if (task) {
        await openTask(task);
      }
    }
  } catch {
    promptError.value = "Unable to send the prompt to the agent.";
    if (source === "chat") {
      chatMessages.value.push({
        id: nextChatMessageId("agent"),
        role: "agent",
        text: "I could not send that message. Try again.",
        status: "error"
      });
    }
  } finally {
    sendingPrompt.value = false;
  }
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
    memoryDocuments.value = data.memory ?? [];
    applyJobsResponse(data.jobs);
    applyConnectors(data.connectors);
    applyAiConfig(data.aiConfig);
    if (activeTab.value === "overview") {
      const insight = await api.getPersonalDashboard().catch(() => null);
      if (isPersonalDashboard(insight)) {
        personalDashboard.value = insight;
      }
    }
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
      case "chat": {
        await Promise.all([
          loadDashboard(),
          knowledgeTree.value.length > 0 ? Promise.resolve() : loadKnowledgeTree()
        ]);
        return;
      }
      case "inbox": {
        const response = await api.listInbox();
        inbox.value = response.messages;
        break;
      }
      case "approvals": {
        await refreshApprovals();
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
      case "memory": {
        const [memoryResponse, senderResponse] = await Promise.all([
          api.listMemory(),
          api.listSenders(),
          loadKnowledgeTree(),
          loadMemoryChanges()
        ]);
        memoryDocuments.value = memoryResponse.documents;
        senders.value = senderResponse.senders;
        break;
      }
      case "senders": {
        const response = await api.listSenders();
        senders.value = response.senders;
        break;
      }
      case "workers": {
        const response = await api.listJobs().catch(() => ({ jobs: [] }));
        applyJobsResponse(response);
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

async function retryRagJob(jobId: string): Promise<void> {
  if (!canRetryRagJobs.value) {
    dashboardError.value = "Administrator access is required to retry RAG index jobs.";
    return;
  }
  retryingRagJobId.value = jobId;
  dashboardError.value = null;
  try {
    await api.retryRagIndexJob(jobId);
    const response = await api.listJobs();
    applyJobsResponse(response);
  } catch {
    dashboardError.value = "Unable to retry the RAG index job.";
  } finally {
    retryingRagJobId.value = null;
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

async function decidePendingApproval(approval: Approval, decision: "approve" | "reject"): Promise<void> {
  try {
    await api.updateApproval(approval.id, { decision });
    await loadDashboard();
    await refreshApprovals();
  } catch {
    dashboardError.value = "Unable to update the approval.";
  }
}

async function editPendingApproval(approval: Approval): Promise<void> {
  const text = (approvalEditDrafts[approval.id] ?? approvalPayloadText(approval)).trim();
  if (!text) {
    return;
  }
  try {
    await api.updateApproval(approval.id, { decision: "edit", text });
    await loadDashboard();
    await refreshApprovals();
  } catch {
    dashboardError.value = "Unable to edit the approval.";
  }
}

async function rejectStaleApprovals(): Promise<void> {
  try {
    await api.rejectStaleApprovals();
    await loadDashboard();
    await refreshApprovals();
  } catch {
    dashboardError.value = "Unable to reject stale approvals.";
  }
}

async function approveInboxOwnerReview(message: InboundMessage): Promise<void> {
  const linked = linkedOutbox(message);
  if (!linked) {
    return;
  }
  await updateOutboxStatus(linked, "approved");
}

async function queueInboxOwnerReview(message: InboundMessage): Promise<void> {
  try {
    await api.queueOwnerReview(message.id);
    await loadDashboard();
  } catch {
    dashboardError.value = "Unable to queue an owner review notification. Check owner contact settings.";
  }
}

async function saveSender(): Promise<void> {
  saving.value = true;
  try {
    const response = await api.setSender(senderForm.address, senderForm.status);
    senders.value = response.senders;
    resetSenderForm();
    dashboardError.value = null;
  } catch {
    dashboardError.value = "Unable to save the sender.";
  } finally {
    saving.value = false;
  }
}

function editSender(sender: Sender): void {
  senderForm.address = sender.address;
  senderForm.status = sender.status;
}

function resetSenderForm(): void {
  senderForm.address = "";
  senderForm.status = "trusted";
}

async function deleteSender(sender: Sender): Promise<void> {
  if (!window.confirm(`Remove ${sender.address} from trusted contacts?`)) {
    return;
  }
  saving.value = true;
  try {
    const response = await api.deleteSender(sender.address);
    senders.value = response.senders;
    if (senderForm.address.trim().toLowerCase() === sender.address.toLowerCase()) {
      resetSenderForm();
    }
    dashboardError.value = null;
  } catch {
    dashboardError.value = "Unable to remove the sender.";
  } finally {
    saving.value = false;
  }
}

async function saveAiConfig(): Promise<void> {
  saving.value = true;
  try {
    const updatedConfig = await api.updateAiConfig({
      fastModel: configForm.fastModel,
      smartModel: configForm.smartModel,
      orchestratorModel: configForm.orchestratorModel,
      repairModel: configForm.repairModel,
      maxToolCalls: Number(configForm.maxToolCalls),
      maxRuntimeSec: Number(configForm.maxRuntimeSec),
      repairAttemptLimit: Number(configForm.repairAttemptLimit)
    });
    aiConfigDirty.value = false;
    applyAiConfig(updatedConfig);
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

async function testImapConfig(): Promise<void> {
  testingImap.value = true;
  imapTestMessage.value = null;
  imapTestError.value = null;
  try {
    await api.updateConnector("imap", imapForm.status, {
      username: imapForm.username,
      password: imapForm.password,
      host: imapForm.host,
      port: Number(imapForm.port),
      secure: imapForm.secure,
      mailbox: imapForm.mailbox
    });
    const connectorResponse = await api.listConnectors();
    applyConnectors(connectorResponse.connectors);
    const result = await api.testImap();
    if (result.ok) {
      imapTestMessage.value = `Connected to ${result.mailbox ?? "INBOX"}. Unread messages: ${result.unseenCount ?? 0}.`;
    } else {
      imapTestError.value = result.error?.response ?? result.error?.message ?? "IMAP test failed.";
    }
    const auditResponse = await api.listAudit();
    audit.value = auditResponse.events;
  } catch {
    imapTestError.value = "Unable to test IMAP settings.";
  } finally {
    testingImap.value = false;
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
  oauthRedirectStarted = true;
  window.location.assign(apiUrl("/auth/login"));
}

function maybeStartFederatedLogin(): void {
  if (
    authMode !== "oauth" ||
    oauthRedirectStarted ||
    auth.loading ||
    !auth.loaded ||
    auth.authenticated ||
    auth.error
  ) {
    return;
  }
  signIn();
}

async function loadAuthenticatedHome(): Promise<void> {
  await loadDashboard();
  if (activeTab.value !== "overview") {
    await loadActiveTab();
  }
}

onMounted(() => {
  if (!auth.loaded) {
    void auth.restore().then(() => {
      maybeStartFederatedLogin();
    });
  } else if (auth.authenticated) {
    void loadAuthenticatedHome();
  }
  maybeStartFederatedLogin();
  startDashboardPolling();
});

watch(() => auth.authenticated, (authenticated) => {
  if (authenticated) {
    void loadAuthenticatedHome();
  }
});

watch(
  () => [auth.loaded, auth.loading, auth.authenticated, auth.error] as const,
  () => {
    maybeStartFederatedLogin();
  },
);

watch(() => route.query.tab, (tab) => {
  const nextTab = tabFromRoute(tab);
  if (nextTab !== activeTab.value) {
    activeTab.value = nextTab;
  }
});

watch(activeTab, () => {
  void loadActiveTab();
});

watch([memoryChangePathFilter, memoryChangeActionFilter], () => {
  if (activeTab.value === "memory" && auth.authenticated) {
    void loadMemoryChanges();
  }
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
      <p>{{ authPanelMessage }}</p>
      <button
        v-if="authMode === 'standalone' || auth.error"
        class="cds--btn cds--btn--primary"
        type="button"
        :disabled="auth.loading"
        @click="signIn"
      >
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
            <p class="label">Active tasks</p>
            <p class="metric-value">{{ dashboardMetrics.activeTasks }}</p>
          </section>
          <section class="metric-card">
            <p class="label">Approvals</p>
            <p class="metric-value">{{ dashboardMetrics.pendingApprovals }}</p>
          </section>
          <section class="metric-card">
            <p class="label">Threads</p>
            <p class="metric-value">{{ dashboardMetrics.activeThreads }}</p>
          </section>
          <section class="metric-card">
            <p class="label">Memory changes</p>
            <p class="metric-value">{{ dashboardMetrics.recentMemoryChanges }}</p>
          </section>
          <section class="metric-card">
            <p class="label">Guardrails / failures</p>
            <p class="metric-value">{{ dashboardMetrics.guardrailTrips }} / {{ dashboardMetrics.failedRuns }}</p>
          </section>
        </div>

        <section class="activity-section prompt-panel" aria-label="Talk to the agent">
          <div class="section-heading">
            <h2>Talk to the agent</h2>
            <p class="label">Authenticated web prompt</p>
          </div>
          <form class="prompt-form" @submit.prevent="submitAgentPrompt('overview')">
            <div class="cds--form-item form-wide">
              <label class="cds--label" for="overview-agent-prompt">Prompt</label>
              <textarea id="overview-agent-prompt" v-model="promptForm.prompt" class="cds--text-area" required rows="4" />
            </div>
            <div class="cds--form-item">
              <label class="cds--label" for="overview-prompt-mode">Mode</label>
              <select id="overview-prompt-mode" v-model="promptForm.mode" class="cds--select-input">
                <option v-for="mode in promptModes" :key="mode.value" :value="mode.value">{{ mode.label }}</option>
              </select>
            </div>
            <div class="cds--form-item">
              <label class="cds--label" for="overview-prompt-task">Task context</label>
              <select id="overview-prompt-task" v-model="promptForm.contextTaskId" class="cds--select-input">
                <option value="">No task</option>
                <option v-for="task in tasks" :key="task.id" :value="task.id">{{ task.title }}</option>
              </select>
            </div>
            <div class="cds--form-item">
              <label class="cds--label" for="overview-prompt-memory">Memory path</label>
              <select id="overview-prompt-memory" v-model="promptForm.contextMemoryPath" class="cds--select-input">
                <option value="">No memory path</option>
                <option v-for="entry in knowledgeFileEntries" :key="entry.path" :value="entry.path">{{ entry.path }}</option>
              </select>
            </div>
            <div class="cds--form-item">
              <label class="cds--label" for="overview-prompt-message">Recent message</label>
              <select id="overview-prompt-message" v-model="promptForm.contextMessageId" class="cds--select-input">
                <option value="">No message</option>
                <option v-for="message in inbox.slice(0, 20)" :key="message.id" :value="message.id">
                  {{ message.fromAddr }} - {{ message.subject || message.bodyText.slice(0, 48) }}
                </option>
              </select>
            </div>
            <div class="form-actions form-wide">
              <button class="cds--btn cds--btn--primary" type="submit" :disabled="sendingPrompt || !promptForm.prompt.trim()">
                Send prompt
              </button>
            </div>
          </form>
          <div v-if="promptError" class="cds--inline-notification cds--inline-notification--error" role="alert">
            <div class="cds--inline-notification__details">
              <div class="cds--inline-notification__text-wrapper">
                <p class="cds--inline-notification__title">Prompt error</p>
                <p class="cds--inline-notification__subtitle">{{ promptError }}</p>
              </div>
            </div>
          </div>
          <div v-if="promptResult" class="prompt-result" role="status">
            <div>
              <p class="label">Run</p>
              <p>{{ promptResult.runId }}</p>
            </div>
            <div>
              <p class="label">Status</p>
              <p><span class="cds--tag" :class="statusTagClass(promptResult.status)">{{ promptResult.status }}</span></p>
            </div>
            <div>
              <p class="label">Action</p>
              <p>{{ promptResult.selectedAction || "none" }} / {{ promptResult.toolStatus }}</p>
            </div>
            <div>
              <p class="label">Links</p>
              <p>
                <span v-if="promptResult.links.taskId">task {{ promptResult.links.taskId }}</span>
                <span v-if="promptResult.links.outboundMessageId"> outbox {{ promptResult.links.outboundMessageId }}</span>
                <span v-if="promptResult.links.memorySlug"> memory {{ promptResult.links.memorySlug }}</span>
                <span v-if="!promptResult.links.taskId && !promptResult.links.outboundMessageId && !promptResult.links.memorySlug">none</span>
              </p>
            </div>
          </div>
        </section>

        <section class="insight-grid" aria-label="Personal assistant insights">
          <article class="activity-section insight-panel">
            <div class="section-heading">
              <h2>Attention queue</h2>
              <p class="label">{{ personalDashboard?.attention.length ?? 0 }} open</p>
            </div>
            <p v-if="!personalDashboard || personalDashboard.attention.length === 0" class="empty">No approvals, blocked work, failed runs, or guardrail trips need attention.</p>
            <ul v-else class="compact-list">
              <li v-for="item in personalDashboard.attention" :key="`${item.kind}-${item.id}`">
                <div>
                  <p class="item-title">{{ item.title }}</p>
                  <p class="label">{{ item.kind }} · {{ formatDate(item.createdAt) }}</p>
                </div>
                <span class="cds--tag" :class="statusTagClass(item.status)">{{ item.status }}</span>
              </li>
            </ul>
          </article>

          <article class="activity-section insight-panel">
            <div class="section-heading">
              <h2>Contact cadence</h2>
              <span class="cds--tag" :class="statusTagClass(personalDashboard?.contactCadence.status ?? 'unknown')">{{ personalDashboard?.contactCadence.status ?? "unknown" }}</span>
            </div>
            <div class="mini-metrics">
              <div>
                <p class="label">24h</p>
                <p class="metric-text">{{ personalDashboard?.contactCadence.ownerVisibleOutboundLast24h ?? dashboardMetrics.outboundLast24h }}</p>
              </div>
              <div>
                <p class="label">7d</p>
                <p class="metric-text">{{ personalDashboard?.contactCadence.ownerVisibleOutboundLast7d ?? dashboardMetrics.outboundLast7d }}</p>
              </div>
              <div>
                <p class="label">Failed</p>
                <p class="metric-text">{{ personalDashboard?.contactCadence.failedOutbound ?? 0 }}</p>
              </div>
            </div>
            <p class="dense-copy">{{ personalDashboard?.contactCadence.guidance ?? "Contact cadence is not available yet." }}</p>
          </article>
        </section>

        <section class="insight-grid insight-grid-wide" aria-label="Operational work surfaces">
          <article class="activity-section insight-panel">
            <div class="section-heading">
              <h2>Active tasks</h2>
              <p class="label">schedule rationale</p>
            </div>
            <p v-if="!personalDashboard || personalDashboard.activeTasks.length === 0" class="empty">No active tasks.</p>
            <ul v-else class="compact-list">
              <li v-for="task in personalDashboard.activeTasks" :key="task.id">
                <div>
                  <p class="item-title">{{ task.title }}</p>
                  <p class="label">{{ task.scheduleRationale || task.waitingOn || task.blockedReason || "No rationale recorded." }}</p>
                  <p class="label">due {{ formatDate(task.dueAt) }} · next review {{ formatDate(task.nextReviewAt) }}</p>
                </div>
                <span class="cds--tag" :class="statusTagClass(task.status)">{{ task.status }}</span>
              </li>
            </ul>
          </article>

          <article class="activity-section insight-panel">
            <div class="section-heading">
              <h2>Approvals</h2>
              <p class="label">pending decisions</p>
            </div>
            <p v-if="!personalDashboard || personalDashboard.pendingApprovals.length === 0" class="empty">No pending approvals.</p>
            <ul v-else class="compact-list">
              <li v-for="approval in personalDashboard.pendingApprovals" :key="approval.id">
                <div>
                  <p class="item-title">{{ approval.summary }}</p>
                  <p class="label">{{ approval.actionType }} · expires {{ formatDate(approval.expiresAt) }}</p>
                </div>
                <span class="cds--tag" :class="statusTagClass(approval.riskLevel)">{{ approval.riskLevel }}</span>
              </li>
            </ul>
          </article>
        </section>

        <section class="insight-grid insight-grid-wide" aria-label="Assistant memory and decision surfaces">
          <article class="activity-section insight-panel">
            <div class="section-heading">
              <h2>Recent decisions</h2>
              <p class="label">ledger</p>
            </div>
            <p v-if="!personalDashboard || personalDashboard.recentDecisions.length === 0" class="empty">No decision ledger entries yet.</p>
            <ul v-else class="compact-list">
              <li v-for="decision in personalDashboard.recentDecisions" :key="decision.path">
                <div>
                  <p class="item-title">{{ decision.title }}</p>
                  <p class="dense-copy">{{ decision.excerpt || decision.path }}</p>
                  <p class="label">{{ decision.path }} · {{ formatDate(decision.updatedAt) }}</p>
                </div>
              </li>
            </ul>
          </article>

          <article class="activity-section insight-panel">
            <div class="section-heading">
              <h2>Memory changes</h2>
              <p class="label">recent diffs</p>
            </div>
            <p v-if="!personalDashboard || personalDashboard.recentMemoryChanges.length === 0" class="empty">No recent memory changes.</p>
            <ul v-else class="compact-list">
              <li v-for="change in personalDashboard.recentMemoryChanges" :key="change.id">
                <div>
                  <p class="item-title">{{ change.path }}</p>
                  <p class="label">{{ change.auditAction }} · {{ dashboardChangeSummary(change) }} · {{ dashboardRefSummary(change) }}</p>
                  <p class="label">{{ dashboardProvenanceSummary(change) }}</p>
                </div>
                <span class="cds--tag" :class="statusTagClass(change.actorType)">{{ change.actorType }}</span>
              </li>
            </ul>
          </article>
        </section>

        <section class="insight-grid insight-grid-wide" aria-label="Conversation and memory list surfaces">
          <article class="activity-section insight-panel">
            <div class="section-heading">
              <h2>Active threads</h2>
              <p class="label">continuity</p>
            </div>
            <p v-if="!personalDashboard || personalDashboard.activeThreads.length === 0" class="empty">No active or waiting threads.</p>
            <ul v-else class="compact-list">
              <li v-for="thread in personalDashboard.activeThreads" :key="thread.id">
                <div>
                  <p class="item-title">{{ thread.title }}</p>
                  <p class="dense-copy">{{ thread.attention }}</p>
                  <p class="label">{{ thread.linkedTaskCount }} tasks · {{ thread.linkedMessageCount }} messages · {{ thread.linkedMemoryCount }} memory paths</p>
                </div>
                <span class="cds--tag" :class="statusTagClass(thread.status)">{{ thread.status }}</span>
              </li>
            </ul>
          </article>

          <article class="activity-section insight-panel">
            <div class="section-heading">
              <h2>Personal lists</h2>
              <p class="label">summaries</p>
            </div>
            <p v-if="!personalDashboard || personalDashboard.personalLists.length === 0" class="empty">No personal lists recorded.</p>
            <ul v-else class="compact-list">
              <li v-for="list in personalDashboard.personalLists" :key="list.path">
                <div>
                  <p class="item-title">{{ list.title }}</p>
                  <p class="dense-copy">{{ list.excerpt || list.path }}</p>
                  <p class="label">{{ list.active }} active · {{ list.archived }} archived · {{ list.total }} total</p>
                </div>
              </li>
            </ul>
          </article>
        </section>

        <section class="insight-grid insight-grid-wide" aria-label="Feedback and safety surfaces">
          <article class="activity-section insight-panel">
            <div class="section-heading">
              <h2>Owner feedback</h2>
              <p class="label">training signal</p>
            </div>
            <p v-if="!personalDashboard || personalDashboard.recentFeedback.length === 0" class="empty">No recent owner feedback.</p>
            <ul v-else class="compact-list">
              <li v-for="feedback in personalDashboard.recentFeedback" :key="feedback.path">
                <div>
                  <p class="item-title">{{ feedback.title }}</p>
                  <p class="dense-copy">{{ feedback.excerpt || feedback.path }}</p>
                  <p class="label">{{ feedback.path }} · {{ formatDate(feedback.updatedAt) }}</p>
                </div>
              </li>
            </ul>
          </article>

          <article class="activity-section insight-panel">
            <div class="section-heading">
              <h2>Guardrails and failed runs</h2>
              <p class="label">safety</p>
            </div>
            <p v-if="!personalDashboard || (personalDashboard.safety.guardrails.length === 0 && personalDashboard.safety.failedRuns.length === 0 && personalDashboard.safety.failedToolCalls.length === 0 && personalDashboard.safety.failedOutbound.length === 0)" class="empty">No guardrail trips or failed runs.</p>
            <ul v-else class="compact-list">
              <li v-for="event in personalDashboard.safety.guardrails" :key="`guardrail-${event.id}`">
                <div>
                  <p class="item-title">{{ event.summary }}</p>
                  <p class="label">guardrail · {{ formatDate(event.createdAt) }}</p>
                </div>
              </li>
              <li v-for="run in personalDashboard.safety.failedRuns" :key="`run-${run.id}`">
                <div>
                  <p class="item-title">{{ run.failureMessage || "Agent run failed." }}</p>
                  <p class="label">run {{ formatId(run.id) }} · {{ run.modelTier }} · {{ formatDate(run.startedAt) }}</p>
                </div>
              </li>
              <li v-for="tool in personalDashboard.safety.failedToolCalls" :key="`tool-${tool.id}`">
                <div>
                  <p class="item-title">{{ tool.toolName }}</p>
                  <p class="label">{{ tool.status }} · {{ tool.validationError || "No validation message." }}</p>
                </div>
              </li>
              <li v-for="message in personalDashboard.safety.failedOutbound" :key="`outbound-${message.id}`">
                <div>
                  <p class="item-title">{{ message.failureMessage || "Outbound delivery failed." }}</p>
                  <p class="label">{{ message.channel }} · {{ formatDate(message.updatedAt) }}</p>
                </div>
              </li>
            </ul>
          </article>
        </section>

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

      <section v-show="activeTab === 'chat'" id="panel-chat" class="tab-panel" role="tabpanel" aria-labelledby="tab-chat">
        <section class="activity-section chat-panel" aria-label="Agent chat">
          <div class="section-heading chat-heading">
            <h2>Agent chat</h2>
            <button class="cds--btn cds--btn--secondary cds--btn--sm" type="button" :disabled="chatMessages.length === 0 && !chatDraft.trim()" @click="clearChat">
              Clear chat
            </button>
          </div>
          <div class="chat-thread" role="log" aria-live="polite" aria-label="Conversation">
            <p v-if="chatMessages.length === 0" class="chat-empty">No messages yet.</p>
            <article
              v-for="message in chatMessages"
              :key="message.id"
              class="chat-message"
              :class="[`chat-message--${message.role}`, { 'chat-message--error': message.status === 'error' }]"
            >
              <p class="chat-message__author">{{ message.role === "user" ? "You" : "Agent" }}</p>
              <p class="chat-message__body">{{ message.text }}</p>
            </article>
            <article v-if="sendingPrompt" class="chat-message chat-message--agent">
              <p class="chat-message__author">Agent</p>
              <p class="chat-message__body">Thinking...</p>
            </article>
          </div>
          <form class="chat-composer" @submit.prevent="submitAgentPrompt('chat')">
            <label class="cds--visually-hidden" for="chat-agent-prompt">Message</label>
            <textarea
              id="chat-agent-prompt"
              v-model="chatDraft"
              class="cds--text-area"
              required
              rows="3"
              placeholder="Message the agent"
              @keydown="handleChatKeydown"
            />
            <div class="chat-composer__actions">
              <button class="cds--btn cds--btn--primary" type="submit" :disabled="sendingPrompt || !chatDraft.trim()">
                Send
              </button>
            </div>
          </form>
        </section>
      </section>

      <section v-show="activeTab === 'inbox'" id="panel-inbox" class="tab-panel" role="tabpanel" aria-labelledby="tab-inbox">
        <section class="activity-section" aria-label="Agent inbox">
          <div class="section-heading">
            <h2>Agent Inbox</h2>
            <p class="label">{{ inbox.length }} messages</p>
          </div>
          <p v-if="inbox.length === 0" class="empty">No messages received by the assistant mailbox.</p>
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
                  <td>
                    <div class="table-actions">
                      <span>{{ inboxActionLabel(message) }}</span>
                      <button
                        v-if="message.handlingAction === 'queued_owner_review' && !message.outboundMessageId"
                        class="cds--btn cds--btn--sm cds--btn--primary"
                        type="button"
                        @click="queueInboxOwnerReview(message)"
                      >
                        Notify owner
                      </button>
                      <button
                        v-if="linkedOutbox(message)?.status === 'requires_approval'"
                        class="cds--btn cds--btn--sm cds--btn--primary"
                        type="button"
                        @click="approveInboxOwnerReview(message)"
                      >
                        Approve
                      </button>
                    </div>
                  </td>
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

      <section v-show="activeTab === 'approvals'" id="panel-approvals" class="tab-panel" role="tabpanel" aria-labelledby="tab-approvals">
        <section class="activity-section" aria-label="Approval inbox">
          <div class="section-heading">
            <div>
              <h2>Approval inbox</h2>
              <p class="label">{{ pendingApprovals.length }} pending / {{ approvalInboxCount }} recent</p>
            </div>
            <button class="cds--btn cds--btn--sm cds--btn--secondary" type="button" @click="rejectStaleApprovals">
              Reject stale
            </button>
          </div>
          <p v-if="approvals.length === 0" class="empty">No approvals.</p>
          <div v-else class="approval-list">
            <article v-for="approval in approvals" :key="approval.id" class="approval-item">
              <div class="approval-header">
                <div>
                  <p class="label">{{ approval.actionType }} / {{ approval.riskLevel }}</p>
                  <h3>{{ approval.summary }}</h3>
                </div>
                <span class="cds--tag" :class="statusTagClass(approval.status)">{{ approval.status }}</span>
              </div>
              <dl class="detail-list compact-details">
                <div>
                  <dt>Run</dt>
                  <dd>{{ approval.sourceRunId || "none" }}</dd>
                </div>
                <div>
                  <dt>Source</dt>
                  <dd>{{ approval.sourceRef || "none" }}</dd>
                </div>
                <div v-if="approval.actionType === 'cross_app_write_action'">
                  <dt>Action</dt>
                  <dd>{{ approvalActionId(approval) }}</dd>
                </div>
                <div v-if="approval.actionType === 'cross_app_write_action'">
                  <dt>Execution</dt>
                  <dd>{{ approval.executionStatus }}</dd>
                </div>
                <div>
                  <dt>Expires</dt>
                  <dd>{{ formatDate(approval.expiresAt) }}</dd>
                </div>
              </dl>
              <pre>{{ formatDetails(approval.proposedPayload) }}</pre>
              <pre v-if="approval.actionType === 'cross_app_write_action' && approval.executionStatus !== 'not_applicable'">{{ approvalExecutionSummary(approval) }}</pre>
              <div v-if="approval.status === 'pending' && approval.actionType === 'send_outbound_message'" class="cds--form-item">
                <label class="cds--label" :for="`approval-edit-${approval.id}`">Edited message</label>
                <textarea
                  :id="`approval-edit-${approval.id}`"
                  v-model="approvalEditDrafts[approval.id]"
                  class="cds--text-area"
                  rows="3"
                  :placeholder="approvalPayloadText(approval)"
                />
              </div>
              <div v-if="approval.status === 'pending'" class="table-actions">
                <button class="cds--btn cds--btn--sm cds--btn--primary" type="button" @click="decidePendingApproval(approval, 'approve')">
                  Approve
                </button>
                <button v-if="approval.actionType === 'send_outbound_message'" class="cds--btn cds--btn--sm cds--btn--secondary" type="button" @click="editPendingApproval(approval)">
                  Save edit
                </button>
                <button class="cds--btn cds--btn--sm cds--btn--danger--tertiary" type="button" @click="decidePendingApproval(approval, 'reject')">
                  Reject
                </button>
              </div>
            </article>
          </div>
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

      <section v-show="activeTab === 'memory'" id="panel-memory" class="tab-panel" role="tabpanel" aria-labelledby="tab-memory">
        <section class="activity-section" aria-label="Trusted contacts">
          <div class="section-heading">
            <h2>Trusted contacts</h2>
            <p class="label">{{ senders.length }} entries</p>
          </div>
          <form class="form-grid sender-form contact-form" @submit.prevent="saveSender">
            <div class="cds--form-item">
              <label class="cds--label" for="memory-sender-address">Address</label>
              <input id="memory-sender-address" v-model="senderForm.address" class="cds--text-input" required type="email">
            </div>
            <div class="cds--form-item">
              <label class="cds--label" for="memory-sender-status">Status</label>
              <select id="memory-sender-status" v-model="senderForm.status" class="cds--select-input">
                <option v-for="status in senderStatuses" :key="status" :value="status">{{ status }}</option>
              </select>
            </div>
            <div class="form-actions">
              <button class="cds--btn cds--btn--primary" type="submit" :disabled="saving">
                Save contact
              </button>
              <button class="cds--btn cds--btn--ghost" type="button" :disabled="saving" @click="resetSenderForm">
                Clear
              </button>
            </div>
          </form>
          <p v-if="senders.length === 0" class="empty">No trusted contacts configured.</p>
          <table v-else class="cds--data-table cds--data-table--zebra contact-table">
            <thead>
              <tr>
                <th>Address</th>
                <th>Status</th>
                <th>Updated</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="sender in senders" :key="sender.id">
                <td>{{ sender.address }}</td>
                <td>
                  <span class="cds--tag" :class="statusTagClass(sender.status)">{{ sender.status }}</span>
                </td>
                <td>{{ formatDate(sender.updatedAt) }}</td>
                <td>
                  <div class="table-actions">
                    <button class="cds--btn cds--btn--sm cds--btn--ghost" type="button" @click="editSender(sender)">
                      Edit
                    </button>
                    <button class="cds--btn cds--btn--sm cds--btn--danger--ghost" type="button" @click="deleteSender(sender)">
                      Remove
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </section>
        <section class="activity-section" aria-label="Recent memory changes">
          <div class="section-heading">
            <h2>Recent memory changes</h2>
            <p class="label">{{ memoryChanges.length }} changes</p>
          </div>
          <div class="form-grid compact-filter-form">
            <div class="cds--form-item">
              <label class="cds--label" for="memory-change-path-filter">Path prefix</label>
              <select id="memory-change-path-filter" v-model="memoryChangePathFilter" class="cds--select-input">
                <option value="">All paths</option>
                <option v-for="path in knowledgeRootPaths" :key="path" :value="path">{{ path }}</option>
              </select>
            </div>
            <div class="cds--form-item">
              <label class="cds--label" for="memory-change-action-filter">Source action</label>
              <select id="memory-change-action-filter" v-model="memoryChangeActionFilter" class="cds--select-input">
                <option value="">All actions</option>
                <option v-for="action in memoryChangeActions" :key="action" :value="action">{{ action }}</option>
              </select>
            </div>
            <div class="form-actions">
              <button class="cds--btn cds--btn--secondary" type="button" @click="loadMemoryChanges">
                Refresh changes
              </button>
            </div>
          </div>
          <p v-if="memoryChanges.length === 0" class="empty">No memory changes recorded yet.</p>
          <div v-else class="memory-change-layout">
            <aside class="memory-list" aria-label="Recent memory change feed">
              <button
                v-for="change in memoryChanges"
                :key="change.id"
                class="memory-list-item"
                :class="{ 'is-selected': selectedMemoryChange?.id === change.id }"
                type="button"
                @click="selectedMemoryChangeId = change.id"
              >
                <span class="memory-title">{{ fileTitle(change.path) }}</span>
                <span class="label">{{ change.path }}</span>
                <span class="label">{{ change.auditAction }} · {{ change.actorType }} · {{ memoryChangeSummary(change) }}</span>
                <span class="label">{{ formatDate(change.createdAt) }}</span>
              </button>
            </aside>
            <article v-if="selectedMemoryChange" class="memory-document">
              <header class="memory-document-header">
                <div>
                  <p class="label">{{ selectedMemoryChange.auditAction }} / {{ selectedMemoryChange.actorType }}</p>
                  <h3>{{ selectedMemoryChange.path }}</h3>
                </div>
                <div class="memory-document-actions">
                  <span class="label">
                    v{{ selectedMemoryChange.previousVersion ?? 0 }} -> v{{ selectedMemoryChange.documentVersion ?? "?" }}
                  </span>
                  <button class="cds--btn cds--btn--sm cds--btn--secondary" type="button" @click="openMemoryChangeFile(selectedMemoryChange)">
                    Read file
                  </button>
                </div>
              </header>
              <dl class="detail-list compact-details">
                <div>
                  <dt>Changed</dt>
                  <dd>{{ formatDate(selectedMemoryChange.createdAt) }}</dd>
                </div>
                <div>
                  <dt>Lines</dt>
                  <dd>{{ memoryChangeSummary(selectedMemoryChange) }}</dd>
                </div>
                <div>
                  <dt>Linked ids</dt>
                  <dd>{{ linkedChangeRefs(selectedMemoryChange) }}</dd>
                </div>
                <div>
                  <dt>Provenance</dt>
                  <dd>{{ dashboardProvenanceSummary(selectedMemoryChange) }}</dd>
                </div>
                <div v-if="selectedMemoryChange.snapshotTruncated || selectedMemoryChange.diffTruncated">
                  <dt>Bounds</dt>
                  <dd>{{ selectedMemoryChange.snapshotTruncated ? "Snapshot truncated" : "" }} {{ selectedMemoryChange.diffTruncated ? "Diff truncated" : "" }}</dd>
                </div>
              </dl>
              <pre class="memory-body diff-body">{{ selectedMemoryChange.unifiedDiff || selectedMemoryChange.afterMarkdown || "No diff available for this audit event." }}</pre>
            </article>
          </div>
        </section>
        <section class="activity-section" aria-label="Agent memory">
          <div class="section-heading">
            <h2>Memory and knowledge</h2>
            <p class="label">{{ knowledgeFileEntries.length }} markdown files</p>
          </div>
          <div class="cds--form-item">
            <label class="cds--label" for="memory-search">Exact search</label>
            <input id="memory-search" v-model="knowledgeSearch" class="cds--text-input" type="search" placeholder="Search paths and the selected file body">
          </div>
          <p v-if="loadingKnowledge" class="empty">Loading knowledge files...</p>
          <div class="memory-browser">
            <aside class="memory-list" aria-label="Knowledge tree">
              <div v-for="root in knowledgeTreeWithRoots" :key="root.path" class="knowledge-root">
                <p class="label">{{ root.path }}</p>
                <button
                  v-for="entry in flattenedKnowledgeEntries.filter((candidate) => candidate.type === 'file' && candidate.path.startsWith(`${root.path}/`))"
                  :key="entry.path"
                  class="memory-list-item"
                  :class="{ 'is-selected': selectedKnowledgePath === entry.path }"
                  type="button"
                  @click="openKnowledgeFile(entry.path)"
                >
                  <span class="memory-title">{{ fileTitle(entry.path) }}</span>
                  <span class="label">{{ entry.path }}</span>
                  <span class="label">v{{ entry.version ?? "?" }} · {{ formatDate(entry.updatedAt) }}</span>
                </button>
              </div>
              <p v-if="knowledgeFileEntries.length === 0" class="empty">No markdown knowledge files yet.</p>
            </aside>
            <article class="memory-document">
              <template v-if="knowledgeDocument">
                <header class="memory-document-header">
                  <div>
                    <p class="label">{{ knowledgeDocument.path }}</p>
                    <h3>{{ knowledgeDocument.title || knowledgeDocument.basename }}</h3>
                  </div>
                  <div class="memory-document-actions">
                    <span class="cds--tag" :class="statusTagClass(knowledgeDocument.indexStatus)">
                      {{ knowledgeDocument.indexStatus }}
                    </span>
                    <span class="label">v{{ knowledgeDocument.version }} · {{ formatDate(knowledgeDocument.updatedAt) }}</span>
                    <button
                      v-if="editableKnowledgeDocument && !knowledgeEditMode"
                      class="cds--btn cds--btn--sm cds--btn--secondary"
                      type="button"
                      @click="knowledgeEditMode = true"
                    >
                      Edit
                    </button>
                  </div>
                </header>
                <div class="knowledge-layout">
                  <aside class="memory-outline" aria-label="Heading outline">
                    <p class="label">Outline</p>
                    <span
                      v-for="section in knowledgeSections.length > 0 ? knowledgeSections : knowledgeHeadingFallback"
                      :key="section.id"
                      class="cds--tag cds--tag--blue"
                      :style="{ marginLeft: `${Math.max(0, (section.level - 1) * 8)}px` }"
                    >
                      {{ section.heading }}
                    </span>
                    <p v-if="knowledgeSections.length === 0 && knowledgeHeadingFallback.length === 0" class="empty">No headings.</p>
                  </aside>
                  <div class="knowledge-preview">
                    <template v-if="knowledgeEditMode">
                      <label class="cds--label" for="knowledge-draft">Markdown</label>
                      <textarea id="knowledge-draft" v-model="knowledgeDraft" class="cds--text-area knowledge-editor" rows="18" />
                      <div class="form-actions">
                        <button class="cds--btn cds--btn--primary" type="button" :disabled="savingKnowledge" @click="saveKnowledgeFile">
                          Save file
                        </button>
                        <button class="cds--btn cds--btn--ghost" type="button" :disabled="savingKnowledge" @click="knowledgeEditMode = false; knowledgeDraft = knowledgeDocument?.markdown ?? ''">
                          Cancel
                        </button>
                      </div>
                    </template>
                    <pre v-else class="memory-body">{{ knowledgeDocument.markdown }}</pre>
                  </div>
                </div>
              </template>
              <p v-else class="empty">Select a memory or knowledge file.</p>
            </article>
          </div>
          <section class="memory-search-results" aria-label="Memory search results">
            <div class="section-heading">
              <h3>Search results</h3>
              <p class="label">{{ filteredKnowledgeEntries.length }} files</p>
            </div>
            <div class="search-result-list">
              <button
                v-for="entry in filteredKnowledgeEntries"
                :key="entry.path"
                class="link-button"
                type="button"
                @click="openKnowledgeFile(entry.path)"
              >
                {{ entry.path }}
              </button>
              <p v-if="filteredKnowledgeEntries.length === 0" class="empty">No matching knowledge files.</p>
            </div>
          </section>
        </section>

        <section v-if="memoryDocuments.length > 0" class="activity-section" aria-label="Legacy memory records">
          <div class="section-heading">
            <h2>Legacy memory records</h2>
            <p class="label">{{ memoryDocuments.length }} documents</p>
          </div>
          <div class="cds--form-item">
            <label class="cds--label" for="legacy-memory-search">Search legacy memory</label>
            <input id="legacy-memory-search" v-model="memorySearch" class="cds--text-input" type="search" placeholder="Search titles, slugs, and body text">
          </div>
          <div class="memory-browser">
            <aside class="memory-list" aria-label="Legacy memory documents">
              <button
                v-for="document in filteredMemoryDocuments"
                :key="document.id"
                class="memory-list-item"
                :class="{ 'is-selected': selectedMemoryDocument?.slug === document.slug }"
                type="button"
                @click="selectedMemorySlug = document.slug"
              >
                <span class="memory-title">{{ document.title }}</span>
                <span class="label">{{ document.slug }}</span>
                <span class="label">Updated {{ formatDate(document.updatedAt) }}</span>
              </button>
              <p v-if="filteredMemoryDocuments.length === 0" class="empty">No matching memory documents.</p>
            </aside>
            <article v-if="selectedMemoryDocument" class="memory-document">
              <header class="memory-document-header">
                <div>
                  <p class="label">{{ selectedMemoryDocument.slug }}</p>
                  <h3>{{ selectedMemoryDocument.title }}</h3>
                </div>
                <p class="label">Updated {{ formatDate(selectedMemoryDocument.updatedAt) }}</p>
              </header>
              <div v-if="memoryHeadings.length > 0" class="memory-outline" aria-label="Document outline">
                <span v-for="heading in memoryHeadings" :key="heading" class="cds--tag cds--tag--blue">{{ heading }}</span>
              </div>
              <pre class="memory-body">{{ selectedMemoryDocument.body }}</pre>
            </article>
          </div>
        </section>
      </section>

      <section v-show="activeTab === 'senders'" id="panel-senders" class="tab-panel" role="tabpanel" aria-labelledby="tab-senders">
        <section class="activity-section" aria-label="Sender trust">
          <div class="section-heading">
            <h2>Sender trust</h2>
          </div>
          <form class="form-grid sender-form contact-form" @submit.prevent="saveSender">
            <div class="cds--form-item">
              <label class="cds--label" for="sender-address">Address</label>
              <input id="sender-address" v-model="senderForm.address" class="cds--text-input" required type="email">
            </div>
            <div class="cds--form-item">
              <label class="cds--label" for="sender-status">Status</label>
              <select id="sender-status" v-model="senderForm.status" class="cds--select-input">
                <option v-for="status in senderStatuses" :key="status" :value="status">{{ status }}</option>
              </select>
            </div>
            <div class="form-actions">
              <button class="cds--btn cds--btn--primary" type="submit" :disabled="saving">
                Save sender
              </button>
              <button class="cds--btn cds--btn--ghost" type="button" :disabled="saving" @click="resetSenderForm">
                Clear
              </button>
            </div>
          </form>
          <p v-if="senders.length === 0" class="empty">No senders configured.</p>
          <table v-else class="cds--data-table cds--data-table--zebra contact-table">
            <thead>
              <tr>
                <th>Address</th>
                <th>Status</th>
                <th>Updated</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="sender in senders" :key="sender.id">
                <td>{{ sender.address }}</td>
                <td>
                  <span class="cds--tag" :class="statusTagClass(sender.status)">{{ sender.status }}</span>
                </td>
                <td>{{ formatDate(sender.updatedAt) }}</td>
                <td>
                  <div class="table-actions">
                    <button class="cds--btn cds--btn--sm cds--btn--ghost" type="button" @click="editSender(sender)">
                      Edit
                    </button>
                    <button class="cds--btn cds--btn--sm cds--btn--danger--ghost" type="button" @click="deleteSender(sender)">
                      Remove
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      </section>

      <section v-show="activeTab === 'workers'" id="panel-workers" class="tab-panel" role="tabpanel" aria-labelledby="tab-workers">
        <section class="activity-section" aria-label="RAG index status">
          <div class="section-heading">
            <h2>RAG and index status</h2>
            <p class="label">{{ knowledgeDocument ? knowledgeDocument.path : "No file selected" }}</p>
          </div>
          <div class="metric-grid status-grid">
            <section class="metric-card">
              <p class="label">Selected file</p>
              <p class="metric-value metric-text">{{ knowledgeDocument?.indexStatus ?? "unknown" }}</p>
            </section>
            <section class="metric-card">
              <p class="label">Markdown files</p>
              <p class="metric-value">{{ knowledgeFileEntries.length }}</p>
            </section>
            <section class="metric-card">
              <p class="label">Index jobs</p>
              <p class="metric-value">{{ ragJobs.length }}</p>
            </section>
            <section class="metric-card">
              <p class="label">MCP calls/run</p>
              <p class="metric-value">{{ jobBudgets.maxToolCallsPerRun ?? "set in admin" }}</p>
            </section>
            <section class="metric-card">
              <p class="label">Runs/hour</p>
              <p class="metric-value">{{ jobBudgets.maxAgentRunsPerUserPerHour ?? "default" }}</p>
            </section>
            <section class="metric-card">
              <p class="label">Owner messages/day</p>
              <p class="metric-value">{{ jobBudgets.maxOwnerVisibleOutboundMessagesPerUserPerDay ?? "default" }}</p>
            </section>
            <section class="metric-card">
              <p class="label">Outbound/tick</p>
              <p class="metric-value">{{ jobBudgets.outboundMessagesPerWorkerTick ?? "default" }}</p>
            </section>
            <section class="metric-card">
              <p class="label">Run budget</p>
              <p class="metric-value">{{ jobBudgets.maxRuntimeSecPerRun !== undefined ? `${jobBudgets.maxRuntimeSecPerRun}s` : "set in admin" }}</p>
            </section>
            <section class="metric-card">
              <p class="label">RAG result cap</p>
              <p class="metric-value">{{ jobBudgets.maxRagSearchResultsPerCall ?? 25 }}</p>
            </section>
          </div>
          <p v-if="ragIndexHealth.length === 0" class="empty">No Qdrant collection health has been recorded yet.</p>
          <table v-else class="cds--data-table cds--data-table--zebra">
            <thead>
              <tr>
                <th>Collection</th>
                <th>Status</th>
                <th>Expected docs</th>
                <th>Expected chunks</th>
                <th>Qdrant points</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="health in ragIndexHealth" :key="health.userId">
                <td>{{ formatId(health.qdrantCollection) }}</td>
                <td><span class="cds--tag" :class="statusTagClass(health.healthStatus)">{{ health.healthStatus }}</span></td>
                <td>{{ health.expectedDocumentCount }}</td>
                <td>{{ health.expectedChunkCount }}</td>
                <td>{{ health.qdrantPointCount ?? "unknown" }}</td>
                <td>{{ formatDate(health.updatedAt) }}</td>
              </tr>
            </tbody>
          </table>
          <p v-if="ragJobs.length === 0" class="empty">No index worker status rows are available.</p>
          <table v-else class="cds--data-table cds--data-table--zebra">
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Pending</th>
                <th>Failed</th>
                <th>Last audit</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="job in ragJobs" :key="job.name">
                <td>{{ job.name }}</td>
                <td><span class="cds--tag" :class="statusTagClass(job.status)">{{ job.status }}</span></td>
                <td>{{ job.pendingJobs ?? job.pendingTasks ?? job.pendingMessages ?? 0 }}</td>
                <td>{{ jobFailedCount(job) }}</td>
                <td>{{ formatDate(job.lastAuditAt) }}</td>
              </tr>
            </tbody>
          </table>
          <p v-if="failedRagJobs.length === 0" class="empty">No failed RAG index jobs need manual retry.</p>
          <table v-else class="cds--data-table cds--data-table--zebra">
            <thead>
              <tr>
                <th>Job</th>
                <th>Status</th>
                <th>Attempts</th>
                <th>Error</th>
                <th>Created</th>
                <th>Retry</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="job in failedRagJobs" :key="job.id">
                <td>{{ formatId(job.id) }}</td>
                <td><span class="cds--tag" :class="statusTagClass(job.status)">{{ job.status }}</span></td>
                <td>{{ job.attempts }}</td>
                <td>{{ job.lastError ?? "No error recorded" }}</td>
                <td>{{ formatDate(job.createdAt) }}</td>
                <td>
                  <button v-if="canRetryRagJobs" class="cds--btn cds--btn--sm cds--btn--secondary" type="button" :disabled="retryingRagJobId === job.id" @click="retryRagJob(job.id)">
                    Retry
                  </button>
                  <span v-if="!canRetryRagJobs" class="label">Admin only</span>
                </td>
              </tr>
            </tbody>
          </table>
        </section>

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
                <td>{{ job.pendingJobs ?? job.pendingApprovals ?? job.pendingTasks ?? job.pendingMessages ?? 0 }}</td>
                <td>{{ job.dueTasks ?? 0 }}</td>
                <td>{{ jobFailedCount(job) }}</td>
                <td>{{ formatDate(job.lastAuditAt) }}</td>
              </tr>
            </tbody>
          </table>
        </section>
      </section>

      <section v-show="activeTab === 'logs'" id="panel-logs" class="tab-panel" role="tabpanel" aria-labelledby="tab-logs">
        <section class="activity-section" aria-label="Agent runs">
          <div class="section-heading">
            <h2>Agent runs</h2>
            <p class="label">{{ agentRunEvents.length }} recent events</p>
          </div>
          <p v-if="agentRunEvents.length === 0" class="empty">No agent run events.</p>
          <table v-else class="cds--data-table cds--data-table--zebra">
            <thead>
              <tr>
                <th>Run</th>
                <th>Status</th>
                <th>Model</th>
                <th>Prompt</th>
                <th>Linked source</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="event in agentRunEvents" :key="event.id">
                <td>{{ formatId(event.entityId) }}</td>
                <td><span class="cds--tag" :class="statusTagClass(eventStatus(event.action))">{{ eventStatus(event.action) }}</span></td>
                <td>{{ detailString(event.details ?? {}, ["model_id", "model", "modelTier", "model_tier"]) || "unknown" }}</td>
                <td>{{ detailString(event.details ?? {}, ["prompt_version", "promptVersion"]) || "unknown" }}</td>
                <td>{{ detailString(event.details ?? {}, ["task_id", "message_id", "memory_path", "source"]) || "none" }}</td>
                <td>{{ formatDate(event.createdAt) }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section class="activity-section" aria-label="Tool calls">
          <div class="section-heading">
            <h2>Tool calls</h2>
            <p class="label">{{ toolCallEvents.length }} recent events</p>
          </div>
          <p v-if="toolCallEvents.length === 0" class="empty">No tool-call events.</p>
          <table v-else class="cds--data-table cds--data-table--zebra">
            <thead>
              <tr>
                <th>Tool</th>
                <th>Status</th>
                <th>Run</th>
                <th>Side effect</th>
                <th>Summary</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="event in toolCallEvents" :key="event.id">
                <td>{{ detailString(event.details ?? {}, ["tool_name", "toolName", "tool"]) || event.entityId || "unknown" }}</td>
                <td><span class="cds--tag" :class="statusTagClass(eventStatus(event.action))">{{ eventStatus(event.action) }}</span></td>
                <td>{{ formatId(detailString(event.details ?? {}, ["run_id", "runId"]) || event.entityId) }}</td>
                <td>{{ detailString(event.details ?? {}, ["side_effect", "sideEffect", "sideEffectClass"]) || "unknown" }}</td>
                <td><span class="table-copy">{{ compactDetails(event.details ?? {}) || "none" }}</span></td>
                <td>{{ formatDate(event.createdAt) }}</td>
              </tr>
            </tbody>
          </table>
        </section>

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
                <th>Details</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="event in recentAudit" :key="event.id">
                <td>{{ event.action }}</td>
                <td>{{ event.entityType || "none" }} {{ event.entityId || "" }}</td>
                <td>
                  <span class="table-copy">{{ compactDetails(event.details ?? {}) || "none" }}</span>
                </td>
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
                <button class="cds--btn cds--btn--secondary" type="button" :disabled="testingImap" @click="testImapConfig">
                  Test IMAP
                </button>
              </div>
              <div v-if="imapTestMessage || imapTestError" class="form-wide">
                <div v-if="imapTestMessage" class="cds--inline-notification cds--inline-notification--success" role="status">
                  <div class="cds--inline-notification__details">
                    <div class="cds--inline-notification__text-wrapper">
                      <p class="cds--inline-notification__title">IMAP test passed</p>
                      <p class="cds--inline-notification__subtitle">{{ imapTestMessage }}</p>
                    </div>
                  </div>
                </div>
                <div v-if="imapTestError" class="cds--inline-notification cds--inline-notification--error" role="alert">
                  <div class="cds--inline-notification__details">
                    <div class="cds--inline-notification__text-wrapper">
                      <p class="cds--inline-notification__title">IMAP test failed</p>
                      <p class="cds--inline-notification__subtitle">{{ imapTestError }}</p>
                    </div>
                  </div>
                </div>
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
          <form class="form-grid config-form" @submit.prevent="saveAiConfig" @input="markAiConfigDirty">
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
            <h3>Schedule intelligence</h3>
            <dl class="task-detail-grid">
              <div>
                <dt>Rationale</dt>
                <dd>{{ selectedTask?.scheduleRationale || "Not recorded" }}</dd>
              </div>
              <div>
                <dt>Next review</dt>
                <dd>{{ formatDate(selectedTask?.nextReviewAt) }}</dd>
              </div>
              <div>
                <dt>Last agent review</dt>
                <dd>{{ formatDate(selectedTask?.lastAgentReviewAt) }}</dd>
              </div>
              <div>
                <dt>Waiting on</dt>
                <dd>{{ selectedTask?.waitingOn || "Not waiting" }}</dd>
              </div>
              <div>
                <dt>Blocked reason</dt>
                <dd>{{ selectedTask?.blockedReason || "Not blocked" }}</dd>
              </div>
              <div>
                <dt>Recurrence</dt>
                <dd>{{ selectedTask?.recurrencePolicy || "None" }}</dd>
              </div>
              <div>
                <dt>Source memory</dt>
                <dd>{{ selectedTask?.sourceMemoryPath || "None" }}</dd>
              </div>
              <div>
                <dt>Clarification</dt>
                <dd>{{ selectedTask?.ownerClarificationNeeded ? "Needed" : "Not needed" }}</dd>
              </div>
            </dl>
          </section>

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
