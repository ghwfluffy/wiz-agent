import type { TaskRecord } from "../domain/types.js";

export const OMNI_DEV_OWNER_INPUT_PROMPT_PREFIX = "OMNI_DEV_OWNER_INPUT_V1\n";

export function omniDevOwnerInputTaskPrompt(input: {
  jobId: string;
  question: string;
  context: string;
}): string {
  return [
    OMNI_DEV_OWNER_INPUT_PROMPT_PREFIX.trimEnd(),
    `job_id: ${input.jobId}`,
    "When the owner answers, use respond_to_development_job with this job_id and the owner's natural-language answer. Do not create a new development job.",
    `question: ${input.question}`,
    `context: ${input.context}`
  ].join("\n");
}

export function isWaitingOmniDevInputTask(task: TaskRecord, jobId: string): boolean {
  return task.status === "waiting"
    && task.prompt.startsWith(OMNI_DEV_OWNER_INPUT_PROMPT_PREFIX)
    && task.prompt.includes(`\njob_id: ${jobId}\n`);
}
