import type { Settings } from "../config/settings.js";

export type EmbedTextsInput = {
  model: string;
  dimensions: number;
  texts: string[];
};

export type EmbeddingClient = {
  embedTexts(input: EmbedTextsInput): Promise<number[][]>;
};

export class MockEmbeddingClient implements EmbeddingClient {
  async embedTexts(input: EmbedTextsInput): Promise<number[][]> {
    return input.texts.map((text) => {
      const values = Array.from({ length: input.dimensions }, (_, index) => {
        const code = text.charCodeAt(index % Math.max(text.length, 1)) || 0;
        return ((code + index) % 97) / 97;
      });
      return values;
    });
  }
}

export class OpenAIEmbeddingClient implements EmbeddingClient {
  constructor(
    private readonly settings: Settings,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async embedTexts(input: EmbedTextsInput): Promise<number[][]> {
    if (!this.settings.agentOpenaiApiKey) {
      throw new Error("OpenAI API key is required for live embeddings.");
    }
    const response = await this.fetchImpl(`${this.settings.agentOpenaiBaseUrl.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.settings.agentOpenaiApiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: input.model,
        dimensions: input.dimensions,
        input: input.texts
      })
    });
    if (!response.ok) {
      throw new Error(`OpenAI embeddings request failed with status ${response.status}.`);
    }
    const body = await response.json() as { data?: Array<{ embedding?: unknown }> };
    const vectors = body.data?.map((item) => item.embedding);
    if (!vectors || vectors.length !== input.texts.length || vectors.some((vector) => !Array.isArray(vector))) {
      throw new Error("OpenAI embeddings response was malformed.");
    }
    return vectors.map((vector) => (vector as unknown[]).map(Number));
  }
}
