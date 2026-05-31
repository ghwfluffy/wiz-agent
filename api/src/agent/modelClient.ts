import type { ModelTier } from "./modelTiers.js";

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
  repairToolArguments(request: RepairToolArgumentsRequest): Promise<unknown>;
};

export class MockModelClient implements AgentModelClient {
  constructor(
    private readonly responses: {
      structured?: unknown[];
      tools?: unknown[];
      repairs?: unknown[];
    } = {}
  ) {}

  async runStructured(): Promise<unknown> {
    return this.responses.structured?.shift() ?? {};
  }

  async runWithTools(): Promise<unknown> {
    return this.responses.tools?.shift() ?? {};
  }

  async repairToolArguments(): Promise<unknown> {
    return this.responses.repairs?.shift() ?? {};
  }
}

export class OpenAIModelClient implements AgentModelClient {
  async runStructured(): Promise<unknown> {
    throw new Error("OpenAIModelClient is not wired yet. Use MockModelClient until OpenAI integration is implemented.");
  }

  async runWithTools(): Promise<unknown> {
    throw new Error("OpenAIModelClient is not wired yet. Use MockModelClient until OpenAI integration is implemented.");
  }

  async repairToolArguments(): Promise<unknown> {
    throw new Error("OpenAIModelClient is not wired yet. Use MockModelClient until OpenAI integration is implemented.");
  }
}
