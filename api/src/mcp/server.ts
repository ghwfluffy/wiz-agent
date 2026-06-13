import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createPool } from "../db/pool.js";
import { createMemoryStore, createPostgresStore } from "../domain/store.js";
import type { AgentStore, MarkdownConflict } from "../domain/types.js";
import { loadSettings, type Settings } from "../config/settings.js";

export type McpAppOptions = {
  settings?: Settings;
  store?: AgentStore;
};

const toolNames = [
  "list_dir",
  "tree",
  "stat_path",
  "read_file",
  "write_file",
  "delete_path",
  "move_path",
  "read_section",
  "replace_section",
  "append_to_section",
  "search_headings",
  "grep",
  "get_index_status",
  "reindex_path"
];

function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  return match?.[1];
}

function isConflict(value: unknown): value is MarkdownConflict {
  return typeof value === "object" && value !== null && (value as { code?: unknown }).code === "conflict";
}

function payload(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function stringArg(args: Record<string, unknown>, key: string, fallback = ""): string {
  const value = args[key];
  return typeof value === "string" ? value : fallback;
}

function numberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanArg(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === "boolean" ? value : undefined;
}

function numberRecordArg(value: unknown): Record<string, number> {
  const input = payload(value);
  const output: Record<string, number> = {};
  for (const [key, item] of Object.entries(input)) {
    if (typeof item === "number" && Number.isFinite(item)) {
      output[key] = item;
    }
  }
  return output;
}

function createDefaultStore(settings: Settings): AgentStore {
  if (settings.appEnv === "test") {
    return createMemoryStore();
  }
  return createPostgresStore(createPool(settings));
}

export function buildMcpApp(options: McpAppOptions = {}): Hono {
  const settings = options.settings ?? loadSettings();
  const store = options.store ?? createDefaultStore(settings);
  const app = new Hono();

  app.get("/healthz", (context) => context.json({
    status: "ok",
    component: "agent-mcp"
  }));

  app.get("/mcp/v1/status", (context) => context.json({
    status: "ok",
    tools: toolNames,
    boundary: "server_resolves_authenticated_agent_user"
  }));

  app.post("/mcp/v1/tools/:tool", async (context) => {
    const tool = context.req.param("tool");
    if (!toolNames.includes(tool)) {
      return context.json({ error: { code: "unknown_tool", message: "Unknown MCP tool." } }, 404);
    }
    const runId = context.req.header("x-agent-run-id") ?? null;
    const authContext = await store.resolveAgentMcpSession(bearerToken(context.req.header("authorization")), runId);
    if (!authContext) {
      return context.json({ error: { code: "mcp_unauthorized", message: "Valid agent MCP session required." } }, 401);
    }
    const args = payload(await context.req.json().catch(() => ({})));

    try {
      let result: unknown;
      if (tool === "list_dir") {
        result = { entries: await store.listMarkdownDirectory(authContext, stringArg(args, "path", "/")) };
      } else if (tool === "tree") {
        const root = stringArg(args, "path", "/");
        const maxDepth = Math.max(0, Math.min(numberArg(args, "maxDepth") ?? 4, 8));
        const walk = async (path: string, depth: number): Promise<unknown[]> => {
          const entries = await store.listMarkdownDirectory(authContext, path);
          return Promise.all(entries.map(async (entry) => ({
            ...entry,
            children: entry.type === "directory" && depth < maxDepth ? await walk(entry.path, depth + 1) : undefined
          })));
        };
        result = { path: root, entries: await walk(root, 0) };
      } else if (tool === "stat_path") {
        const path = stringArg(args, "path");
        const document = await store.getMarkdownDocument(authContext, path);
        if (document) {
          result = { type: "file", path: document.path, version: document.version, updatedAt: document.updatedAt, indexStatus: document.indexStatus };
        } else {
          const entries = await store.listMarkdownDirectory(authContext, path);
          result = entries.length > 0 ? { type: "directory", path, children: entries.length } : { type: "missing", path };
        }
      } else if (tool === "read_file") {
        const document = await store.getMarkdownDocument(authContext, stringArg(args, "path"), numberArg(args, "version"));
        result = document ? { document } : { missing: true };
      } else if (tool === "write_file") {
        result = await store.writeMarkdownDocument(authContext, {
          path: stringArg(args, "path"),
          markdown: stringArg(args, "content"),
          expectedVersion: numberArg(args, "expectedVersion")
        });
      } else if (tool === "delete_path") {
        result = await store.deleteMarkdownPath(authContext, stringArg(args, "path"), numberArg(args, "expectedVersion"));
      } else if (tool === "move_path") {
        result = await store.moveMarkdownPath(authContext, {
          from: stringArg(args, "from"),
          to: stringArg(args, "to"),
          expectedVersions: numberRecordArg(args.expectedVersions)
        });
      } else if (tool === "read_section") {
        const section = await store.readMarkdownSection(authContext, stringArg(args, "path"), stringArg(args, "sectionId"));
        const document = await store.getMarkdownDocument(authContext, stringArg(args, "path"));
        result = section && document ? { section, content: document.markdown.split("\n").slice(section.lineStart - 1, section.lineEnd).join("\n") } : { missing: true };
      } else if (tool === "replace_section") {
        result = await store.replaceMarkdownSection(
          authContext,
          stringArg(args, "path"),
          stringArg(args, "sectionId"),
          stringArg(args, "content"),
          numberArg(args, "expectedVersion") ?? -1
        );
      } else if (tool === "append_to_section") {
        result = await store.appendMarkdownSection(
          authContext,
          stringArg(args, "path"),
          stringArg(args, "sectionId"),
          stringArg(args, "content"),
          numberArg(args, "expectedVersion")
        );
      } else if (tool === "search_headings") {
        result = {
          matches: await store.searchMarkdownHeadings(authContext, {
            query: typeof args.query === "string" ? args.query : undefined,
            pathPrefix: typeof args.pathPrefix === "string" ? args.pathPrefix : undefined,
            maxDepth: numberArg(args, "maxDepth")
          })
        };
      } else if (tool === "grep") {
        result = {
          matches: await store.grepMarkdown(authContext, {
            pattern: stringArg(args, "pattern"),
            pathPrefix: typeof args.pathPrefix === "string" ? args.pathPrefix : undefined,
            caseSensitive: booleanArg(args, "caseSensitive"),
            regex: booleanArg(args, "regex"),
            contextLines: numberArg(args, "contextLines"),
            limit: numberArg(args, "limit")
          })
        };
      } else if (tool === "get_index_status") {
        result = { statuses: await store.getMarkdownIndexStatus(authContext, typeof args.path === "string" ? args.path : undefined) };
      } else {
        result = { statuses: await store.reindexMarkdownPath(authContext, stringArg(args, "path", "/")) };
      }

      await store.recordAudit(authContext, "mcp.tool.ok", "mcp_tool", tool, {
        path: typeof args.path === "string" ? args.path : null,
        run_id: runId
      });
      return context.json(isConflict(result) ? { error: result } : { result }, isConflict(result) ? 409 : 200);
    } catch (error) {
      await store.recordAudit(authContext, "mcp.tool.failed", "mcp_tool", tool, {
        run_id: runId,
        error: error instanceof Error ? error.message : String(error)
      });
      return context.json({ error: { code: "mcp_tool_failed", message: "MCP tool failed." } }, 400);
    }
  });

  return app;
}

export function startMcpServer(): void {
  const settings = loadSettings();
  serve({
    fetch: buildMcpApp({ settings }).fetch,
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
