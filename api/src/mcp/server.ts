import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z, ZodError } from "zod";
import { createPool } from "../db/pool.js";
import { createMemoryStore, createPostgresStore } from "../domain/store.js";
import type { AgentStore, MarkdownConflict } from "../domain/types.js";
import { loadSettings, type Settings } from "../config/settings.js";
import { normalizeMarkdownDirectory } from "../memory/markdownFilesystem.js";
import { MockEmbeddingClient, OpenAIEmbeddingClient, type EmbeddingClient } from "../rag/embeddings.js";
import { HttpQdrantClient, type QdrantClient } from "../rag/qdrant.js";
import type { InboundMessageRecord } from "../domain/types.js";
import type { IntegrationTokenProvider } from "../tools/integrationGateway.js";
import { isToolName } from "../tools/contracts.js";
import { mcpToolDescriptors, ToolRegistry } from "../tools/registry.js";
import { validateToolArguments } from "../tools/validator.js";
import { GuardrailExceededError, guardrailResult } from "../security/safetyPolicy.js";

export type McpAppOptions = {
  settings?: Settings;
  store?: AgentStore;
  taskId?: string | null;
  embeddings?: EmbeddingClient;
  qdrant?: QdrantClient;
  integrationTokenProvider?: IntegrationTokenProvider;
  fetchImpl?: typeof fetch;
  ownerInitiated?: boolean;
  replyToMessage?: Pick<InboundMessageRecord, "fromAddr" | "source" | "subject" | "conversationThreadId">;
  now?: Date;
};

const memoryToolNames = [
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
  "search_exact",
  "search_semantic",
  "find_backlinks",
  "get_index_status",
  "reindex_path"
];
const toolNames = [...memoryToolNames, ...Object.keys(ToolRegistry)];

const McpPathSchema = z.string().min(1).max(500).regex(/^\//);
const McpMarkdownPathSchema = z.string().min(1).max(500).regex(/^\/.*\.md$/);
const McpSectionIdSchema = z.string().min(1).max(240);

const memoryToolSchemas = {
  list_dir: z.object({
    path: McpPathSchema.default("/")
  }).strict(),
  tree: z.object({
    path: McpPathSchema.default("/"),
    maxDepth: z.number().int().min(0).max(8).default(4)
  }).strict(),
  stat_path: z.object({
    path: McpPathSchema
  }).strict(),
  read_file: z.object({
    path: McpMarkdownPathSchema,
    version: z.number().int().positive().optional()
  }).strict(),
  delete_path: z.object({
    path: McpPathSchema,
    expectedVersion: z.number().int().positive().optional()
  }).strict(),
  move_path: z.object({
    from: McpPathSchema,
    to: McpPathSchema,
    expectedVersions: z.record(z.string().min(1), z.number().int().positive()).default({})
  }).strict(),
  read_section: z.object({
    path: McpMarkdownPathSchema,
    sectionId: McpSectionIdSchema
  }).strict(),
  replace_section: z.object({
    path: McpMarkdownPathSchema,
    sectionId: McpSectionIdSchema,
    content: z.string().min(1),
    expectedVersion: z.number().int().positive()
  }).strict(),
  append_to_section: z.object({
    path: McpMarkdownPathSchema,
    sectionId: McpSectionIdSchema,
    content: z.string().min(1),
    expectedVersion: z.number().int().positive()
  }).strict(),
  search_headings: z.object({
    query: z.string().min(1).max(500).optional(),
    pathPrefix: McpPathSchema.optional(),
    maxDepth: z.number().int().min(0).max(6).optional()
  }).strict(),
  grep: z.object({
    pattern: z.string().min(1).max(500),
    pathPrefix: McpPathSchema.optional(),
    caseSensitive: z.boolean().optional(),
    regex: z.boolean().optional(),
    contextLines: z.number().int().min(0).max(5).optional(),
    limit: z.number().int().min(1).max(100).optional()
  }).strict().refine((value) => {
    if (value.regex !== true) {
      return true;
    }
    try {
      new RegExp(value.pattern);
      return true;
    } catch {
      return false;
    }
  }, {
    path: ["pattern"],
    message: "Invalid regular expression."
  }),
  search_exact: z.object({
    query: z.string().min(1).max(500),
    pathPrefix: McpPathSchema.optional(),
    limit: z.number().int().min(1).max(50).optional()
  }).strict(),
  search_semantic: z.object({
    query: z.string().min(1).max(500),
    pathPrefix: McpPathSchema.optional(),
    limit: z.number().int().min(1).max(25).optional()
  }).strict(),
  find_backlinks: z.object({
    path: McpPathSchema,
    limit: z.number().int().min(1).max(100).optional()
  }).strict(),
  get_index_status: z.object({
    path: McpPathSchema.optional()
  }).strict(),
  reindex_path: z.object({
    path: McpPathSchema.default("/")
  }).strict()
} satisfies Record<string, z.ZodType<Record<string, unknown>>>;

function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  return match?.[1];
}

function mcpError(code: string, message: string, requestId: string | null = null, fieldErrors: unknown[] = []) {
  return {
    error: {
      code,
      message,
      field_errors: fieldErrors,
      request_id: requestId
    }
  };
}

function errorsFromZod(error: ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`);
}

function validateMemoryToolArguments(tool: string, args: unknown): {
  ok: true;
  arguments: Record<string, unknown>;
} | {
  ok: false;
  validationErrors: string[];
} {
  const schema = memoryToolSchemas[tool as keyof typeof memoryToolSchemas];
  if (!schema) {
    return { ok: true, arguments: payload(args) };
  }
  const parsed = schema.safeParse(args);
  if (parsed.success) {
    return { ok: true, arguments: parsed.data };
  }
  return { ok: false, validationErrors: errorsFromZod(parsed.error) };
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
    return createMemoryStore(settings);
  }
  return createPostgresStore(createPool(settings), settings);
}

export function buildMcpApp(options: McpAppOptions = {}): Hono {
  const settings = options.settings ?? loadSettings();
  const store = options.store ?? createDefaultStore(settings);
  const embeddings = options.embeddings ?? (settings.appEnv === "test" ? new MockEmbeddingClient() : new OpenAIEmbeddingClient(settings));
  const qdrant = options.qdrant ?? new HttpQdrantClient(settings);
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

  app.get("/mcp/v1/tools", (context) => context.json({
    tools: [
      ...memoryToolNames.map((name) => ({ name, surface: "memory_rag" })),
      ...mcpToolDescriptors()
    ]
  }));

  const callTool = async (context: Context, structured: boolean) => {
    const tool = context.req.param("tool");
    if (!tool) {
      return context.json(mcpError("unknown_tool", "Unknown MCP tool."), 404);
    }
    if (!toolNames.includes(tool)) {
      return context.json(mcpError("unknown_tool", "Unknown MCP tool."), 404);
    }
    const requestedRunId = context.req.header("x-agent-run-id") ?? null;
    const taskId = options.taskId ?? null;
    const ownerInitiated = options.ownerInitiated === true;
    const authContext = await store.resolveAgentMcpSession(bearerToken(context.req.header("authorization")), requestedRunId);
    if (!authContext) {
      return context.json(mcpError("mcp_unauthorized", "Valid agent MCP session required."), 401);
    }
    const runId = authContext.mcpRunId ?? null;
    if (authContext.mcpAllowedTools && !authContext.mcpAllowedTools.includes(tool)) {
      await store.recordAudit(authContext, "mcp.tool.rejected", "mcp_tool", tool, {
        run_id: runId,
        reason: "tool_forbidden",
        allowed_tools: authContext.mcpAllowedTools
      });
      return context.json(
        mcpError("mcp_tool_forbidden", "MCP session is not allowed to call this tool.", authContext.requestId),
        403
      );
    }
    let args = payload(await context.req.json().catch(() => ({})));

    try {
      let result: unknown;
      let sideEffect: "none" | "local_persistence" | "cross_app_api" = "none";
      let executed = true;
      if (isToolName(tool)) {
        const parsed = validateToolArguments(tool, args);
        if (!parsed.ok) {
          await store.recordAudit(authContext, "mcp.tool.rejected", "mcp_tool", tool, {
            run_id: runId,
            validation_error: parsed.validationErrors.join("; ")
          });
          return context.json(
            mcpError("mcp_validation_failed", "MCP tool arguments failed validation.", authContext.requestId, parsed.validationErrors),
            400
          );
        }
        args = parsed.arguments;
        const execution = await ToolRegistry[tool].execute({
          context: authContext,
          store,
          runId,
          taskId,
          settings,
          integrationTokenProvider: options.integrationTokenProvider,
          fetchImpl: options.fetchImpl,
          ownerInitiated,
          replyToMessage: options.replyToMessage,
          now: options.now
        }, parsed.arguments);
        result = execution.result;
        sideEffect = execution.sideEffect;
        executed = execution.executed;
      } else {
        const parsed = validateMemoryToolArguments(tool, args);
        if (!parsed.ok) {
          await store.recordAudit(authContext, "mcp.tool.rejected", "mcp_tool", tool, {
            run_id: runId,
            validation_error: parsed.validationErrors.join("; ")
          });
          return context.json(
            mcpError("mcp_validation_failed", "MCP tool arguments failed validation.", authContext.requestId, parsed.validationErrors),
            400
          );
        }
        args = parsed.arguments;
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
            expectedVersion: numberArg(args, "expectedVersion"),
            provenance: {
              sourceKind: "manual_edit",
              sourceLabel: "mcp write_file",
              confidence: "medium",
              evidence: ["Markdown file written through MCP session."],
              durability: "durable"
            }
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
            numberArg(args, "expectedVersion") ?? -1
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
        } else if (tool === "search_exact") {
          const prefix = typeof args.pathPrefix === "string" ? normalizeMarkdownDirectory(args.pathPrefix) : "/";
          const limit = Math.max(1, Math.min(numberArg(args, "limit") ?? 20, 50));
          const matches = (await store.searchMarkdownExact(authContext, stringArg(args, "query")))
            .filter((entry) => prefix === "/" || entry.path === prefix || entry.path.startsWith(`${prefix}/`))
            .slice(0, limit);
          result = { matches };
        } else if (tool === "search_semantic") {
          const limit = Math.max(1, Math.min(numberArg(args, "limit") ?? 10, 25));
          const collection = await store.ensureUserRagIndex(authContext);
          const [vector] = await embeddings.embedTexts({
            model: settings.ragEmbeddingModel,
            dimensions: settings.ragEmbeddingDimensions,
            texts: [stringArg(args, "query")]
          });
          const hits = await qdrant.search(collection, vector ?? [], {
            pathPrefix: typeof args.pathPrefix === "string" ? normalizeMarkdownDirectory(args.pathPrefix) : undefined,
            limit
          });
          result = {
            matches: await store.searchMarkdownSemantic(authContext, {
              pointIds: hits.map((hit) => hit.id),
              scoresByPointId: Object.fromEntries(hits.map((hit) => [hit.id, hit.score])),
              pathPrefix: typeof args.pathPrefix === "string" ? args.pathPrefix : undefined,
              limit
            }),
            guidance: "Read the source file or section before making significant memory edits based on semantic matches."
          };
        } else if (tool === "find_backlinks") {
          const target = stringArg(args, "path");
          result = {
            matches: await store.grepMarkdown(authContext, {
              pattern: target,
              regex: false,
              limit: numberArg(args, "limit") ?? 50
            })
          };
        } else if (tool === "get_index_status") {
          result = { statuses: await store.getMarkdownIndexStatus(authContext, typeof args.path === "string" ? args.path : undefined) };
        } else {
          result = { statuses: await store.reindexMarkdownPath(authContext, stringArg(args, "path", "/")) };
        }
      }

      await store.recordAudit(authContext, "mcp.tool.ok", "mcp_tool", tool, {
        path: typeof args.path === "string" ? args.path : null,
        run_id: runId,
        side_effect: sideEffect,
        executed
      });
      return context.json(isConflict(result) ? { error: result } : structured ? {
        ok: executed,
        tool,
        sideEffect,
        result
      } : { result }, isConflict(result) ? 409 : 200);
    } catch (error) {
      await store.recordAudit(authContext, "mcp.tool.failed", "mcp_tool", tool, {
        run_id: runId,
        error: error instanceof Error ? error.message : String(error)
      });
      if (error instanceof GuardrailExceededError) {
        return context.json({
          error: {
            code: "guardrail_exceeded",
            message: error.message,
            field_errors: [],
            request_id: authContext.requestId,
            reason: error.guardrail,
            details: guardrailResult(error)
          }
        }, 429);
      }
      return context.json(mcpError("mcp_tool_failed", "MCP tool failed.", authContext.requestId), 400);
    }
  };

  app.post("/mcp/v1/tools/:tool", (context) => callTool(context, false));
  app.post("/mcp/v1/tools/:tool/call", (context) => callTool(context, true));

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
