import type { AgentStore, RequestContext, TaskRecord } from "../domain/types.js";
import type { AgentModelClient } from "../agent/modelClient.js";
import { runAgentTask } from "../agent/runAgentTask.js";
import type { Settings } from "../config/settings.js";
import { processOutboundQueue, type MailTransport } from "../connectors/smtpSender.js";

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
  now?: Date;
}): Promise<{ claimedTasks: number; ranTasks: number; outboundAttempted: number; outboundSent: number; outboundFailed: number }> {
  const claimed = await claimDueTasks({
    store: options.store,
    context: options.context,
    now: options.now
  });
  let ranTasks = 0;
  if (options.modelClient) {
    for (const task of claimed) {
      await runAgentTask({
        context: options.context,
        store: options.store,
        modelClient: options.modelClient,
        settings: options.settings,
        request: {
          taskId: task.id,
          prompt: task.prompt
        }
      });
      await options.store.updateTask(options.context, task.id, { status: "completed" });
      ranTasks += 1;
    }
  }
  const outbound = options.settings
    ? await processOutboundQueue({
        store: options.store,
        context: options.context,
        settings: options.settings,
        transport: options.mailTransport
      })
    : { attempted: 0, sent: 0, failed: 0 };
  return {
    claimedTasks: claimed.length,
    ranTasks,
    outboundAttempted: outbound.attempted,
    outboundSent: outbound.sent,
    outboundFailed: outbound.failed
  };
}
