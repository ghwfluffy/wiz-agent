import type { AgentModelClient } from "./modelClient.js";
import {
  chooseModelTier,
  modelTierConfigFromAiConfig,
  resolveModelId,
  type AgentTaskComplexity
} from "./modelTiers.js";
import { buildAgentPrompt, modelToolDescriptors } from "./promptContext.js";
import type { AgentStore, RequestContext } from "../domain/types.js";
import { parseToolProposal, validateOrRepairToolCall } from "../tools/validator.js";

export type AgentTaskRequest = {
  prompt: string;
  taskId?: string | null;
  complexity?: AgentTaskComplexity;
};

export type AgentTaskResult = {
  status: "completed" | "failed";
  runId: string;
  toolStatus: "accepted" | "rejected" | "none";
  repaired: boolean;
  failureMessage?: string;
};

export async function runAgentTask(options: {
  context: RequestContext;
  store: AgentStore;
  modelClient: AgentModelClient;
  request: AgentTaskRequest;
}): Promise<AgentTaskResult> {
  const aiConfig = await options.store.getAiConfig();
  const tier = chooseModelTier(options.request.complexity ?? {});
  const modelId = resolveModelId(modelTierConfigFromAiConfig(aiConfig), tier);
  const run = await options.store.createAgentRun(options.context, {
    taskId: options.request.taskId ?? null,
    status: "running",
    modelTier: tier,
    modelId,
    promptVersion: "phase5.capabilities.v1"
  });

  try {
    const modelOutput = await options.modelClient.runWithTools({
      model: modelId,
      tier,
      prompt: buildAgentPrompt(options.request.prompt),
      tools: modelToolDescriptors()
    });
    const proposal = parseToolProposal(modelOutput);
    if (!proposal) {
      await options.store.finishAgentRun(options.context, run.id, "completed");
      return {
        status: "completed",
        runId: run.id,
        toolStatus: "none",
        repaired: false
      };
    }

    const validated = await validateOrRepairToolCall(proposal, {
      modelClient: options.modelClient,
      repairModel: aiConfig.repairModel,
      repairAttemptLimit: aiConfig.repairAttemptLimit
    });

    if (!validated.ok) {
      await options.store.recordToolCall(options.context, {
        runId: run.id,
        toolName: validated.toolName,
        status: "rejected",
        arguments: typeof validated.rawArguments === "object" && validated.rawArguments !== null
          ? validated.rawArguments as Record<string, unknown>
          : { value: validated.rawArguments },
        validationError: validated.validationErrors.join("; ")
      });
      await options.store.finishAgentRun(options.context, run.id, "failed", "Tool call validation failed.");
      return {
        status: "failed",
        runId: run.id,
        toolStatus: "rejected",
        repaired: validated.repaired,
        failureMessage: "Tool call validation failed."
      };
    }

    await options.store.recordToolCall(options.context, {
      runId: run.id,
      toolName: validated.toolName,
      status: "accepted",
      arguments: validated.arguments,
      result: {
        accepted: true,
        side_effect_executed: false
      }
    });
    await options.store.finishAgentRun(options.context, run.id, "completed");
    return {
      status: "completed",
      runId: run.id,
      toolStatus: "accepted",
      repaired: validated.repaired
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Agent run failed.";
    await options.store.finishAgentRun(options.context, run.id, "failed", message);
    return {
      status: "failed",
      runId: run.id,
      toolStatus: "none",
      repaired: false,
      failureMessage: message
    };
  }
}
