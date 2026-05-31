import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Settings } from "../config/settings.js";
import type { RequestContext } from "../domain/types.js";
import type { IntegrationApp, IntegrationTokenProvider } from "../tools/integrationGateway.js";

type TokenFile = {
  users?: Record<string, Partial<Record<IntegrationApp, string>>>;
  default?: Partial<Record<IntegrationApp, string>>;
};

export class FileIntegrationTokenProvider implements IntegrationTokenProvider {
  constructor(private readonly settings: Settings) {}

  async tokenFor(context: RequestContext, app: IntegrationApp): Promise<string | undefined> {
    const path = resolve(this.settings.agentSecretDir, "integration-tokens.json");
    let parsed: TokenFile;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8")) as TokenFile;
    } catch {
      return undefined;
    }
    const userToken = parsed.users?.[context.userId]?.[app];
    if (userToken) {
      return userToken;
    }
    return parsed.default?.[app];
  }
}
