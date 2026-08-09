import type { AgentModelClient } from "./modelClient.js";
import {
  AgentRuntimeDeadline,
  AgentRuntimeDeadlineExceededError,
  MAX_RUNTIME_GUARDRAIL
} from "./runtimeDeadline.js";
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
import { ToolRegistry } from "../tools/registry.js";
import { parseToolProposal, validateOrRepairToolCall, type ValidatedToolCall } from "../tools/validator.js";
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
  ownerInitiated?: boolean;
  replyToMessage?: Pick<InboundMessageRecord, "fromAddr" | "source" | "subject" | "conversationThreadId">;
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
  now?: Date;
}): Promise<AgentTaskResult> {
  const now = options.now ?? new Date();
  const aiConfig = await options.store.getAiConfig();
  const safety = runtimeSafetyPolicy(options.settings, aiConfig);
  const runWindowStart = new Date(now.getTime() - safety.agentRunBurstWindowSeconds * 1000);
  const recentRuns = await options.store.countAgentRunsSince(options.context, runWindowStart);
  if (recentRuns >= safety.maxAgentRunsPerUserPerBurstWindow) {
    const message = "Agent run burst guardrail exceeded.";
    await recordGuardrailExceeded({
      store: options.store,
      context: options.context,
      guardrail: "maxAgentRunsPerUserPerBurstWindow",
      entityType: "agent_run",
      details: {
        count: recentRuns,
        limit: safety.maxAgentRunsPerUserPerBurstWindow,
        window_seconds: safety.agentRunBurstWindowSeconds,
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
  const runtimeDeadline = new AgentRuntimeDeadline(aiConfig.maxRuntimeSec);
  const runtimeModelClient = modelClientWithDeadline(options.modelClient, runtimeDeadline);
  const run = await options.store.createAgentRun(options.context, {
    taskId: options.request.taskId ?? null,
    status: "running",
    modelTier: tier,
    modelId,
    promptVersion: "phase5.capabilities.v1"
  });

  try {
    let modelOutput = await runtimeModelClient.runWithTools({
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

    let repaired = false;
    let toolStatus: AgentTaskResult["toolStatus"] = "none";
    let toolName: string | undefined;
    let sideEffect: AgentTaskResult["sideEffect"];
    let executionResult: Record<string, unknown> | undefined;

    while (true) {
      const proposal = parseToolProposal(modelOutput);
      if (!proposal) {
        await options.store.finishAgentRun(options.context, run.id, "completed");
        return {
          status: "completed",
          runId: run.id,
          toolStatus,
          repaired,
          toolName,
          responseText: modelText(modelOutput),
          sideEffect,
          executionResult
        };
      }

      let validated: ValidatedToolCall;
      try {
        validated = await validateOrRepairToolCall(proposal, {
          modelClient: runtimeModelClient,
          repairModel: aiConfig.repairModel,
          repairAttemptLimit: safety.repairAttemptLimit
        });
      } catch (error) {
        if (error instanceof AgentRuntimeDeadlineExceededError) {
          await recordRuntimeDeadlineExceeded({
            store: options.store,
            context: options.context,
            runId: run.id,
            error,
            toolName: proposal.toolName
          });
          await options.store.recordToolCall(options.context, {
            runId: run.id,
            toolName: proposal.toolName,
            status: "rejected",
            arguments: typeof proposal.arguments === "object" && proposal.arguments !== null
              ? proposal.arguments as Record<string, unknown>
              : { value: proposal.arguments },
            validationError: `guardrail_exceeded:${MAX_RUNTIME_GUARDRAIL}`,
            result: runtimeGuardrailResult(error, proposal.toolName)
          });
          await options.store.finishAgentRun(options.context, run.id, "failed", error.message);
          return {
            status: "failed",
            runId: run.id,
            toolStatus: "rejected",
            repaired,
            toolName: proposal.toolName,
            failureMessage: error.message
          };
        }
        throw error;
      }

      repaired ||= validated.repaired;
      toolName = validated.toolName;
      if (!validated.ok) {
        const message = "Tool call validation failed.";
        const failure = recoverableToolFailure(validated.toolName, message, {
          validationErrors: validated.validationErrors
        });
        await options.store.recordToolCall(options.context, {
          runId: run.id,
          toolName: validated.toolName,
          status: "rejected",
          arguments: typeof validated.rawArguments === "object" && validated.rawArguments !== null
            ? validated.rawArguments as Record<string, unknown>
            : { value: validated.rawArguments },
          validationError: validated.validationErrors.join("; "),
          result: failure
        });
        toolStatus = "rejected";
        executionResult = failure;
        const continued = await continueToolConversation({
          modelClient: runtimeModelClient,
          modelOutput,
          modelId,
          tier,
          output: failure
        });
        if (continued !== undefined) {
          modelOutput = continued;
          continue;
        }
        await options.store.finishAgentRun(options.context, run.id, "failed", message);
        return {
          status: "failed",
          runId: run.id,
          toolStatus,
          repaired,
          toolName,
          executionResult,
          failureMessage: message
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
          repaired,
          toolName: validated.toolName,
          failureMessage: message
        };
      }

      let execution;
      try {
        execution = await runtimeDeadline.run("tool_execution", (signal) => (options.toolClient ?? new McpToolClient()).execute({
          context: options.context,
          store: options.store,
          runId: run.id,
          taskId: options.request.taskId ?? null,
          toolName: validated.toolName,
          args: validated.arguments,
          settings: options.settings,
          integrationTokenProvider: options.integrationTokenProvider,
          fetchImpl: options.fetchImpl,
          ownerInitiated: options.request.ownerInitiated === true,
          replyToMessage: options.request.replyToMessage,
          signal,
          now
        }));
      } catch (error) {
        const message = error instanceof GuardrailExceededError
          ? error.message
          : error instanceof AgentRuntimeDeadlineExceededError
            ? error.message
            : error instanceof Error ? error.message : "Tool execution failed.";
        if (error instanceof AgentRuntimeDeadlineExceededError) {
          await recordRuntimeDeadlineExceeded({
            store: options.store,
            context: options.context,
            runId: run.id,
            error,
            toolName: validated.toolName
          });
        }
        const failure = error instanceof AgentRuntimeDeadlineExceededError
          ? runtimeGuardrailResult(error, validated.toolName)
          : error instanceof GuardrailExceededError
            ? {
                status: "guardrail_exceeded",
                reason: error.guardrail,
                message,
                ...error.details
              }
            : recoverableToolFailure(validated.toolName, message);
        await options.store.recordToolCall(options.context, {
          runId: run.id,
          toolName: validated.toolName,
          status: "failed",
          arguments: validated.arguments,
          validationError: error instanceof AgentRuntimeDeadlineExceededError
            ? `guardrail_exceeded:${MAX_RUNTIME_GUARDRAIL}`
            : error instanceof GuardrailExceededError
              ? `guardrail_exceeded:${error.guardrail}`
              : message,
          result: failure
        });
        toolStatus = "rejected";
        executionResult = failure;
        if (!(error instanceof AgentRuntimeDeadlineExceededError)) {
          const continued = await continueToolConversation({
            modelClient: runtimeModelClient,
            modelOutput,
            modelId,
            tier,
            output: failure
          });
          if (continued !== undefined) {
            modelOutput = continued;
            continue;
          }
        }
        await options.store.finishAgentRun(options.context, run.id, "failed", message);
        return {
          status: "failed",
          runId: run.id,
          toolStatus,
          repaired,
          toolName: validated.toolName,
          executionResult,
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
        toolCall,
        now
      });
      toolStatus = "accepted";
      toolName = validated.toolName;
      sideEffect = execution.sideEffect;
      executionResult = execution.result;

      const continued = await continueToolConversation({
        modelClient: runtimeModelClient,
        modelOutput,
        modelId,
        tier,
        output: execution.result
      });
      if (continued !== undefined) {
        modelOutput = continued;
        continue;
      }

      const responseText = ToolRegistry[validated.toolName].access === "read"
        ? await synthesizeToolResponse({
            modelClient: runtimeModelClient,
            modelId,
            tier,
            ownerPrompt: options.request.prompt,
            toolName: validated.toolName,
            toolResult: execution.result
          })
        : undefined;
      await options.store.finishAgentRun(options.context, run.id, "completed");
      return {
        status: "completed",
        runId: run.id,
        toolStatus,
        repaired,
        toolName,
        responseText,
        sideEffect,
        executionResult
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Agent run failed.";
    if (error instanceof AgentRuntimeDeadlineExceededError) {
      await recordRuntimeDeadlineExceeded({
        store: options.store,
        context: options.context,
        runId: run.id,
        error
      });
    }
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

function modelClientWithDeadline(
  modelClient: AgentModelClient,
  deadline: AgentRuntimeDeadline
): AgentModelClient {
  return {
    runStructured: (request) => deadline.run(
      "structured_model_response",
      (signal) => modelClient.runStructured({ ...request, signal })
    ),
    runWithTools: (request) => deadline.run(
      "model_response",
      (signal) => modelClient.runWithTools({ ...request, signal })
    ),
    runText: (request) => deadline.run(
      "final_response_synthesis",
      (signal) => modelClient.runText({ ...request, signal })
    ),
    transcribeAudio: (request) => deadline.run(
      "voice_transcription",
      (signal) => modelClient.transcribeAudio({ ...request, signal })
    ),
    repairToolArguments: (request) => deadline.run(
      "tool_argument_repair",
      (signal) => modelClient.repairToolArguments({ ...request, signal })
    )
  };
}

async function recordRuntimeDeadlineExceeded(options: {
  store: AgentStore;
  context: RequestContext;
  runId: string;
  error: AgentRuntimeDeadlineExceededError;
  toolName?: string;
}): Promise<void> {
  await recordGuardrailExceeded({
    store: options.store,
    context: options.context,
    guardrail: MAX_RUNTIME_GUARDRAIL,
    entityType: "agent_run",
    entityId: options.runId,
    details: runtimeGuardrailDetails(options.error, options.toolName)
  });
}

function runtimeGuardrailResult(
  error: AgentRuntimeDeadlineExceededError,
  toolName?: string
): Record<string, unknown> {
  return {
    status: "guardrail_exceeded",
    reason: MAX_RUNTIME_GUARDRAIL,
    message: error.message,
    ...runtimeGuardrailDetails(error, toolName)
  };
}

function runtimeGuardrailDetails(
  error: AgentRuntimeDeadlineExceededError,
  toolName?: string
): Record<string, unknown> {
  return {
    phase: error.phase,
    elapsed_ms: error.elapsedMs,
    limit_seconds: error.maxRuntimeSec,
    ...(toolName ? { tool_name: toolName } : {})
  };
}

function modelText(output: unknown): string | undefined {
  if (typeof output === "string" && output.trim()) {
    return output.trim();
  }
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return undefined;
  }
  const record = output as Record<string, unknown>;
  for (const key of ["responseText", "response", "message", "summary", "text"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function recoverableToolFailure(
  toolName: string,
  message: string,
  details: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    ok: false,
    status: "failed",
    reason: "tool_execution_failed",
    tool_name: toolName,
    message,
    recoverable: true,
    guidance: "Use this result as context. Retry with corrected input, choose another safe tool, or explain the failure to the owner through the normal reply path.",
    ...details
  };
}

async function continueToolConversation(options: {
  modelClient: AgentModelClient;
  modelOutput: unknown;
  modelId: string;
  tier: ReturnType<typeof chooseModelTier>;
  output: Record<string, unknown>;
}): Promise<unknown | undefined> {
  const continuation = toolContinuation(options.modelOutput);
  if (!continuation) {
    return undefined;
  }
  return options.modelClient.runWithTools({
    model: options.modelId,
    tier: options.tier,
    prompt: "",
    tools: modelToolDescriptors(),
    previousResponseId: continuation.responseId,
    toolOutputs: [{ callId: continuation.callId, output: options.output }]
  });
}

function toolContinuation(output: unknown): { responseId: string; callId: string } | undefined {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return undefined;
  }
  const record = output as Record<string, unknown>;
  if (typeof record.responseId !== "string" || typeof record.callId !== "string") {
    return undefined;
  }
  return { responseId: record.responseId, callId: record.callId };
}

async function synthesizeToolResponse(options: {
  modelClient: AgentModelClient;
  modelId: string;
  tier: ReturnType<typeof chooseModelTier>;
  ownerPrompt: string;
  toolName: string;
  toolResult: Record<string, unknown>;
}): Promise<string | undefined> {
  try {
    const response = await options.modelClient.runText({
      model: options.modelId,
      tier: options.tier,
      prompt: [
        "You are answering the owner's authenticated chat after a read-only host tool was executed.",
        "Use the owner request, any included chat context, and the tool result to answer the owner's latest question directly.",
        "Do not call or suggest another tool. Do not repeat a raw list unless the owner asked for a list.",
        "If the owner asks what something means or what to do next, interpret the data and give concrete next actions.",
        "If the tool result is insufficient, say what is missing and what you can infer.",
        "",
        "Owner request and context:",
        options.ownerPrompt,
        "",
        `Tool executed: ${options.toolName}`,
        "Tool result JSON:",
        compactJson(options.toolResult),
        "",
        "Answer:"
      ].join("\n")
    });
    return response.trim() || undefined;
  } catch (error) {
    if (error instanceof AgentRuntimeDeadlineExceededError) {
      throw error;
    }
    return undefined;
  }
}

function compactJson(value: unknown): string {
  return JSON.stringify(value, null, 2).slice(0, 12000);
}
