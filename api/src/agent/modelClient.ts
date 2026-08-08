import type { ModelTier } from "./modelTiers.js";
import type { Settings } from "../config/settings.js";

export type StructuredModelRequest = {
  model: string;
  tier: ModelTier;
  prompt: string;
  schemaName: string;
  schema: unknown;
  signal?: AbortSignal;
};

export type ToolModelRequest = {
  model: string;
  tier: ModelTier;
  prompt: string;
  tools: unknown[];
  previousResponseId?: string;
  toolOutputs?: Array<{ callId: string; output: unknown }>;
  signal?: AbortSignal;
};

export type ToolModelTurn = {
  responseId?: string;
  calls: Array<{ callId: string; toolName: string; arguments: unknown }>;
  responseText?: string;
  toolName?: string;
  arguments?: unknown;
  callId?: string;
};

export type TextModelRequest = {
  model: string;
  tier: ModelTier;
  prompt: string;
  signal?: AbortSignal;
};

export type TranscribeAudioRequest = {
  model: string;
  file: Blob;
  filename: string;
  mimeType: string;
  prompt?: string;
  signal?: AbortSignal;
};

export type RepairToolArgumentsRequest = {
  model: string;
  tier: "repair";
  toolName: string;
  malformedArguments: unknown;
  contractShape: unknown;
  validationErrors: string[];
  signal?: AbortSignal;
};

export type AgentModelClient = {
  runStructured(request: StructuredModelRequest): Promise<unknown>;
  runWithTools(request: ToolModelRequest): Promise<unknown | ToolModelTurn>;
  runText(request: TextModelRequest): Promise<string>;
  transcribeAudio(request: TranscribeAudioRequest): Promise<string>;
  repairToolArguments(request: RepairToolArgumentsRequest): Promise<unknown>;
};

export class MockModelClient implements AgentModelClient {
  constructor(
    private readonly responses: {
      structured?: unknown[];
      tools?: unknown[];
      text?: unknown[];
      transcriptions?: unknown[];
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

  async transcribeAudio(): Promise<string> {
    const response = this.responses.transcriptions?.shift();
    return typeof response === "string" ? response : "";
  }

  async repairToolArguments(): Promise<unknown> {
    return this.responses.repairs?.shift() ?? {};
  }
}

export class OpenAIModelClient implements AgentModelClient {
  private readonly modelApiKey: string;
  private readonly modelBaseUrl: string;
  private readonly auxiliaryApiKey: string;
  private readonly auxiliaryBaseUrl: string;

  constructor(options: {
    apiKey?: string;
    baseUrl?: string;
    auxiliaryApiKey?: string;
    auxiliaryBaseUrl?: string;
    fetchImpl?: typeof fetch;
  } = {}) {
    this.modelApiKey = options.apiKey ?? process.env.AGENT_MODEL_API_KEY ?? process.env.AGENT_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
    this.modelBaseUrl = (options.baseUrl ?? process.env.AGENT_MODEL_BASE_URL ?? process.env.AGENT_OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.auxiliaryApiKey = options.auxiliaryApiKey ?? process.env.AGENT_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY ?? this.modelApiKey;
    this.auxiliaryBaseUrl = (options.auxiliaryBaseUrl ?? process.env.AGENT_OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private readonly fetchImpl: typeof fetch;

  static fromSettings(settings: Settings, options: { fetchImpl?: typeof fetch } = {}): OpenAIModelClient {
    return new OpenAIModelClient({
      apiKey: settings.agentModelApiKey,
      baseUrl: settings.agentModelBaseUrl,
      auxiliaryApiKey: settings.agentOpenaiApiKey,
      auxiliaryBaseUrl: settings.agentOpenaiBaseUrl,
      fetchImpl: options.fetchImpl
    });
  }

  async runStructured(request: StructuredModelRequest): Promise<unknown> {
    const response = await this.createResponse(
      {
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
      },
      {
        signal: request.signal
      }
    );
    return parseJsonOutput(response);
  }

  async runWithTools(request: ToolModelRequest): Promise<unknown> {
    const input = request.toolOutputs?.length
      ? request.toolOutputs.map((item) => ({
          type: "function_call_output",
          call_id: item.callId,
          output: typeof item.output === "string" ? item.output : JSON.stringify(item.output)
        }))
      : request.prompt;
    const response = await this.createResponse(
      {
        model: request.model,
        input,
        tools: request.tools.map(toOpenAiTool),
        ...(request.previousResponseId ? { previous_response_id: request.previousResponseId } : {})
      },
      {
        signal: request.signal
      }
    );
    const calls = findFunctionCalls(response);
    const firstCall = calls[0];
    if (typeof response.id !== "string" && firstCall) {
      return { toolName: firstCall.name, arguments: parseJson(firstCall.arguments) };
    }
    return {
      responseId: typeof response.id === "string" ? response.id : undefined,
      calls: calls.map((call) => ({
        callId: call.callId,
        toolName: call.name,
        arguments: parseJson(call.arguments)
      })),
      responseText: parseTextOutput(response) || undefined,
      ...(firstCall ? {
        toolName: firstCall.name,
        arguments: parseJson(firstCall.arguments),
        callId: firstCall.callId
      } : {})
    } satisfies ToolModelTurn;
  }

  async runText(request: TextModelRequest): Promise<string> {
    const response = await this.createResponse(
      {
        model: request.model,
        input: request.prompt
      },
      {
        signal: request.signal
      }
    );
    return parseTextOutput(response);
  }

  async transcribeAudio(request: TranscribeAudioRequest): Promise<string> {
    if (!this.auxiliaryApiKey) {
      throw new Error("OpenAI API key is not configured. Set AGENT_OPENAI_API_KEY in secrets.");
    }
    const form = new FormData();
    form.set("model", request.model);
    form.set("response_format", "json");
    if (request.prompt?.trim()) {
      form.set("prompt", request.prompt.trim());
    }
    form.set("file", request.file, request.filename);
    const response = await this.fetchImpl(`${this.auxiliaryBaseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.auxiliaryApiKey}`
      },
      body: form,
      signal: request.signal
    });
    const payload = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
      const detail = payload && typeof payload === "object" ? JSON.stringify(payload) : response.statusText;
      throw new Error(`OpenAI transcription request failed: ${response.status} ${detail}`);
    }
    if (!payload || typeof payload !== "object" || typeof (payload as Record<string, unknown>).text !== "string") {
      throw new Error("OpenAI transcription response did not include text.");
    }
    return ((payload as Record<string, unknown>).text as string).trim();
  }

  async repairToolArguments(request: RepairToolArgumentsRequest): Promise<unknown> {
    const response = await this.createResponse(
      {
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
      },
      {
        signal: request.signal
      }
    );
    return parseJsonOutput(response);
  }

  private async createResponse(
    body: Record<string, unknown>,
    options: { signal?: AbortSignal } = {}
  ): Promise<Record<string, unknown>> {
    if (!this.modelApiKey) {
      throw new Error("OpenAI API key is not configured. Set AGENT_OPENAI_API_KEY in secrets.");
    }
    const response = await this.fetchImpl(`${this.modelBaseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.modelApiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body),
      signal: options.signal
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

function findFunctionCalls(response: Record<string, unknown>): Array<{ callId: string; name: string; arguments: unknown }> {
  const output = response.output;
  if (!Array.isArray(output)) {
    return [];
  }
  const calls: Array<{ callId: string; name: string; arguments: unknown }> = [];
  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const maybe = item as Record<string, unknown>;
    if (maybe.type === "function_call" && typeof maybe.name === "string") {
      calls.push({
        callId: typeof maybe.call_id === "string" ? maybe.call_id : typeof maybe.id === "string" ? maybe.id : maybe.name,
        name: maybe.name,
        arguments: maybe.arguments
      });
    }
  }
  return calls;
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
