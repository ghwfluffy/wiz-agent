import type { AgentStore, RequestContext, TaskRecord } from "../domain/types.js";

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
  now?: Date;
}): Promise<{ claimedTasks: number }> {
  const claimed = await claimDueTasks({
    store: options.store,
    context: options.context,
    now: options.now
  });
  return {
    claimedTasks: claimed.length
  };
}
