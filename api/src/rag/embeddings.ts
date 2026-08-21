import type { Settings } from "../config/settings.js";
import {
  fetchWithRagProviderDeadline,
  providerHttpError,
  RAG_PROVIDER_REQUEST_TIMEOUT_MS,
  RagOperationError
} from "./qdrant.js";

export type EmbedTextsInput = {
  model: string;
  dimensions: number;
  texts: string[];
};

export type EmbeddingClient = {
  embedTexts(input: EmbedTextsInput): Promise<number[][]>;
};

function wellFormedEmbeddingText(value: string): string {
  return value.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "\uFFFD"
  );
}

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
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly requestTimeoutMs = RAG_PROVIDER_REQUEST_TIMEOUT_MS
  ) {}

  async embedTexts(input: EmbedTextsInput): Promise<number[][]> {
    if (!this.settings.agentOpenaiApiKey) {
      throw new RagOperationError({
        message: "OpenAI API key is required for live embeddings.",
        code: "openai_embeddings_missing_api_key",
        retryable: false
      });
    }
    const wellFormedTexts = input.texts.map(wellFormedEmbeddingText);
    const response = await fetchWithRagProviderDeadline({
      provider: "openai",
      operation: "embeddings",
      fetchImpl: this.fetchImpl,
      url: `${this.settings.agentOpenaiBaseUrl.replace(/\/$/, "")}/embeddings`,
      timeoutMs: this.requestTimeoutMs,
      init: {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.settings.agentOpenaiApiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: input.model,
          dimensions: input.dimensions,
          input: wellFormedTexts
        })
      }
    });
    if (!response.ok) {
      throw providerHttpError("openai", "embeddings", response.status);
    }
    let body: unknown;
    try {
      body = JSON.parse(response.bodyText) as unknown;
    } catch (error) {
      throw new RagOperationError({
        message: "openai embeddings response was malformed.",
        code: "openai_embeddings_malformed_response",
        retryable: false,
        cause: error
      });
    }
    const data = typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>).data
      : undefined;
    if (!Array.isArray(data) || data.length !== input.texts.length) {
      throw new RagOperationError({
        message: "openai embeddings response was malformed.",
        code: "openai_embeddings_malformed_response",
        retryable: false
      });
    }
    const vectors: number[][] = [];
    for (const item of data) {
      const vector = typeof item === "object" && item !== null && !Array.isArray(item)
        ? (item as Record<string, unknown>).embedding
        : undefined;
      if (
        !Array.isArray(vector)
        || vector.length !== input.dimensions
        || vector.some((value) => typeof value !== "number" || !Number.isFinite(value))
      ) {
        throw new RagOperationError({
          message: "openai embeddings response was malformed.",
          code: "openai_embeddings_malformed_response",
          retryable: false
        });
      }
      vectors.push(vector as number[]);
    }
    return vectors;
  }
}
