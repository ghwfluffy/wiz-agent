import { expect } from "vitest";
import type {
  AgentModelClient,
  RepairToolArgumentsRequest,
  StructuredModelRequest,
  ToolModelRequest
} from "../../src/agent/modelClient.js";
import { loadSettings, type Settings } from "../../src/config/settings.js";
import { processInboundMessage } from "../../src/connectors/inboundProcessor.js";
import { createMemoryStore } from "../../src/domain/store.js";
import type {
  AgentStore,
  AgentRunRecord,
  ApprovalRecord,
  AuditRecord,
  ConversationThreadRecord,
  InboundHandlingResult,
  InboundMessageInput,
  InboundMessageRecord,
  OutboundMessageRecord,
  RequestContext,
  TaskRecord,
  ToolCallRecord
} from "../../src/domain/types.js";
import { buildScheduledTaskPrompt } from "../../src/scheduler/autonomousTasks.js";
import { daemonOnce } from "../../src/scheduler/taskQueue.js";
import { SlidingWindowRateLimiter } from "../../src/security/senderPolicy.js";
import type { ToolName } from "../../src/tools/contracts.js";
import { runAgentTask, type AgentTaskResult } from "../../src/agent/runAgentTask.js";

type StagedToolCall = {
  toolName: ToolName;
  arguments: Record<string, unknown>;
};

export class ScenarioModelClient implements AgentModelClient {
  readonly prompts: ToolModelRequest[] = [];
  private readonly toolResponses: unknown[] = [];
  private readonly structuredResponses: unknown[] = [];
  private readonly repairResponses: unknown[] = [];

  stageToolCall(toolName: ToolName, args: Record<string, unknown>): this {
    this.toolResponses.push({ toolName, arguments: args });
    return this;
  }

  stageNoTool(response: Record<string, unknown> = {}): this {
    this.toolResponses.push(response);
    return this;
  }

  stageRepair(response: Record<string, unknown>): this {
    this.repairResponses.push(response);
    return this;
  }

  stageStructured(response: unknown): this {
    this.structuredResponses.push(response);
    return this;
  }

  async runStructured(_request: StructuredModelRequest): Promise<unknown> {
    return this.structuredResponses.shift() ?? {};
  }

  async runWithTools(request: ToolModelRequest): Promise<unknown> {
    this.prompts.push(request);
    return this.toolResponses.shift() ?? {};
  }

  async repairToolArguments(_request: RepairToolArgumentsRequest): Promise<unknown> {
    return this.repairResponses.shift() ?? {};
  }

  get lastPrompt(): string {
    return this.prompts.at(-1)?.prompt ?? "";
  }
}

export type AgentSimulation = {
  store: AgentStore;
  model: ScenarioModelClient;
  settings: Settings;
  ownerContext: RequestContext;
  systemContext: RequestContext;
  now(): Date;
  advanceTime(ms: number): Date;
  configureOwnerContact(config?: Record<string, unknown>): Promise<void>;
  trustNewsletterSender(address: string): Promise<void>;
  sendOwnerMessage(bodyText: string, input?: Partial<InboundMessageInput>): Promise<InboundHandlingResult>;
  receiveNewsletter(input: {
    fromAddr: string;
    subject?: string | null;
    bodyText: string;
    receivedAt?: string;
    providerMessageId?: string;
  }): Promise<InboundHandlingResult>;
  createDueTask(input: {
    title: string;
    prompt: string;
    dueAt?: string;
    scheduleRationale?: string;
    recurrencePolicy?: string;
  }): Promise<TaskRecord>;
  makeTaskDue(title: string): Promise<TaskRecord>;
  runWorkerTick(): Promise<Awaited<ReturnType<typeof daemonOnce>>>;
  runOwnerPrompt(prompt: string): Promise<AgentTaskResult>;
  buildScheduledPrompt(title: string): Promise<string>;
  expectMarkdown(path: string, text: string | RegExp): Promise<void>;
  expectAudit(action: string): Promise<AuditRecord>;
  snapshot(): Promise<{
    tasks: TaskRecord[];
    inbound: InboundMessageRecord[];
    outbound: OutboundMessageRecord[];
    approvals: ApprovalRecord[];
    runs: AgentRunRecord[];
    toolCalls: ToolCallRecord[];
    threads: ConversationThreadRecord[];
  }>;
};

export async function createAgentSimulation(options: {
  settings?: Record<string, string>;
  loginLabel?: string;
  now?: string;
} = {}): Promise<AgentSimulation> {
  let currentTime = new Date(options.now ?? "2026-06-13T12:00:00.000Z");
  const settings = loadSettings({
    APP_ENV: "test",
    AUTH_MODE: "standalone",
    DEV_USER_IS_ADMIN: "true",
    AGENT_OWNER_SMS_EMAILS: "owner-sms@example.test",
    AGENT_MAX_AUTONOMOUS_RUNS_PER_WORKER_TICK: "1",
    ...options.settings
  });
  const store = createMemoryStore();
  const session = await store.createDevelopmentSession(settings, options.loginLabel ?? "scenario-login");
  const ownerContext: RequestContext = {
    userId: session.user.id,
    actorType: "admin",
    permissions: ["user", "admin"],
    requestId: "scenario-owner",
    session
  };
  const systemContext: RequestContext = {
    userId: session.user.id,
    actorType: "system",
    permissions: ["user", "system"],
    requestId: "scenario-worker",
    session
  };
  const model = new ScenarioModelClient();
  const rateLimiter = new SlidingWindowRateLimiter(100, 24 * 60 * 60 * 1000);
  let messageCounter = 0;

  return {
    store,
    model,
    settings,
    ownerContext,
    systemContext,
    now: () => currentTime,
    advanceTime(ms: number): Date {
      currentTime = new Date(currentTime.getTime() + ms);
      return currentTime;
    },
    async configureOwnerContact(config = { sms_gateway: "owner-sms@example.test" }): Promise<void> {
      await store.upsertConnector(ownerContext, {
        kind: "owner-contact",
        status: "enabled",
        config
      });
    },
    async trustNewsletterSender(address: string): Promise<void> {
      await store.setSenderStatus(ownerContext, address, "newsletter");
    },
    async sendOwnerMessage(bodyText: string, input: Partial<InboundMessageInput> = {}): Promise<InboundHandlingResult> {
      return processInboundMessage({
        context: ownerContext,
        settings,
        store,
        rateLimiter,
        modelClient: model,
        message: {
          providerMessageId: input.providerMessageId ?? `owner-${currentTime.getTime()}-${messageCounter++}`,
          fromAddr: input.fromAddr ?? "owner-sms@example.test",
          toAddr: input.toAddr ?? "agent@example.test",
          subject: input.subject ?? null,
          bodyText,
          source: input.source ?? "sms",
          receivedAt: input.receivedAt ?? currentTime.toISOString()
        }
      });
    },
    async receiveNewsletter(input): Promise<InboundHandlingResult> {
      return processInboundMessage({
        context: ownerContext,
        settings,
        store,
        rateLimiter,
        modelClient: model,
        message: {
          providerMessageId: input.providerMessageId ?? `newsletter-${currentTime.getTime()}-${messageCounter++}`,
          fromAddr: input.fromAddr,
          toAddr: "agent@example.test",
          subject: input.subject ?? "Newsletter",
          bodyText: input.bodyText,
          source: "email",
          receivedAt: input.receivedAt ?? currentTime.toISOString()
        }
      });
    },
    async createDueTask(input): Promise<TaskRecord> {
      return store.createTask(systemContext, {
        title: input.title,
        prompt: input.prompt,
        dueAt: input.dueAt ?? currentTime.toISOString(),
        scheduleRationale: input.scheduleRationale,
        recurrencePolicy: input.recurrencePolicy
      });
    },
    async makeTaskDue(title: string): Promise<TaskRecord> {
      const task = (await store.listTasks(systemContext)).find((entry) =>
        entry.title === title && !["completed", "cancelled", "failed"].includes(entry.status)
      );
      if (!task) {
        throw new Error(`Task not found: ${title}`);
      }
      const updated = await store.updateTask(systemContext, task.id, { dueAt: currentTime.toISOString() });
      if (!updated) {
        throw new Error(`Task could not be updated: ${title}`);
      }
      return updated;
    },
    async runWorkerTick() {
      return daemonOnce({
        store,
        context: systemContext,
        settings,
        modelClient: model,
        now: currentTime
      });
    },
    async runOwnerPrompt(prompt: string): Promise<AgentTaskResult> {
      return runAgentTask({
        context: ownerContext,
        store,
        settings,
        modelClient: model,
        request: { prompt }
      });
    },
    async buildScheduledPrompt(title: string): Promise<string> {
      const task = (await store.listTasks(systemContext)).find((entry) =>
        entry.title === title && !["completed", "cancelled", "failed"].includes(entry.status)
      );
      if (!task) {
        throw new Error(`Task not found: ${title}`);
      }
      return buildScheduledTaskPrompt({
        store,
        context: systemContext,
        task,
        settings,
        now: currentTime
      });
    },
    async expectMarkdown(path: string, text: string | RegExp): Promise<void> {
      const document = await store.getMarkdownDocument(ownerContext, path);
      expect(document?.markdown).toEqual(expect.stringMatching(text));
    },
    async expectAudit(action: string): Promise<AuditRecord> {
      const audit = await store.listAudit(ownerContext, true);
      const record = audit.find((entry) => entry.action === action);
      expect(record).toBeTruthy();
      return record!;
    },
    async snapshot() {
      return {
        tasks: await store.listTasks(ownerContext),
        inbound: await store.listInboundMessages(ownerContext),
        outbound: await store.listOutboundMessages(ownerContext),
        approvals: await store.listApprovals(ownerContext),
        runs: await store.listAgentRuns(ownerContext),
        toolCalls: await store.listToolCalls(ownerContext),
        threads: await store.listConversationThreads(ownerContext)
      };
    }
  };
}
