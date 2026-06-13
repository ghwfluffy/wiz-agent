import type { Settings } from "../config/settings.js";
import type { RequestContext } from "../domain/types.js";
import {
  getIntegrationAction,
  type IntegrationActionId
} from "../integrations/capabilityRegistry.js";

export type IntegrationApp = "goals" | "budget";

export type IntegrationTokenProvider = {
  tokenFor(context: RequestContext, app: IntegrationApp, scope: string): Promise<string | undefined>;
};

export type IntegrationGatewayResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; reason: string };

export type IntegrationActionRequest =
  | {
      ok: true;
      app: IntegrationApp;
      path: string;
      method: string;
      body?: unknown;
    }
  | { ok: false; reason: string };

export function integrationBaseUrl(settings: Settings, app: IntegrationApp): string {
  return app === "goals" ? settings.goalsApiBaseUrl : settings.budgetApiBaseUrl;
}

function isApiBackedIntegrationApp(app: string): app is IntegrationApp {
  return app === "goals" || app === "budget";
}

export function redactIntegrationData(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactIntegrationData);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const redacted: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (/(token|secret|password|credential|authorization|cookie|session)/i.test(key)) {
      redacted[key] = "[redacted]";
      continue;
    }
    redacted[key] = redactIntegrationData(nested);
  }
  return redacted;
}

export async function callIntegrationApi(options: {
  settings: Settings;
  context: RequestContext;
  app: IntegrationApp;
  path: string;
  method?: string;
  body?: unknown;
  scope?: string;
  tokenProvider: IntegrationTokenProvider;
  fetchImpl?: typeof fetch;
}): Promise<IntegrationGatewayResult> {
  const baseUrl = integrationBaseUrl(options.settings, options.app);
  if (!baseUrl) {
    return { ok: false, reason: "integration_not_configured" };
  }
  const token = await options.tokenProvider.tokenFor(options.context, options.app, options.scope ?? `${options.app}:unspecified`);
  if (!token) {
    return { ok: false, reason: "missing_user_integration_token" };
  }
  const fetcher = options.fetchImpl ?? fetch;
  const url = new URL(options.path.replace(/^\//, ""), `${baseUrl.replace(/\/$/, "")}/`);
  const response = await fetcher(url, {
    method: options.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-agent-user-id": options.context.userId
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const data = redactIntegrationData(await response.json().catch(() => null));
  return {
    ok: true,
    status: response.status,
    data
  };
}

export function resolveIntegrationActionRequest(options: {
  actionId: IntegrationActionId;
  pathParams?: Record<string, string>;
  query?: Record<string, string | number | boolean>;
  body?: unknown;
}): IntegrationActionRequest {
  const action = getIntegrationAction(options.actionId);
  const pathParams = options.pathParams ?? {};
  const query = options.query ?? {};
  const allowedQueryParams = new Set(action.queryParams ?? []);

  for (const key of Object.keys(query)) {
    if (!allowedQueryParams.has(key)) {
      return { ok: false, reason: "query_param_not_allowed" };
    }
  }

  let path = action.pathTemplate;
  for (const param of action.pathParams ?? []) {
    const value = pathParams[param];
    if (!value) {
      return { ok: false, reason: "missing_path_param" };
    }
    path = path.replace(`:${param}`, encodeURIComponent(value));
  }

  const unresolvedParam = path.match(/:[A-Za-z0-9_]+/);
  if (unresolvedParam) {
    return { ok: false, reason: "unresolved_path_param" };
  }

  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    searchParams.set(key, String(value));
  }
  const queryString = searchParams.toString();
  if (!isApiBackedIntegrationApp(action.app)) {
    return { ok: false, reason: "integration_has_no_agent_api" };
  }

  return {
    ok: true,
    app: action.app,
    path: queryString ? `${path}?${queryString}` : path,
    method: action.method,
    body: options.body
  };
}

export async function callIntegrationActionApi(options: {
  settings: Settings;
  context: RequestContext;
  actionId: IntegrationActionId;
  pathParams?: Record<string, string>;
  query?: Record<string, string | number | boolean>;
  body?: unknown;
  tokenProvider: IntegrationTokenProvider;
  fetchImpl?: typeof fetch;
}): Promise<IntegrationGatewayResult> {
  const request = resolveIntegrationActionRequest({
    actionId: options.actionId,
    pathParams: options.pathParams,
    query: options.query,
    body: options.body
  });
  if (!request.ok) {
    return request;
  }
  return callIntegrationApi({
    settings: options.settings,
    context: options.context,
    app: request.app,
    path: request.path,
    method: request.method,
    body: request.body,
    scope: options.actionId,
    tokenProvider: options.tokenProvider,
    fetchImpl: options.fetchImpl
  });
}
