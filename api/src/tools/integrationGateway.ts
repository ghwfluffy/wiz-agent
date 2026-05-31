import type { Settings } from "../config/settings.js";
import type { RequestContext } from "../domain/types.js";

export type IntegrationApp = "goals" | "budget";

export type IntegrationTokenProvider = {
  tokenFor(context: RequestContext, app: IntegrationApp): Promise<string | undefined>;
};

export type IntegrationGatewayResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; reason: string };

export function integrationBaseUrl(settings: Settings, app: IntegrationApp): string {
  return app === "goals" ? settings.goalsApiBaseUrl : settings.budgetApiBaseUrl;
}

export async function callIntegrationApi(options: {
  settings: Settings;
  context: RequestContext;
  app: IntegrationApp;
  path: string;
  method?: string;
  body?: unknown;
  tokenProvider: IntegrationTokenProvider;
  fetchImpl?: typeof fetch;
}): Promise<IntegrationGatewayResult> {
  const baseUrl = integrationBaseUrl(options.settings, options.app);
  if (!baseUrl) {
    return { ok: false, reason: "integration_not_configured" };
  }
  const token = await options.tokenProvider.tokenFor(options.context, options.app);
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
      "x-agent-user-id": options.context.userId,
      "x-agent-tenant-id": options.context.tenantId
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const data = await response.json().catch(() => null);
  return {
    ok: true,
    status: response.status,
    data
  };
}
