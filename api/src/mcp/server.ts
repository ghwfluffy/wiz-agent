import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadSettings } from "../config/settings.js";

export function buildMcpApp(): Hono {
  const app = new Hono();

  app.get("/healthz", (context) => context.json({
    status: "ok",
    component: "agent-mcp"
  }));

  app.get("/mcp/v1/status", (context) => context.json({
    status: "ok",
    tools: [],
    boundary: "server_resolves_authenticated_agent_user"
  }));

  return app;
}

export function startMcpServer(): void {
  const settings = loadSettings();
  serve({
    fetch: buildMcpApp().fetch,
    hostname: "0.0.0.0",
    port: settings.mcpServerPort
  });
  console.log(`AI Assistant MCP listening on 0.0.0.0:${settings.mcpServerPort}`);
}

export function isMcpEntrypoint(metaUrl: string, argvPath: string | undefined): boolean {
  return Boolean(argvPath && metaUrl === pathToFileURL(resolve(argvPath)).href);
}

if (isMcpEntrypoint(import.meta.url, process.argv[1])) {
  startMcpServer();
}
