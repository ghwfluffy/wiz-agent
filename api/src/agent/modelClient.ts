import type { ModelTier } from "./modelTiers.js";
import type { Settings } from "../config/settings.js";

export type StructuredModelRequest = {
  model: string;
  tier: ModelTier;
  prompt: string;
  schemaName: string;
  schema: unknown;
};

export type ToolModelRequest = {
  model: string;
  tier: ModelTier;
  prompt: string;
  tools: unknown[];
};

export type TextModelRequest = {
  model: string;
  tier: ModelTier;
  prompt: string;
};

export type RepairToolArgumentsRequest = {
  model: string;
  tier: "repair";
  toolName: string;
  malformedArguments: unknown;
  contractShape: unknown;
  validationErrors: string[];
};

export type AgentModelClient = {
  runStructured(request: StructuredModelRequest): Promise<unknown>;
  runWithTools(request: ToolModelRequest): Promise<unknown>;
  runText(request: TextModelRequest): Promise<string>;
  repairToolArguments(request: RepairToolArgumentsRequest): Promise<unknown>;
};

export class MockModelClient implements AgentModelClient {
  constructor(
    private readonly responses: {
      structured?: unknown[];
      tools?: unknown[];
      text?: unknown[];
      repairs?: unknown[];
    } = {}
  ) {}

  async runStructured(): Promise<unknown> {
    return this.responses.structured?.shift() ?? {};
  }

  async runWithTools(): Promise<unknown> {
    return this.responses.tools?.shift() ?? {};
  }

  async runText(): Promise<string> {
    const response = this.responses.text?.shift();
    return typeof response === "string" ? response : "";
  }

  async repairToolArguments(): Promise<unknown> {
    return this.responses.repairs?.shift() ?? {};
  }
}

export class OpenAIModelClient implements AgentModelClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: {
    apiKey?: string;
    baseUrl?: string;
    fetchImpl?: typeof fetch;
  } = {}) {
    this.apiKey = options.apiKey ?? process.env.AGENT_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
    this.baseUrl = (options.baseUrl ?? process.env.AGENT_OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private readonly fetchImpl: typeof fetch;

  static fromSettings(settings: Settings, options: { fetchImpl?: typeof fetch } = {}): OpenAIModelClient {
    return new OpenAIModelClient({
      apiKey: settings.agentOpenaiApiKey,
      baseUrl: settings.agentOpenaiBaseUrl,
      fetchImpl: options.fetchImpl
    });
  }

  async runStructured(request: StructuredModelRequest): Promise<unknown> {
    const response = await this.createResponse({
      model: request.model,
      input: request.prompt,
      text: {
        format: {
          type: "json_schema",
          name: request.schemaName,
          strict: false,
          schema: request.schema
        }
      }
    });
    return parseJsonOutput(response);
  }

  async runWithTools(request: ToolModelRequest): Promise<unknown> {
    const response = await this.createResponse({
      model: request.model,
      input: request.prompt,
      tools: request.tools.map(toOpenAiTool)
    });
    const functionCall = findFunctionCall(response);
    if (functionCall) {
      return {
        toolName: functionCall.name,
        arguments: parseJson(functionCall.arguments)
      };
    }
    return parseJsonOrTextOutput(response);
  }

  async runText(request: TextModelRequest): Promise<string> {
    const response = await this.createResponse({
      model: request.model,
      input: request.prompt
    });
    return parseTextOutput(response);
  }

  async repairToolArguments(request: RepairToolArgumentsRequest): Promise<unknown> {
    const response = await this.createResponse({
      model: request.model,
      input: [
        "Repair these tool arguments so they satisfy the contract.",
        "Return only a JSON object with the repaired arguments.",
        `Tool: ${request.toolName}`,
        `Validation errors: ${JSON.stringify(request.validationErrors)}`,
        `Contract shape: ${JSON.stringify(request.contractShape)}`,
        `Malformed arguments: ${JSON.stringify(request.malformedArguments)}`
      ].join("\n"),
      text: {
        format: {
          type: "json_object"
        }
      }
    });
    return parseJsonOutput(response);
  }

  private async createResponse(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.apiKey) {
      throw new Error("OpenAI API key is not configured. Set AGENT_OPENAI_API_KEY in secrets.");
    }
    const response = await this.fetchImpl(`${this.baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const payload = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
      const detail = payload && typeof payload === "object" ? JSON.stringify(payload) : response.statusText;
      throw new Error(`OpenAI Responses API request failed: ${response.status} ${detail}`);
    }
    if (!payload || typeof payload !== "object") {
      throw new Error("OpenAI Responses API returned an invalid payload.");
    }
    return payload as Record<string, unknown>;
  }
}

function toOpenAiTool(tool: unknown): Record<string, unknown> {
  const descriptor = tool && typeof tool === "object" ? tool as Record<string, unknown> : {};
  if (typeof descriptor.name !== "string") {
    throw new Error("Tool descriptor is missing a name.");
  }
  return {
    type: "function",
    name: descriptor.name,
    description: `Deterministic host tool: ${descriptor.name}`,
    strict: false,
    parameters: descriptor.schema ?? { type: "object", additionalProperties: true }
  };
}

function findFunctionCall(response: Record<string, unknown>): { name: string; arguments: unknown } | undefined {
  const output = response.output;
  if (!Array.isArray(output)) {
    return undefined;
  }
  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const maybe = item as Record<string, unknown>;
    if (maybe.type === "function_call" && typeof maybe.name === "string") {
      return {
        name: maybe.name,
        arguments: maybe.arguments
      };
    }
  }
  return undefined;
}

function parseJsonOutput(response: Record<string, unknown>): unknown {
  if (typeof response.output_text === "string" && response.output_text.trim() !== "") {
    return parseJson(response.output_text);
  }
  const output = response.output;
  if (!Array.isArray(output)) {
    return {};
  }
  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const contentItem of content) {
      if (!contentItem || typeof contentItem !== "object") {
        continue;
      }
      const text = (contentItem as Record<string, unknown>).text;
      if (typeof text === "string" && text.trim() !== "") {
        return parseJson(text);
      }
    }
  }
  return {};
}

function parseJsonOrTextOutput(response: Record<string, unknown>): unknown {
  if (typeof response.output_text === "string" && response.output_text.trim() !== "") {
    return parseJsonOrText(response.output_text);
  }
  const output = response.output;
  if (!Array.isArray(output)) {
    return {};
  }
  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const contentItem of content) {
      if (!contentItem || typeof contentItem !== "object") {
        continue;
      }
      const text = (contentItem as Record<string, unknown>).text;
      if (typeof text === "string" && text.trim() !== "") {
        return parseJsonOrText(text);
      }
    }
  }
  return {};
}

function parseTextOutput(response: Record<string, unknown>): string {
  if (typeof response.output_text === "string" && response.output_text.trim() !== "") {
    return response.output_text.trim();
  }
  const output = response.output;
  if (!Array.isArray(output)) {
    return "";
  }
  const textParts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const contentItem of content) {
      if (!contentItem || typeof contentItem !== "object") {
        continue;
      }
      const text = (contentItem as Record<string, unknown>).text;
      if (typeof text === "string" && text.trim() !== "") {
        textParts.push(text.trim());
      }
    }
  }
  return textParts.join("\n\n").trim();
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function parseJsonOrText(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value.trim();
  }
}
