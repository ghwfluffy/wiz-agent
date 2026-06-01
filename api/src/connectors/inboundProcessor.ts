import type { AgentModelClient } from "../agent/modelClient.js";
import { runOwnerInboundAgent } from "../agent/inboundMessageAgent.js";
import type { Settings } from "../config/settings.js";
import type { AgentStore, InboundHandlingResult, InboundMessageInput, RequestContext } from "../domain/types.js";
import type { IntegrationTokenProvider } from "../tools/integrationGateway.js";
import { handleInboundMessage, type InboundRateLimiter } from "../security/senderPolicy.js";

export async function processInboundMessage(options: {
  context: RequestContext;
  settings: Settings;
  store: AgentStore;
  message: InboundMessageInput;
  rateLimiter: InboundRateLimiter;
  modelClient: AgentModelClient;
  integrationTokenProvider?: IntegrationTokenProvider;
  fetchImpl?: typeof fetch;
}): Promise<InboundHandlingResult> {
  return handleInboundMessage({
    context: options.context,
    settings: options.settings,
    store: options.store,
    message: options.message,
    rateLimiter: options.rateLimiter,
    ownerAgentRunner: async (recorded) => runOwnerInboundAgent({
      context: options.context,
      store: options.store,
      message: recorded,
      modelClient: options.modelClient,
      settings: options.settings,
      integrationTokenProvider: options.integrationTokenProvider,
      fetchImpl: options.fetchImpl
    })
  });
}
