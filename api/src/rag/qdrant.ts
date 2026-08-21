import { createHash } from "node:crypto";
import type { Settings } from "../config/settings.js";
import { normalizeMarkdownDirectory } from "../memory/markdownFilesystem.js";

export const RAG_PROVIDER_REQUEST_TIMEOUT_MS = 20_000;
export const RAG_PROVIDER_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

const RETRYABLE_HTTP_STATUSES = new Set([408, 409, 425, 429]);

export class RagOperationError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(input: {
    message: string;
    code: string;
    retryable: boolean;
    status?: number;
    cause?: unknown;
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "RagOperationError";
    this.code = input.code;
    this.retryable = input.retryable;
    this.status = input.status;
  }
}

export function isRetryableRagError(error: unknown): boolean {
  return !(error instanceof RagOperationError) || error.retryable;
}

export function providerHttpError(provider: "openai" | "qdrant", operation: string, status: number): RagOperationError {
  const retryable = status >= 500 || RETRYABLE_HTTP_STATUSES.has(status);
  return new RagOperationError({
    message: `${provider} ${operation} request failed with status ${status}.`,
    code: `${provider}_${operation}_http_${status}`,
    retryable,
    status
  });
}

export type BufferedRagProviderResponse = {
  ok: boolean;
  status: number;
  bodyText: string;
};

export async function fetchWithRagProviderDeadline(input: {
  provider: "openai" | "qdrant";
  operation: string;
  fetchImpl: typeof fetch;
  url: string;
  init?: RequestInit;
  timeoutMs?: number;
}): Promise<BufferedRagProviderResponse> {
  const timeoutMs = input.timeoutMs ?? RAG_PROVIDER_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let rejectTimeout: ((error: RagOperationError) => void) | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const timeout = setTimeout(() => {
    controller.abort();
    void activeReader?.cancel().catch(() => undefined);
    rejectTimeout?.(new RagOperationError({
      message: `${input.provider} ${input.operation} request timed out.`,
      code: `${input.provider}_${input.operation}_timeout`,
      retryable: true
    }));
  }, timeoutMs);
  timeout.unref();
  try {
    return await Promise.race([
      (async () => {
        const response = await input.fetchImpl(input.url, {
          ...input.init,
          signal: controller.signal
        });
        const declaredLength = response.headers.get("content-length");
        const declaredBytes = declaredLength && /^\d+$/.test(declaredLength)
          ? Number(declaredLength)
          : undefined;
        if (
          declaredBytes !== undefined
          && Number.isSafeInteger(declaredBytes)
          && declaredBytes > RAG_PROVIDER_MAX_RESPONSE_BYTES
        ) {
          controller.abort();
          await response.body?.cancel().catch(() => undefined);
          throw new RagOperationError({
            message: `${input.provider} ${input.operation} response exceeded the size limit.`,
            code: `${input.provider}_${input.operation}_response_too_large`,
            retryable: false
          });
        }
        let bodyText = "";
        if (response.body) {
          const reader = response.body.getReader();
          activeReader = reader;
          const decoder = new TextDecoder();
          const decoded: string[] = [];
          let receivedBytes = 0;
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                break;
              }
              receivedBytes += value.byteLength;
              if (receivedBytes > RAG_PROVIDER_MAX_RESPONSE_BYTES) {
                controller.abort();
                await reader.cancel().catch(() => undefined);
                throw new RagOperationError({
                  message: `${input.provider} ${input.operation} response exceeded the size limit.`,
                  code: `${input.provider}_${input.operation}_response_too_large`,
                  retryable: false
                });
              }
              decoded.push(decoder.decode(value, { stream: true }));
            }
            decoded.push(decoder.decode());
            bodyText = decoded.join("");
          } finally {
            reader.releaseLock();
            if (activeReader === reader) {
              activeReader = undefined;
            }
          }
        }
        return {
          ok: response.ok,
          status: response.status,
          bodyText
        };
      })(),
      timeoutPromise
    ]);
  } catch (error) {
    if (error instanceof RagOperationError) {
      throw error;
    }
    if (controller.signal.aborted) {
      throw new RagOperationError({
        message: `${input.provider} ${input.operation} request timed out.`,
        code: `${input.provider}_${input.operation}_timeout`,
        retryable: true,
        cause: error
      });
    }
    throw new RagOperationError({
      message: `${input.provider} ${input.operation} request failed before receiving a response.`,
      code: `${input.provider}_${input.operation}_network`,
      retryable: true,
      cause: error
    });
  } finally {
    clearTimeout(timeout);
  }
}

function parseProviderJson<T>(response: BufferedRagProviderResponse, provider: "openai" | "qdrant", operation: string): T {
  try {
    return JSON.parse(response.bodyText) as T;
  } catch (error) {
    throw new RagOperationError({
      message: `${provider} ${operation} response was malformed.`,
      code: `${provider}_${operation}_malformed_response`,
      retryable: false,
      cause: error
    });
  }
}

export type QdrantPoint = {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
};

export type QdrantSearchHit = {
  id: string;
  score: number;
  payload?: Record<string, unknown>;
};

export type QdrantClient = {
  health(): Promise<{ ok: boolean; status?: number }>;
  ensureCollection(collection: string, dimensions: number): Promise<void>;
  upsertPoints(collection: string, points: QdrantPoint[]): Promise<void>;
  deletePointsByDocumentId(collection: string, documentId: string): Promise<void>;
  search(collection: string, vector: number[], input?: { pathPrefix?: string; limit?: number }): Promise<QdrantSearchHit[]>;
  countPoints(collection: string): Promise<number>;
};

export function qdrantCollectionForUser(userId: string): string {
  const readable = userId
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32) || "user";
  const digest = createHash("sha256").update(userId).digest("hex").slice(0, 24);
  return `user_${readable}_${digest}_rag`;
}

export async function qdrantHealth(
  settings: Settings,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = RAG_PROVIDER_REQUEST_TIMEOUT_MS
): Promise<{
  ok: boolean;
  status?: number;
}> {
  const response = await fetchWithRagProviderDeadline({
    provider: "qdrant",
    operation: "health",
    fetchImpl,
    url: `${settings.qdrantUrl.replace(/\/$/, "")}/healthz`,
    timeoutMs
  }).catch(() => undefined);
  return {
    ok: response?.ok === true,
    status: response?.status
  };
}

function baseUrl(settings: Settings): string {
  return settings.qdrantUrl.replace(/\/$/, "");
}

function pathPrefixFilter(pathPrefix?: string): Record<string, unknown> | undefined {
  if (!pathPrefix) {
    return undefined;
  }
  const normalized = normalizeMarkdownDirectory(pathPrefix);
  if (normalized === "/") {
    return undefined;
  }
  return {
    must: [
      { key: "path_prefixes", match: { value: normalized || "/" } }
    ]
  };
}

export function qdrantDocumentFilter(documentId: string): Record<string, unknown> {
  return {
    must: [
      {
        key: "document_id",
        match: { value: documentId }
      }
    ]
  };
}

export class HttpQdrantClient implements QdrantClient {
  constructor(
    private readonly settings: Settings,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly requestTimeoutMs = RAG_PROVIDER_REQUEST_TIMEOUT_MS
  ) {}

  private request(operation: string, url: string, init?: RequestInit): Promise<BufferedRagProviderResponse> {
    return fetchWithRagProviderDeadline({
      provider: "qdrant",
      operation,
      fetchImpl: this.fetchImpl,
      url,
      init,
      timeoutMs: this.requestTimeoutMs
    });
  }

  private requireOk(response: BufferedRagProviderResponse, operation: string): void {
    if (!response.ok) {
      throw providerHttpError("qdrant", operation, response.status);
    }
  }

  async health(): Promise<{ ok: boolean; status?: number }> {
    return qdrantHealth(this.settings, this.fetchImpl, this.requestTimeoutMs);
  }

  async ensureCollection(collection: string, dimensions: number): Promise<void> {
    const get = await this.request("collection_check", `${baseUrl(this.settings)}/collections/${encodeURIComponent(collection)}`);
    if (get.ok) {
      return;
    }
    if (get.status !== 404) {
      throw providerHttpError("qdrant", "collection_check", get.status);
    }
    const created = await this.request("collection_create", `${baseUrl(this.settings)}/collections/${encodeURIComponent(collection)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        vectors: {
          size: dimensions,
          distance: "Cosine"
        }
      })
    });
    this.requireOk(created, "collection_create");
  }

  async upsertPoints(collection: string, points: QdrantPoint[]): Promise<void> {
    if (points.length === 0) {
      return;
    }
    const response = await this.request("point_upsert", `${baseUrl(this.settings)}/collections/${encodeURIComponent(collection)}/points?wait=true`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ points })
    });
    this.requireOk(response, "point_upsert");
  }

  async deletePointsByDocumentId(collection: string, documentId: string): Promise<void> {
    const response = await this.request("point_delete", `${baseUrl(this.settings)}/collections/${encodeURIComponent(collection)}/points/delete?wait=true`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filter: qdrantDocumentFilter(documentId) })
    });
    this.requireOk(response, "point_delete");
  }

  async search(collection: string, vector: number[], input: { pathPrefix?: string; limit?: number } = {}): Promise<QdrantSearchHit[]> {
    const response = await this.request("search", `${baseUrl(this.settings)}/collections/${encodeURIComponent(collection)}/points/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        vector,
        limit: Math.max(1, Math.min(input.limit ?? 10, 25)),
        with_payload: true,
        filter: pathPrefixFilter(input.pathPrefix)
      })
    });
    this.requireOk(response, "search");
    const body = parseProviderJson<{ result?: Array<{ id: unknown; score?: unknown; payload?: Record<string, unknown> }> }>(
      response,
      "qdrant",
      "search"
    );
    return (body.result ?? []).map((item) => ({
      id: String(item.id),
      score: Number(item.score ?? 0),
      payload: item.payload
    }));
  }

  async countPoints(collection: string): Promise<number> {
    const response = await this.request("point_count", `${baseUrl(this.settings)}/collections/${encodeURIComponent(collection)}/points/count`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ exact: true })
    });
    this.requireOk(response, "point_count");
    const body = parseProviderJson<unknown>(response, "qdrant", "point_count");
    const result = typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>).result
      : undefined;
    const count = typeof result === "object" && result !== null && !Array.isArray(result)
      ? (result as Record<string, unknown>).count
      : undefined;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      throw new RagOperationError({
        message: "qdrant point_count response was malformed.",
        code: "qdrant_point_count_malformed_response",
        retryable: false
      });
    }
    return count;
  }
}
