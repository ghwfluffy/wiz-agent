import type { Settings } from "../config/settings.js";
import type { AiConfig } from "../domain/types.js";

export type ModelTier = "fast" | "smart" | "orchestrator" | "repair";

export type AgentTaskComplexity = {
  largeContext?: boolean;
  ambiguous?: boolean;
  multipleGoals?: boolean;
  repeatedFailure?: boolean;
  orchestration?: boolean;
  repair?: boolean;
};

export type ModelTierConfig = Record<ModelTier, string>;

export function modelTierConfigFromSettings(settings: Settings): ModelTierConfig {
  return {
    fast: settings.agentOpenaiModelFast,
    smart: settings.agentOpenaiModelSmart,
    orchestrator: settings.agentOpenaiModelOrchestrator,
    repair: settings.agentOpenaiModelRepair
  };
}

export function modelTierConfigFromAiConfig(config: AiConfig): ModelTierConfig {
  return {
    fast: config.fastModel,
    smart: config.smartModel,
    orchestrator: config.orchestratorModel,
    repair: config.repairModel
  };
}

export function chooseModelTier(complexity: AgentTaskComplexity): ModelTier {
  if (complexity.repair) {
    return "repair";
  }
  if (complexity.orchestration) {
    return "orchestrator";
  }
  if (complexity.largeContext || complexity.ambiguous || complexity.multipleGoals || complexity.repeatedFailure) {
    return "smart";
  }
  return "fast";
}

export function resolveModelId(config: ModelTierConfig, tier: ModelTier): string {
  return config[tier];
}
