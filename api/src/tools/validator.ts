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

const forbiddenToolArgumentKeys = new Set([
  "userId",
  "user_id",
  "tenantId",
  "tenant_id",
  "tenant",
  "collection",
  "collectionName",
  "collection_name",
  "qdrantCollection",
  "qdrant_collection",
  "credential",
  "credentials",
  "connectorCredential",
  "connector_credentials",
  "password",
  "secret",
  "token",
  "apiKey",
  "api_key",
  "authorization",
  "bearer",
  "recipient",
  "recipientAddress",
  "recipient_address",
  "recipientEmail",
  "recipient_email",
  "recipientPhone",
  "recipient_phone",
  "to",
  "toAddr",
  "to_addr",
  "phone",
  "phoneNumber",
  "phone_number",
  "emailAddress",
  "email_address"
]);

function forbiddenArgumentErrors(value: unknown, path: string[] = []): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => forbiddenArgumentErrors(item, [...path, String(index)]));
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
    const childPath = [...path, key];
    const errors = forbiddenToolArgumentKeys.has(key)
      ? [`${childPath.join(".")}: field is resolved by host context and is not accepted in tool arguments.`]
      : [];
    return [...errors, ...forbiddenArgumentErrors(child, childPath)];
  });
}

export function validateToolArguments(
  toolName: ToolName,
  rawArguments: unknown
): { ok: true; arguments: Record<string, unknown> } | { ok: false; validationErrors: string[] } {
  const schema = ToolContracts[toolName];
  const forbiddenErrors = forbiddenArgumentErrors(rawArguments);
  const parsed = schema.safeParse(rawArguments);
  if (parsed.success && forbiddenErrors.length === 0) {
    return {
      ok: true,
      arguments: parsed.data
    };
  }
  return {
    ok: false,
    validationErrors: [
      ...forbiddenErrors,
      ...(parsed.success ? [] : errorsFromZod(parsed.error))
    ]
  };
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
  const parsed = validateToolArguments(proposal.toolName, proposal.arguments);
  if (parsed.ok) {
    return {
      ok: true,
      toolName: proposal.toolName,
      arguments: parsed.arguments,
      repaired: false
    };
  }

  let validationErrors = parsed.validationErrors;
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
    const repairedParsed = validateToolArguments(proposal.toolName, repair);
    if (repairedParsed.ok) {
      return {
        ok: true,
        toolName: proposal.toolName,
        arguments: repairedParsed.arguments,
        repaired: true
      };
    }
    validationErrors = repairedParsed.validationErrors;
  }

  return {
    ok: false,
    toolName: proposal.toolName,
    rawArguments,
    validationErrors,
    repaired
  };
}
