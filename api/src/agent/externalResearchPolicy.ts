import type { ToolName } from "../tools/contracts.js";
import { ToolRegistry, agentToolNames } from "../tools/registry.js";

const mutationVerb = "(?:add|approve|archive|cancel|change|complete|create|delete|delegate|edit|fix|implement|mark|message|move|open|publish|put|queue|record|remind|remove|rename|reorder|reply|save|schedule|send|set|sort|start|stop|update|write)";
const explicitMutationPatterns = [
  new RegExp(`^(?:(?:yes|yeah|yep|sure|okay|ok)[,;:!.\\s]+)?(?:please\\s+)?${mutationVerb}\\b`, "i"),
  new RegExp(`\\b(?:can|could|would|will)\\s+you\\s+${mutationVerb}\\b`, "i"),
  new RegExp(`\\bi\\s+(?:want|need|would like)\\s+(?:you\\s+to\\s+)?${mutationVerb}\\b`, "i"),
  new RegExp(`\\b(?:let's|lets)\\s+${mutationVerb}\\b`, "i"),
  new RegExp(`\\buse\\s+(?:that|this|it)\\s+to\\s+${mutationVerb}\\b`, "i"),
  /\b(?:go ahead(?:\s+(?:and|with))?|do (?:it|that)|make (?:it|that) happen)\b/i,
  /^(?:please\s+)?(?:tell|ask|have)\s+(?:omni\s*dev|the\s+(?:development|coding)\s+agent)\b/i,
  /\b(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:tell|ask|have)\s+(?:omni\s*dev|the\s+(?:development|coding)\s+agent)\b/i
];

export function ownerExplicitlyAuthorizedMutation(ownerCommand: string | undefined): boolean {
  const normalized = (ownerCommand ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4000);
  return normalized.length > 0 && explicitMutationPatterns.some((pattern) => pattern.test(normalized));
}

export function allowedToolsForExternalResearchTurn(options: {
  ownerCommand?: string;
  baseAllowedTools?: readonly ToolName[];
}): { allowedTools: ToolName[]; mutationAuthorized: boolean } {
  const base = [...new Set(options.baseAllowedTools ?? agentToolNames())];
  const mutationAuthorized = ownerExplicitlyAuthorizedMutation(options.ownerCommand);
  if (mutationAuthorized) {
    return { allowedTools: base, mutationAuthorized };
  }
  return {
    allowedTools: base.filter((name) => ToolRegistry[name].access === "read"),
    mutationAuthorized
  };
}
