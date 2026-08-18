import type { AgentStore, RequestContext, TaskRecord } from "../domain/types.js";
import type { AgentModelClient } from "../agent/modelClient.js";
import { runAgentTask } from "../agent/runAgentTask.js";
import type { Settings } from "../config/settings.js";
import {
  DAILY_CHECK_IN_MAX_DELIVERY_ATTEMPTS,
  processOutboundQueue,
  type MailTransport
} from "../connectors/smtpSender.js";
import { SignedIntegrationTokenProvider } from "../integrations/tokenProvider.js";
import {
  buildScheduledTaskPrompt,
  ensureAutonomousTasks,
  isAutonomousRecurringTask,
  isNewsletterInterestTask,
  ownerLocalDate,
  scheduleNextAutonomousTask
} from "./autonomousTasks.js";
import { executeApprovedCrossAppApprovals } from "./approvalExecutor.js";
import { recordTaskOutcomeMemory } from "../memory/taskOutcomeMemory.js";
import { recordScheduledTaskDecision } from "../memory/decisionLedger.js";
import { runtimeSafetyPolicy } from "../security/safetyPolicy.js";
import {
  parseScheduledOwnerMessageTask,
  queueOwnerVisibleMessage
} from "../tools/ownerMessaging.js";
import type { WebResearchClient } from "../research/openAiWebResearchClient.js";

const WORKER_STUCK_STATE_GRACE_MS = 30 * 60 * 1000;
const STALE_TASK_FAILURE_MESSAGE = "Worker claim expired before completion.";
const STALE_OUTBOUND_FAILURE_MESSAGE = "Outbound delivery attempt expired before completion.";
const STALE_APPROVAL_EXECUTION_ERROR = "approval_execution_expired";
export const DAILY_CHECK_IN_FALLBACK_MESSAGE = "Hey! What's up?";

export async function claimDueTasks(options: {
  store: AgentStore;
  context: RequestContext;
  limit?: number;
  now?: Date;
}): Promise<TaskRecord[]> {
  return options.store.claimDueTasks(options.context, options.limit ?? 10, options.now ?? new Date());
}

function payloadString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isBefore(value: string | null | undefined, cutoff: Date): boolean {
  if (!value) {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed < cutoff.getTime();
}

function dailyCheckInDedupeKey(context: RequestContext, now: Date): string {
  return `daily-check-in:${ownerLocalDate(now, context.session.user.timezone)}`;
}

async function queueDailyCheckInMessage(options: {
  store: AgentStore;
  context: RequestContext;
  settings?: Settings;
  task: TaskRecord;
  now: Date;
  body: string;
  origin: "daily_check_in_fallback" | "daily_check_in_newsletter_research";
  preferredChannel: "sms" | "mms";
  title: string;
  linkedMemoryPaths?: string[];
}) {
  const dedupeKey = dailyCheckInDedupeKey(options.context, options.now);
  const existing = (await options.store.listOutboundMessages(options.context))
    .find((message) => message.dedupeKey === dedupeKey);
  const existingThread = existing?.conversationThreadId
    ? await options.store.getConversationThread(options.context, existing.conversationThreadId)
    : undefined;
  const thread = existing
    ? existingThread
    : await options.store.createConversationThread(options.context, {
        title: options.title,
        status: "active",
        linkedTaskIds: [options.task.id],
        linkedMemoryPaths: options.linkedMemoryPaths ?? []
      });
  const queued = await queueOwnerVisibleMessage({
    context: options.context,
    store: options.store,
    settings: options.settings,
    source: options.origin,
    isProactive: true,
    body: options.body,
    conversationThreadId: thread?.id ?? existing?.conversationThreadId ?? null,
    preferredChannel: options.preferredChannel,
    dedupeKey
  });
  if (!queued.message) {
    throw new Error("The owner's SMS, MMS, and email destinations are unavailable for the daily check-in.");
  }
  if (queued.message.status === "failed") {
    throw new Error("The daily check-in reached its bounded delivery retry limit.");
  }
  await options.store.recordTaskEvent(options.context, options.task.id, "daily_check_in.queued", {
    outbound_message_id: queued.message.id,
    conversation_thread_id: queued.message.conversationThreadId ?? thread?.id ?? null,
    channel: queued.message.channel,
    origin: options.origin,
    dedupe_key: queued.message.dedupeKey,
    summary: options.origin === "daily_check_in_newsletter_research"
      ? "Sanitized newsletter research was queued as today's conversational check-in."
      : "The fixed casual fallback was queued as today's conversational check-in."
  });
  return {
    message: queued.message,
    conversationThreadId: queued.message.conversationThreadId ?? thread?.id ?? null
  };
}

export async function recoverStuckWorkerState(options: {
  store: AgentStore;
  context: RequestContext;
  settings?: Settings;
  now?: Date;
  staleAfterMs?: number;
}): Promise<{
  recoveredTasks: number;
  expiredApprovals: number;
  recoveredOutbound: number;
  recoveredApprovalExecutions: number;
}> {
  const now = options.now ?? new Date();
  const staleBefore = new Date(now.getTime() - (options.staleAfterMs ?? WORKER_STUCK_STATE_GRACE_MS));
  const totals = {
    recoveredTasks: 0,
    expiredApprovals: 0,
    recoveredOutbound: 0,
    recoveredApprovalExecutions: 0
  };

  const claimedTasks = (await options.store.listTasks(options.context))
    .filter((task) => task.status === "claimed" && isBefore(task.updatedAt, staleBefore));
  for (const task of claimedTasks) {
    const failed = await options.store.updateTask(options.context, task.id, {
      status: "failed",
      lastAgentReviewAt: now.toISOString(),
      blockedReason: STALE_TASK_FAILURE_MESSAGE
    });
    if (!failed) {
      continue;
    }
    await options.store.recordTaskEvent(options.context, task.id, "scheduled_task.failed", {
      failure_message: STALE_TASK_FAILURE_MESSAGE,
      stale_before: staleBefore.toISOString(),
      summary: "Scheduled task claim expired before completion; recurrence will still be scheduled when applicable."
    });
    await recordScheduledTaskDecision({
      store: options.store,
      context: options.context,
      taskId: task.id,
      outcome: "failed",
      failureMessage: STALE_TASK_FAILURE_MESSAGE,
      now
    });
    await recordTaskOutcomeMemory({
      store: options.store,
      context: options.context,
      taskId: task.id,
      now
    });
    if (isNewsletterInterestTask(task)) {
      try {
        await queueDailyCheckInMessage({
          store: options.store,
          context: options.context,
          settings: options.settings,
          task,
          now,
          body: DAILY_CHECK_IN_FALLBACK_MESSAGE,
          origin: "daily_check_in_fallback",
          preferredChannel: "sms",
          title: "Daily check-in recovery"
        });
      } catch (error) {
        await options.store.recordTaskEvent(options.context, task.id, "daily_check_in.recovery_failed", {
          failure_message: error instanceof Error ? error.message : String(error),
          summary: "Could not ensure the stale daily task's fallback outbox before rolling recurrence."
        });
      }
    }
    if (isAutonomousRecurringTask(task)) {
      await scheduleNextAutonomousTask({
        store: options.store,
        context: options.context,
        task,
        now
      });
    }
    await options.store.recordAudit(options.context, "worker.recovered_task_claim", "task", task.id, {
      stale_before: staleBefore.toISOString(),
      failure_message: STALE_TASK_FAILURE_MESSAGE
    });
    totals.recoveredTasks += 1;
  }

  const pendingApprovals = await options.store.listApprovals(options.context, ["pending"]);
  for (const approval of pendingApprovals) {
    const expiresAt = Date.parse(approval.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt > now.getTime()) {
      continue;
    }
    const expired = await options.store.updateApprovalStatus(options.context, approval.id, "expired", options.context.userId);
    if (!expired) {
      continue;
    }
    if (approval.actionType === "send_outbound_message") {
      const outboundId = payloadString(approval.proposedPayload, "outbound_message_id");
      if (outboundId) {
        await options.store.updateOutboundMessageStatus(options.context, outboundId, "cancelled");
      }
    }
    await options.store.recordAudit(options.context, "worker.expired_approval", "approval", approval.id, {
      action_type: approval.actionType,
      expired_at: approval.expiresAt
    });
    totals.expiredApprovals += 1;
  }

  const sendingMessages = (await options.store.listOutboundMessages(options.context, ["sending"]))
    .filter((message) => isBefore(message.updatedAt, staleBefore));
  for (const message of sendingMessages) {
    const retryDailyCheckIn = Boolean(
      message.dedupeKey?.startsWith("daily-check-in:") &&
      message.deliveryAttempts < DAILY_CHECK_IN_MAX_DELIVERY_ATTEMPTS
    );
    const failed = await options.store.updateOutboundMessageStatus(
      options.context,
      message.id,
      retryDailyCheckIn ? "pending" : "failed",
      STALE_OUTBOUND_FAILURE_MESSAGE,
      null
    );
    if (failed) {
      await options.store.recordAudit(options.context, retryDailyCheckIn
        ? "worker.retried_stale_daily_check_in"
        : "worker.recovered_outbound_send", "outbound_message", message.id, {
        stale_before: staleBefore.toISOString(),
        failure_message: STALE_OUTBOUND_FAILURE_MESSAGE,
        retry_scheduled: retryDailyCheckIn,
        delivery_attempts: message.deliveryAttempts
      });
      totals.recoveredOutbound += 1;
    }
  }

  const runningApprovals = (await options.store.listApprovals(options.context, ["approved"]))
    .filter((approval) =>
      approval.actionType === "cross_app_write_action" &&
      approval.executionStatus === "running" &&
      isBefore(approval.updatedAt, staleBefore)
    );
  for (const approval of runningApprovals) {
    const failed = await options.store.failApprovalExecution(
      options.context,
      approval.id,
      STALE_APPROVAL_EXECUTION_ERROR
    );
    if (failed) {
      await options.store.recordAudit(options.context, "worker.recovered_approval_execution", "approval", approval.id, {
        stale_before: staleBefore.toISOString(),
        error: STALE_APPROVAL_EXECUTION_ERROR
      });
      totals.recoveredApprovalExecutions += 1;
    }
  }

  return totals;
}

export async function daemonOnce(options: {
  store: AgentStore;
  context: RequestContext;
  settings?: Settings;
  modelClient?: AgentModelClient;
  mailTransport?: MailTransport;
  outboundLimit?: number;
  now?: Date;
  fetchImpl?: typeof fetch;
  webResearchClient?: WebResearchClient;
}): Promise<{
  claimedTasks: number;
  ranTasks: number;
  approvalExecutionAttempted: number;
  approvalExecutionSucceeded: number;
  approvalExecutionFailed: number;
  outboundAttempted: number;
  outboundSent: number;
  outboundFailed: number;
  recoveredTasks: number;
  expiredApprovals: number;
  recoveredOutbound: number;
  recoveredApprovalExecutions: number;
}> {
  const modelClient = options.modelClient;
  const recovery = await recoverStuckWorkerState({
    store: options.store,
    context: options.context,
    settings: options.settings,
    now: options.now
  });
  if (modelClient) {
    await ensureAutonomousTasks({
      store: options.store,
      context: options.context,
      now: options.now
    });
  }
  const claimed = modelClient
    ? await claimDueTasks({
        store: options.store,
        context: options.context,
        limit: runtimeSafetyPolicy(options.settings).maxAutonomousRunsPerWorkerTick,
        now: options.now
      })
    : [];
  let ranTasks = 0;
  if (modelClient) {
    for (const task of claimed) {
      let runFailed = false;
      const dailyCheckInTask = isNewsletterInterestTask(task);
      let dailyCheckInQueueAttempted = false;
      let dailyCheckInOutboundMessageId: string | undefined;
      const queueDailyCheckIn = async (message: {
        body: string;
        origin: "daily_check_in_fallback" | "daily_check_in_newsletter_research";
        preferredChannel: "sms" | "mms";
        title: string;
        linkedMemoryPaths?: string[];
      }) => {
        dailyCheckInQueueAttempted = true;
        const queued = await queueDailyCheckInMessage({
          store: options.store,
          context: options.context,
          settings: options.settings,
          task,
          now: options.now ?? new Date(),
          ...message
        });
        dailyCheckInOutboundMessageId = queued.message.id;
        return queued;
      };
      try {
        const scheduledOwnerMessage = parseScheduledOwnerMessageTask(task);
        if (scheduledOwnerMessage) {
          const queued = await queueOwnerVisibleMessage({
            context: options.context,
            store: options.store,
            settings: options.settings,
            source: "scheduled_owner_message",
            subject: scheduledOwnerMessage.subject ?? null,
            body: scheduledOwnerMessage.body
          });
          if (!queued.message) {
            throw new Error("Owner message destination is unavailable.");
          }
          await options.store.updateTask(options.context, task.id, {
            status: "completed",
            lastAgentReviewAt: (options.now ?? new Date()).toISOString()
          });
          await options.store.recordTaskEvent(options.context, task.id, "scheduled_task.outcome", {
            outcome: "acted",
            tool_name: "schedule_owner_message",
            outbound_message_id: queued.message.id,
            summary: "Scheduled owner message was queued for delivery."
          });
          await recordScheduledTaskDecision({
            store: options.store,
            context: options.context,
            taskId: task.id,
            outcome: "acted",
            toolName: "schedule_owner_message",
            now: options.now
          });
          await recordTaskOutcomeMemory({
            store: options.store,
            context: options.context,
            taskId: task.id,
            now: options.now
          });
          continue;
        }
        const prompt = isAutonomousRecurringTask(task)
          ? await buildScheduledTaskPrompt({
            store: options.store,
            context: options.context,
            task,
            settings: options.settings,
            now: options.now
          })
          : task.prompt;
        const result = await runAgentTask({
          context: options.context,
          store: options.store,
          modelClient,
          settings: options.settings,
          integrationTokenProvider: options.settings ? new SignedIntegrationTokenProvider(options.settings) : undefined,
          webResearchClient: options.webResearchClient,
          fetchImpl: options.fetchImpl,
          request: {
            taskId: task.id,
            prompt,
            allowedTools: dailyCheckInTask ? ["web_research", "record_observation"] : undefined
          },
          now: options.now
        });
        runFailed = result.status === "failed";
        let researchSessionId: string | undefined;
        let researchQuery: string | undefined;
        let researchSourcePaths: string[] = [];
        let dailyCheckInBody = DAILY_CHECK_IN_FALLBACK_MESSAGE;
        if (!runFailed && dailyCheckInTask && result.toolName === "web_research") {
          const researchStatus = payloadString(result.executionResult ?? {}, "status");
          researchSessionId = payloadString(result.executionResult ?? {}, "research_session_id");
          researchQuery = payloadString(result.executionResult ?? {}, "query") ?? "Newsletter research";
          if ((researchStatus === "ok" || researchStatus === "partial") && result.responseText && researchSessionId) {
            researchSourcePaths = Array.isArray(result.executionResult?.source_markdown_paths)
              ? result.executionResult.source_markdown_paths.filter((path): path is string => typeof path === "string")
              : [];
            dailyCheckInBody = `${result.responseText.trim()}\n\nWhat's up?`;
          }
        }
        if (dailyCheckInTask) {
          const usedResearch = Boolean(researchSessionId && dailyCheckInBody !== DAILY_CHECK_IN_FALLBACK_MESSAGE);
          const queued = await queueDailyCheckIn({
            body: dailyCheckInBody,
            origin: usedResearch ? "daily_check_in_newsletter_research" : "daily_check_in_fallback",
            preferredChannel: usedResearch ? "mms" : "sms",
            title: usedResearch
              ? `Newsletter icebreaker: ${(researchQuery ?? "Newsletter research").replace(/\s+/g, " ").slice(0, 120)}`
              : "Daily check-in",
            linkedMemoryPaths: researchSourcePaths
          });
          if (usedResearch && researchSessionId) {
            if (!queued.conversationThreadId) {
              throw new Error("The daily check-in outbox is missing its conversation thread.");
            }
            await options.store.linkWebResearchSession(options.context, researchSessionId, {
              conversationThreadId: queued.conversationThreadId,
              outboundMessageId: queued.message.id
            });
            await options.store.recordTaskEvent(options.context, task.id, "newsletter_research.queued", {
              research_session_id: researchSessionId,
              outbound_message_id: queued.message.id,
              conversation_thread_id: queued.conversationThreadId,
              channel: queued.message.channel,
              summary: "Sanitized newsletter research was queued through the preferred MMS channel with safe SMS/email fallback."
            });
          }
        }
        await options.store.updateTask(options.context, task.id, {
          status: runFailed ? "failed" : "completed",
          lastAgentReviewAt: (options.now ?? new Date()).toISOString()
        });
        if (runFailed) {
          await options.store.recordTaskEvent(options.context, task.id, "scheduled_task.failed", {
            failure_message: result.failureMessage ?? null,
            summary: "Scheduled task run failed; recurrence will still be scheduled."
          });
          await recordScheduledTaskDecision({
            store: options.store,
            context: options.context,
            taskId: task.id,
            runId: result.runId || null,
            outcome: "failed",
            toolName: result.toolName ?? null,
            failureMessage: result.failureMessage ?? null,
            now: options.now
          });
        } else {
          const outcome = dailyCheckInOutboundMessageId || (result.sideEffect && result.sideEffect !== "none") ? "acted" : "observed";
          await options.store.recordTaskEvent(options.context, task.id, "scheduled_task.outcome", {
            outcome,
            tool_name: result.toolName ?? null,
            outbound_message_id: dailyCheckInOutboundMessageId ?? null,
            summary: `Scheduled task outcome: ${outcome}.`
          });
          await recordScheduledTaskDecision({
            store: options.store,
            context: options.context,
            taskId: task.id,
            runId: result.runId,
            outcome,
            toolName: result.toolName ?? null,
            now: options.now
          });
        }
        await recordTaskOutcomeMemory({
          store: options.store,
          context: options.context,
          taskId: task.id,
          now: options.now
        });
      } catch (error) {
        runFailed = true;
        let failureMessage = error instanceof Error ? error.message : String(error);
        if (dailyCheckInTask && !dailyCheckInQueueAttempted) {
          try {
            await queueDailyCheckIn({
              body: DAILY_CHECK_IN_FALLBACK_MESSAGE,
              origin: "daily_check_in_fallback",
              preferredChannel: "sms",
              title: "Daily check-in"
            });
          } catch (fallbackError) {
            failureMessage = `${failureMessage} Daily check-in fallback also failed: ${
              fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
            }`;
          }
        }
        await options.store.updateTask(options.context, task.id, {
          status: "failed",
          lastAgentReviewAt: (options.now ?? new Date()).toISOString()
        });
        await options.store.recordTaskEvent(options.context, task.id, "scheduled_task.failed", {
          failure_message: failureMessage,
          summary: "Scheduled task run failed; recurrence will still be scheduled."
        });
        await recordScheduledTaskDecision({
          store: options.store,
          context: options.context,
          taskId: task.id,
          outcome: "failed",
          failureMessage,
          now: options.now
        });
        await recordTaskOutcomeMemory({
          store: options.store,
          context: options.context,
          taskId: task.id,
          now: options.now
        });
      } finally {
        if (isAutonomousRecurringTask(task)) {
          await scheduleNextAutonomousTask({
            store: options.store,
            context: options.context,
            task,
            now: options.now
          });
        }
        ranTasks += 1;
      }
    }
  }
  const approvalExecution = options.settings
    ? await executeApprovedCrossAppApprovals({
        store: options.store,
        context: options.context,
        settings: options.settings,
        tokenProvider: new SignedIntegrationTokenProvider(options.settings),
        fetchImpl: options.fetchImpl,
        now: options.now
      })
    : { attempted: 0, succeeded: 0, failed: 0 };
  const outbound = options.settings
    ? await processOutboundQueue({
        store: options.store,
        context: options.context,
        settings: options.settings,
        transport: options.mailTransport,
        now: options.now,
        limit: Math.min(
          options.outboundLimit ?? runtimeSafetyPolicy(options.settings).outboundMessagesPerWorkerTick,
          runtimeSafetyPolicy(options.settings).outboundMessagesPerWorkerTick
        )
      })
    : { attempted: 0, sent: 0, failed: 0 };
  return {
    claimedTasks: claimed.length,
    ranTasks,
    approvalExecutionAttempted: approvalExecution.attempted,
    approvalExecutionSucceeded: approvalExecution.succeeded,
    approvalExecutionFailed: approvalExecution.failed,
    outboundAttempted: outbound.attempted,
    outboundSent: outbound.sent,
    outboundFailed: outbound.failed,
    recoveredTasks: recovery.recoveredTasks,
    expiredApprovals: recovery.expiredApprovals,
    recoveredOutbound: recovery.recoveredOutbound,
    recoveredApprovalExecutions: recovery.recoveredApprovalExecutions
  };
}
