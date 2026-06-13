import type { AgentModelClient } from "./modelClient.js";
import {
  chooseModelTier,
  modelTierConfigFromAiConfig,
  resolveModelId,
  type AgentTaskComplexity
} from "./modelTiers.js";
import { buildAgentPrompt, modelToolDescriptors } from "./promptContext.js";
import type { Settings } from "../config/settings.js";
import type { AgentStore, InboundMessageRecord, RequestContext } from "../domain/types.js";
import type { IntegrationTokenProvider } from "../tools/integrationGateway.js";
import { parseToolProposal, validateOrRepairToolCall } from "../tools/validator.js";
import { McpToolClient, type AgentToolClient } from "./toolClient.js";
import {
  GuardrailExceededError,
  recordGuardrailExceeded,
  runtimeSafetyPolicy
} from "../security/safetyPolicy.js";
import { recordDecisionLedgerForToolCall } from "../memory/decisionLedger.js";

export type AgentTaskRequest = {
  prompt: string;
  taskId?: string | null;
  complexity?: AgentTaskComplexity;
  replyToMessage?: Pick<InboundMessageRecord, "fromAddr" | "source" | "subject">;
};

export type AgentTaskResult = {
  status: "completed" | "failed";
  runId: string;
  toolStatus: "accepted" | "rejected" | "none";
  repaired: boolean;
  toolName?: string;
  responseText?: string;
  sideEffect?: "none" | "local_persistence" | "cross_app_api";
  executionResult?: Record<string, unknown>;
  failureMessage?: string;
};

export async function runAgentTask(options: {
  context: RequestContext;
  store: AgentStore;
  modelClient: AgentModelClient;
  request: AgentTaskRequest;
  settings?: Settings;
  integrationTokenProvider?: IntegrationTokenProvider;
  fetchImpl?: typeof fetch;
  toolClient?: AgentToolClient;
}): Promise<AgentTaskResult> {
  const aiConfig = await options.store.getAiConfig();
  const safety = runtimeSafetyPolicy(options.settings, aiConfig);
  const runWindowStart = new Date(Date.now() - 60 * 60 * 1000);
  const recentRuns = await options.store.countAgentRunsSince(options.context, runWindowStart);
  if (recentRuns >= safety.maxAgentRunsPerUserPerHour) {
    const message = "Agent run hourly guardrail exceeded.";
    await recordGuardrailExceeded({
      store: options.store,
      context: options.context,
      guardrail: "maxAgentRunsPerUserPerHour",
      entityType: "agent_run",
      details: {
        count: recentRuns,
        limit: safety.maxAgentRunsPerUserPerHour,
        window_start: runWindowStart.toISOString()
      }
    });
    return {
      status: "failed",
      runId: "",
      toolStatus: "none",
      repaired: false,
      failureMessage: message
    };
  }
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
    if (options.request.taskId) {
      const responseSummary = typeof modelOutput === "string" ? modelOutput : JSON.stringify(modelOutput);
      await options.store.recordTaskEvent(options.context, options.request.taskId, "agent.prompted", {
        model_id: modelId,
        model_tier: tier,
        prompt_excerpt: options.request.prompt.slice(0, safety.maxPromptExcerptChars),
        response_summary: responseSummary.slice(0, safety.maxPromptExcerptChars),
        summary: "Agent was prompted and returned a response."
      });
    }
    const proposal = parseToolProposal(modelOutput);
    if (!proposal) {
      await options.store.finishAgentRun(options.context, run.id, "completed");
      return {
        status: "completed",
        runId: run.id,
        toolStatus: "none",
        repaired: false,
        responseText: modelText(modelOutput)
      };
    }

    const validated = await validateOrRepairToolCall(proposal, {
      modelClient: options.modelClient,
      repairModel: aiConfig.repairModel,
      repairAttemptLimit: safety.repairAttemptLimit
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

    const toolCallsSoFar = await options.store.countToolCallsForRun(options.context, run.id);
    if (toolCallsSoFar >= safety.maxToolCallsPerRun) {
      const message = "MCP/tool call guardrail exceeded for this run.";
      const details = {
        count: toolCallsSoFar,
        limit: safety.maxToolCallsPerRun,
        tool_name: validated.toolName
      };
      await recordGuardrailExceeded({
        store: options.store,
        context: options.context,
        guardrail: "maxToolCallsPerRun",
        entityType: "agent_run",
        entityId: run.id,
        details
      });
      await options.store.recordToolCall(options.context, {
        runId: run.id,
        toolName: validated.toolName,
        status: "rejected",
        arguments: validated.arguments,
        validationError: "guardrail_exceeded:maxToolCallsPerRun",
        result: {
          status: "guardrail_exceeded",
          reason: "maxToolCallsPerRun",
          ...details
        }
      });
      await options.store.finishAgentRun(options.context, run.id, "failed", message);
      return {
        status: "failed",
        runId: run.id,
        toolStatus: "rejected",
        repaired: validated.repaired,
        toolName: validated.toolName,
        failureMessage: message
      };
    }

    let execution;
    try {
      execution = await (options.toolClient ?? new McpToolClient()).execute({
        context: options.context,
        store: options.store,
        runId: run.id,
        toolName: validated.toolName,
        args: validated.arguments,
        settings: options.settings,
        integrationTokenProvider: options.integrationTokenProvider,
        fetchImpl: options.fetchImpl,
        replyToMessage: options.request.replyToMessage
      });
    } catch (error) {
      const message = error instanceof GuardrailExceededError
        ? error.message
        : error instanceof Error ? error.message : "Tool execution failed.";
      await options.store.recordToolCall(options.context, {
        runId: run.id,
        toolName: validated.toolName,
        status: "failed",
        arguments: validated.arguments,
        validationError: error instanceof GuardrailExceededError
          ? `guardrail_exceeded:${error.guardrail}`
          : message,
        result: error instanceof GuardrailExceededError
          ? {
              status: "guardrail_exceeded",
              reason: error.guardrail,
              ...error.details
            }
          : undefined
      });
      await options.store.finishAgentRun(options.context, run.id, "failed", message);
      return {
        status: "failed",
        runId: run.id,
        toolStatus: "rejected",
        repaired: validated.repaired,
        toolName: validated.toolName,
        failureMessage: message
      };
    }

    const toolCall = await options.store.recordToolCall(options.context, {
      runId: run.id,
      toolName: validated.toolName,
      status: "accepted",
      arguments: validated.arguments,
      result: {
        accepted: true,
        side_effect_executed: execution.executed && execution.sideEffect !== "none",
        side_effect: execution.sideEffect,
        execution: execution.result
      }
    });
    await recordDecisionLedgerForToolCall({
      store: options.store,
      context: options.context,
      toolCall
    });
    await options.store.finishAgentRun(options.context, run.id, "completed");
      return {
        status: "completed",
        runId: run.id,
        toolStatus: "accepted",
        repaired: validated.repaired,
        toolName: validated.toolName,
        sideEffect: execution.sideEffect,
        executionResult: execution.result
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

function modelText(output: unknown): string | undefined {
  if (typeof output === "string" && output.trim()) {
    return output.trim();
  }
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return undefined;
  }
  const record = output as Record<string, unknown>;
  for (const key of ["response", "message", "summary", "text"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}
