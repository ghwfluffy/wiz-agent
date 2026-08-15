import type { AgentStore, RequestContext, TaskRecord } from "../domain/types.js";
import type { AgentModelClient } from "../agent/modelClient.js";
import { runAgentTask } from "../agent/runAgentTask.js";
import type { Settings } from "../config/settings.js";
import { processOutboundQueue, type MailTransport } from "../connectors/smtpSender.js";
import { SignedIntegrationTokenProvider } from "../integrations/tokenProvider.js";
import {
  buildScheduledTaskPrompt,
  ensureAutonomousTasks,
  isAutonomousRecurringTask,
  isNewsletterInterestTask,
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

export async function recoverStuckWorkerState(options: {
  store: AgentStore;
  context: RequestContext;
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
    const failed = await options.store.updateOutboundMessageStatus(
      options.context,
      message.id,
      "failed",
      STALE_OUTBOUND_FAILURE_MESSAGE
    );
    if (failed) {
      await options.store.recordAudit(options.context, "worker.recovered_outbound_send", "outbound_message", message.id, {
        stale_before: staleBefore.toISOString(),
        failure_message: STALE_OUTBOUND_FAILURE_MESSAGE
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
        const newsletterInterestTask = isNewsletterInterestTask(task);
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
            allowedTools: newsletterInterestTask ? ["web_research", "record_observation"] : undefined
          },
          now: options.now
        });
        runFailed = result.status === "failed";
        let newsletterOutboundMessageId: string | undefined;
        if (!runFailed && newsletterInterestTask && result.toolName === "web_research") {
          const researchStatus = payloadString(result.executionResult ?? {}, "status");
          const researchSessionId = payloadString(result.executionResult ?? {}, "research_session_id");
          const query = payloadString(result.executionResult ?? {}, "query") ?? "Newsletter research";
          if ((researchStatus === "ok" || researchStatus === "partial") && result.responseText && researchSessionId) {
            const sourcePaths = Array.isArray(result.executionResult?.source_markdown_paths)
              ? result.executionResult.source_markdown_paths.filter((path): path is string => typeof path === "string")
              : [];
            const thread = await options.store.createConversationThread(options.context, {
              title: `Newsletter research: ${query.replace(/\s+/g, " ").slice(0, 120)}`,
              status: "active",
              linkedTaskIds: [task.id],
              linkedMemoryPaths: sourcePaths
            });
            const queued = await queueOwnerVisibleMessage({
              context: options.context,
              store: options.store,
              settings: options.settings,
              source: "newsletter_web_research",
              body: result.responseText,
              conversationThreadId: thread.id,
              preferredChannel: "mms",
              requirePreferredChannel: true
            });
            if (!queued.message) {
              throw new Error("The owner's MMS destination is unavailable for newsletter research.");
            }
            newsletterOutboundMessageId = queued.message.id;
            await options.store.linkWebResearchSession(options.context, researchSessionId, {
              conversationThreadId: thread.id,
              outboundMessageId: queued.message.id
            });
            await options.store.recordTaskEvent(options.context, task.id, "newsletter_research.queued", {
              research_session_id: researchSessionId,
              outbound_message_id: queued.message.id,
              conversation_thread_id: thread.id,
              channel: queued.message.channel,
              summary: "Sanitized newsletter research was queued to the owner through MMS without approval."
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
          const outcome = newsletterOutboundMessageId || (result.sideEffect && result.sideEffect !== "none") ? "acted" : "observed";
          await options.store.recordTaskEvent(options.context, task.id, "scheduled_task.outcome", {
            outcome,
            tool_name: result.toolName ?? null,
            outbound_message_id: newsletterOutboundMessageId ?? null,
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
        await options.store.updateTask(options.context, task.id, {
          status: "failed",
          lastAgentReviewAt: (options.now ?? new Date()).toISOString()
        });
        await options.store.recordTaskEvent(options.context, task.id, "scheduled_task.failed", {
          failure_message: error instanceof Error ? error.message : String(error),
          summary: "Scheduled task run failed; recurrence will still be scheduled."
        });
        await recordScheduledTaskDecision({
          store: options.store,
          context: options.context,
          taskId: task.id,
          outcome: "failed",
          failureMessage: error instanceof Error ? error.message : String(error),
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
