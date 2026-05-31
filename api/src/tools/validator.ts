import { ZodError } from "zod";
import { contractShape, isToolName, ToolContracts, type ToolCallProposal, type ToolName } from "./contracts.js";
import type { AgentModelClient } from "../agent/modelClient.js";

export type ValidatedToolCall =
  | {
      ok: true;
      toolName: ToolName;
      arguments: Record<string, unknown>;
      repaired: boolean;
    }
  | {
      ok: false;
      toolName: string;
      rawArguments: unknown;
      validationErrors: string[];
      repaired: boolean;
    };

function errorsFromZod(error: ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`);
}

export function parseToolProposal(value: unknown): ToolCallProposal | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const maybe = value as Record<string, unknown>;
  if (typeof maybe.toolName !== "string") {
    return undefined;
  }
  if (!isToolName(maybe.toolName)) {
    return undefined;
  }
  return {
    toolName: maybe.toolName,
    arguments: maybe.arguments
  };
}

export async function validateOrRepairToolCall(
  proposal: ToolCallProposal,
  options: {
    modelClient: AgentModelClient;
    repairModel: string;
    repairAttemptLimit: number;
  }
): Promise<ValidatedToolCall> {
  const schema = ToolContracts[proposal.toolName];
  const parsed = schema.safeParse(proposal.arguments);
  if (parsed.success) {
    return {
      ok: true,
      toolName: proposal.toolName,
      arguments: parsed.data,
      repaired: false
    };
  }

  let validationErrors = errorsFromZod(parsed.error);
  let repaired = false;
  let rawArguments = proposal.arguments;

  for (let attempt = 0; attempt < options.repairAttemptLimit; attempt += 1) {
    repaired = true;
    const repair = await options.modelClient.repairToolArguments({
      model: options.repairModel,
      tier: "repair",
      toolName: proposal.toolName,
      malformedArguments: rawArguments,
      contractShape: contractShape(proposal.toolName),
      validationErrors
    });
    rawArguments = repair;
    const repairedParsed = schema.safeParse(repair);
    if (repairedParsed.success) {
      return {
        ok: true,
        toolName: proposal.toolName,
        arguments: repairedParsed.data,
        repaired: true
      };
    }
    validationErrors = errorsFromZod(repairedParsed.error);
  }

  return {
    ok: false,
    toolName: proposal.toolName,
    rawArguments,
    validationErrors,
    repaired
  };
}
