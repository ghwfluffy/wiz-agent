import type { Settings } from "../config/settings.js";
import type { AgentStore, ApprovalRecord, RequestContext } from "../domain/types.js";
import {
  getIntegrationAction,
  isIntegrationActionId,
  type IntegrationActionId
} from "../integrations/capabilityRegistry.js";
import {
  callIntegrationActionApi,
  redactIntegrationData,
  type IntegrationTokenProvider
} from "../tools/integrationGateway.js";

type CrossAppApprovalPayload = {
  actionId: IntegrationActionId;
  pathParams?: Record<string, string>;
  query?: Record<string, string | number | boolean>;
  body?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (typeof nested !== "string") {
      return undefined;
    }
    result[key] = nested;
  }
  return result;
}

function queryMap(value: unknown): Record<string, string | number | boolean> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const result: Record<string, string | number | boolean> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (typeof nested !== "string" && typeof nested !== "number" && typeof nested !== "boolean") {
      return undefined;
    }
    result[key] = nested;
  }
  return result;
}

function parseCrossAppApprovalPayload(approval: ApprovalRecord): CrossAppApprovalPayload | { error: string } {
  const actionId = approval.proposedPayload.action_id;
  if (typeof actionId !== "string" || !isIntegrationActionId(actionId)) {
    return { error: "unknown_integration_action" };
  }
  const action = getIntegrationAction(actionId);
  if (action.access !== "write") {
    return { error: "integration_action_not_write" };
  }
  if (action.app === "apartment_gate") {
    return { error: "integration_has_no_agent_api" };
  }
  const pathParams = stringMap(approval.proposedPayload.path_params);
  if (pathParams === undefined && approval.proposedPayload.path_params !== undefined) {
    return { error: "invalid_path_params" };
  }
  const query = queryMap(approval.proposedPayload.query);
  if (query === undefined && approval.proposedPayload.query !== undefined) {
    return { error: "invalid_query" };
  }
  return {
    actionId,
    pathParams,
    query,
    body: approval.proposedPayload.body === undefined ? null : approval.proposedPayload.body
  };
}

export async function executeApprovedCrossAppApproval(options: {
  store: AgentStore;
  context: RequestContext;
  settings: Settings;
  approvalId: string;
  tokenProvider: IntegrationTokenProvider;
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<ApprovalRecord | undefined> {
  const claimed = await options.store.claimApprovalExecution(options.context, options.approvalId);
  if (!claimed) {
    return undefined;
  }

  const expiresAt = Date.parse(claimed.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt <= (options.now ?? new Date()).getTime()) {
    return options.store.failApprovalExecution(options.context, claimed.id, "approval_expired");
  }

  const parsed = parseCrossAppApprovalPayload(claimed);
  if ("error" in parsed) {
    return options.store.failApprovalExecution(options.context, claimed.id, parsed.error);
  }

  const result = await callIntegrationActionApi({
    settings: options.settings,
    context: options.context,
    actionId: parsed.actionId,
    pathParams: parsed.pathParams,
    query: parsed.query,
    body: parsed.body,
    tokenProvider: options.tokenProvider,
    fetchImpl: options.fetchImpl
  }).catch((error) => ({
    ok: false as const,
    reason: error instanceof Error ? error.message : "integration_request_failed"
  }));
  if (!result.ok) {
    return options.store.failApprovalExecution(options.context, claimed.id, result.reason);
  }

  const executionResult = {
    status: result.status,
    data: redactIntegrationData(result.data)
  };
  if (result.status < 200 || result.status >= 300) {
    return options.store.failApprovalExecution(
      options.context,
      claimed.id,
      `integration_http_${result.status}`,
      executionResult
    );
  }
  return options.store.completeApprovalExecution(options.context, claimed.id, executionResult);
}

export async function executeApprovedCrossAppApprovals(options: {
  store: AgentStore;
  context: RequestContext;
  settings: Settings;
  tokenProvider: IntegrationTokenProvider;
  fetchImpl?: typeof fetch;
  limit?: number;
  now?: Date;
}): Promise<{ attempted: number; succeeded: number; failed: number }> {
  const approvals = (await options.store.listApprovals(options.context, ["approved"]))
    .filter((approval) =>
      approval.actionType === "cross_app_write_action" &&
      approval.executionStatus === "pending"
    )
    .slice(0, options.limit ?? 5);
  const totals = { attempted: 0, succeeded: 0, failed: 0 };
  for (const approval of approvals) {
    const result = await executeApprovedCrossAppApproval({
      ...options,
      approvalId: approval.id
    });
    if (!result) {
      continue;
    }
    totals.attempted += 1;
    if (result.executionStatus === "succeeded") {
      totals.succeeded += 1;
    } else if (result.executionStatus === "failed") {
      totals.failed += 1;
    }
  }
  return totals;
}
