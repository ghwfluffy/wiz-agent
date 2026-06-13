import type { Settings } from "../config/settings.js";

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
  return `user_${userId.replace(/[^a-zA-Z0-9_-]/g, "_")}_rag`;
}

export async function qdrantHealth(settings: Settings, fetchImpl: typeof fetch = fetch): Promise<{
  ok: boolean;
  status?: number;
}> {
  const response = await fetchImpl(`${settings.qdrantUrl.replace(/\/$/, "")}/healthz`).catch(() => undefined);
  return {
    ok: response?.ok === true,
    status: response?.status
  };
}

function baseUrl(settings: Settings): string {
  return settings.qdrantUrl.replace(/\/$/, "");
}

function pathPrefixFilter(pathPrefix?: string): Record<string, unknown> | undefined {
  if (!pathPrefix || pathPrefix === "/") {
    return undefined;
  }
  const normalized = pathPrefix.startsWith("/") ? pathPrefix.replace(/\/$/, "") : `/${pathPrefix.replace(/\/$/, "")}`;
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
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async health(): Promise<{ ok: boolean; status?: number }> {
    return qdrantHealth(this.settings, this.fetchImpl);
  }

  async ensureCollection(collection: string, dimensions: number): Promise<void> {
    const get = await this.fetchImpl(`${baseUrl(this.settings)}/collections/${encodeURIComponent(collection)}`);
    if (get.ok) {
      return;
    }
    if (get.status !== 404) {
      throw new Error(`Qdrant collection check failed with status ${get.status}.`);
    }
    const created = await this.fetchImpl(`${baseUrl(this.settings)}/collections/${encodeURIComponent(collection)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        vectors: {
          size: dimensions,
          distance: "Cosine"
        }
      })
    });
    if (!created.ok) {
      throw new Error(`Qdrant collection create failed with status ${created.status}.`);
    }
  }

  async upsertPoints(collection: string, points: QdrantPoint[]): Promise<void> {
    if (points.length === 0) {
      return;
    }
    const response = await this.fetchImpl(`${baseUrl(this.settings)}/collections/${encodeURIComponent(collection)}/points?wait=true`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ points })
    });
    if (!response.ok) {
      throw new Error(`Qdrant point upsert failed with status ${response.status}.`);
    }
  }

  async deletePointsByDocumentId(collection: string, documentId: string): Promise<void> {
    const response = await this.fetchImpl(`${baseUrl(this.settings)}/collections/${encodeURIComponent(collection)}/points/delete?wait=true`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filter: qdrantDocumentFilter(documentId) })
    });
    if (!response.ok) {
      throw new Error(`Qdrant point delete failed with status ${response.status}.`);
    }
  }

  async search(collection: string, vector: number[], input: { pathPrefix?: string; limit?: number } = {}): Promise<QdrantSearchHit[]> {
    const response = await this.fetchImpl(`${baseUrl(this.settings)}/collections/${encodeURIComponent(collection)}/points/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        vector,
        limit: Math.max(1, Math.min(input.limit ?? 10, 25)),
        with_payload: true,
        filter: pathPrefixFilter(input.pathPrefix)
      })
    });
    if (!response.ok) {
      throw new Error(`Qdrant search failed with status ${response.status}.`);
    }
    const body = await response.json() as { result?: Array<{ id: unknown; score?: unknown; payload?: Record<string, unknown> }> };
    return (body.result ?? []).map((item) => ({
      id: String(item.id),
      score: Number(item.score ?? 0),
      payload: item.payload
    }));
  }

  async countPoints(collection: string): Promise<number> {
    const response = await this.fetchImpl(`${baseUrl(this.settings)}/collections/${encodeURIComponent(collection)}/points/count`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ exact: true })
    });
    if (!response.ok) {
      throw new Error(`Qdrant point count failed with status ${response.status}.`);
    }
    const body = await response.json() as { result?: { count?: unknown } };
    return Number(body.result?.count ?? 0);
  }
}
