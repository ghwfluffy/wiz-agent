import { ownerExplicitlyAuthorizedMutation } from "./externalResearchPolicy.js";
import type { AgentTaskResult } from "./runAgentTask.js";

export const TRUSTED_CONTEXT_HANDOFF_SIGNAL = "TRUSTED_CONTEXT_HANDOFF_REQUIRED";

export type TrustedContextHandoffTrigger = "explicit_signal" | "restriction_refusal" | "action_refusal";

const restrictionRefusalPatterns = [
  /\b(?:can(?:not|'t)|unable to)\b.{0,180}\b(?:tool[- ]restricted|restricted)\s+context\b/is,
  /\b(?:tool|tools|mutation tools|write tools)\b.{0,100}\b(?:unavailable|not available|disabled|restricted)\b.{0,80}\b(?:context|turn)\b/is,
  /\b(?:current|this)\s+(?:tool[- ]restricted|restricted)\s+(?:context|turn)\b/is
];

const actionRefusalPatterns = [
  /\b(?:can(?:not|'t)|could(?:not|n't)|unable to|did(?: not|n't))\s+(?:submit|queue|delegate|create|start|send|perform|execute|complete)\b.{0,180}\b(?:job|task|request|action|change|it)\b/is,
  /\b(?:job|task|request|action|change)\b.{0,120}\b(?:can(?:not|'t)|could(?:not|n't))\s+be\s+(?:submitted|queued|delegated|created|started|sent|performed|executed|completed)\b/is
];

const separateOwnerTaskPatterns = [
  /^(?:please\s+)?(?:build|configure|connect|deploy|design|develop|install|organize|refactor|repair|replace|restore|set up)\b/i,
  /\b(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:build|configure|connect|deploy|design|develop|install|organize|refactor|repair|replace|restore|set up)\b/i,
  /\bi\s+(?:want|need|would like)\s+(?:you\s+to\s+)?(?:build|configure|connect|deploy|design|develop|install|organize|refactor|repair|replace|restore|set up)\b/i
];

function ownerClearlyStartedAction(ownerCommand: string | undefined): boolean {
  const normalized = (ownerCommand ?? "")
    .normalize("NFKC")
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4000);
  return normalized.length > 0 && (
    ownerExplicitlyAuthorizedMutation(normalized)
    || separateOwnerTaskPatterns.some((pattern) => pattern.test(normalized))
  );
}

export function trustedContextHandoffTrigger(options: {
  result: AgentTaskResult;
  ownerCommand: string | undefined;
}): TrustedContextHandoffTrigger | undefined {
  if (
    options.result.status !== "completed"
    || options.result.toolStatus !== "none"
    || !ownerClearlyStartedAction(options.ownerCommand)
  ) {
    return undefined;
  }

  const response = options.result.responseText
    ?.normalize("NFKC")
    .replace(/[’‘]/g, "'")
    .trim() ?? "";
  if (response === TRUSTED_CONTEXT_HANDOFF_SIGNAL) {
    return "explicit_signal";
  }
  if (restrictionRefusalPatterns.some((pattern) => pattern.test(response))) {
    return "restriction_refusal";
  }
  return actionRefusalPatterns.some((pattern) => pattern.test(response))
    ? "action_refusal"
    : undefined;
}
