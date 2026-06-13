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
  scheduleNextAutonomousTask
} from "./autonomousTasks.js";
import { executeApprovedCrossAppApprovals } from "./approvalExecutor.js";

export async function claimDueTasks(options: {
  store: AgentStore;
  context: RequestContext;
  limit?: number;
  now?: Date;
}): Promise<TaskRecord[]> {
  return options.store.claimDueTasks(options.context, options.limit ?? 10, options.now ?? new Date());
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
}): Promise<{
  claimedTasks: number;
  ranTasks: number;
  approvalExecutionAttempted: number;
  approvalExecutionSucceeded: number;
  approvalExecutionFailed: number;
  outboundAttempted: number;
  outboundSent: number;
  outboundFailed: number;
}> {
  const modelClient = options.modelClient;
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
        now: options.now
      })
    : [];
  let ranTasks = 0;
  if (modelClient) {
    for (const task of claimed) {
      let runFailed = false;
      try {
        const prompt = isAutonomousRecurringTask(task)
          ? await buildScheduledTaskPrompt({
            store: options.store,
            context: options.context,
            task,
            now: options.now
          })
          : task.prompt;
        const result = await runAgentTask({
          context: options.context,
          store: options.store,
          modelClient,
          settings: options.settings,
          integrationTokenProvider: options.settings ? new SignedIntegrationTokenProvider(options.settings) : undefined,
          request: {
            taskId: task.id,
            prompt
          }
        });
        runFailed = result.status === "failed";
        await options.store.updateTask(options.context, task.id, {
          status: runFailed ? "failed" : "completed",
          lastAgentReviewAt: (options.now ?? new Date()).toISOString()
        });
        if (runFailed) {
          await options.store.recordTaskEvent(options.context, task.id, "scheduled_task.failed", {
            failure_message: result.failureMessage ?? null,
            summary: "Scheduled task run failed; recurrence will still be scheduled."
          });
        } else {
          const outcome = result.sideEffect && result.sideEffect !== "none" ? "acted" : "observed";
          await options.store.recordTaskEvent(options.context, task.id, "scheduled_task.outcome", {
            outcome,
            tool_name: result.toolName ?? null,
            summary: `Scheduled task outcome: ${outcome}.`
          });
        }
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
        limit: options.outboundLimit
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
    outboundFailed: outbound.failed
  };
}
