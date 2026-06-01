import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Settings } from "../config/settings.js";
import type { RequestContext } from "../domain/types.js";
import type { IntegrationApp, IntegrationTokenProvider } from "../tools/integrationGateway.js";

type TokenFile = {
  users?: Record<string, Partial<Record<IntegrationApp, string>>>;
  default?: Partial<Record<IntegrationApp, string>>;
};

function base64Url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function centralSubjectFromContext(context: RequestContext): string | undefined {
  const prefix = "oauth:central-oauth:";
  return context.userId.startsWith(prefix) ? context.userId.slice(prefix.length) : undefined;
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload, "ascii").digest("base64url");
}

export class FileIntegrationTokenProvider implements IntegrationTokenProvider {
  constructor(private readonly settings: Settings) {}

  async tokenFor(context: RequestContext, app: IntegrationApp, _scope = ""): Promise<string | undefined> {
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

export class SignedIntegrationTokenProvider implements IntegrationTokenProvider {
  constructor(
    private readonly settings: Settings,
    private readonly options: { now?: () => number } = {}
  ) {}

  async tokenFor(context: RequestContext, app: IntegrationApp, scope: string): Promise<string | undefined> {
    if (!this.settings.agentIntegrationTokenSecret) {
      return undefined;
    }
    const subject = centralSubjectFromContext(context);
    if (!subject) {
      return undefined;
    }
    const now = this.options.now?.() ?? Math.floor(Date.now() / 1000);
    const payload = base64Url(JSON.stringify({
      aud: app,
      exp: now + 300,
      iat: now,
      iss: "ghwiz-agent",
      scope,
      sub: subject
    }));
    return `agent-v1.${payload}.${sign(payload, this.settings.agentIntegrationTokenSecret)}`;
  }
}
