import type { Settings } from "../config/settings.js";
import type {
  AgentStore,
  MarkdownSemanticSearchResult,
  RequestContext
} from "../domain/types.js";
import {
  OpenAIEmbeddingClient,
  type EmbeddingClient
} from "./embeddings.js";
import {
  HttpQdrantClient,
  qdrantCollectionForUser,
  type QdrantClient
} from "./qdrant.js";

const NEWSLETTER_PATH_PREFIX = "/newsletters";
const NEWSLETTER_PATH_PATTERN = /^\/newsletters\/\d{4}-\d{2}-\d{2}\/[a-zA-Z0-9._-]+\.md$/;
const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 5;
const SEARCH_CANDIDATE_LIMIT = 20;
const MINIMUM_RECALL_SCORE = 0.25;
const RECALL_TIMEOUT_MS = 3_000;

export type NewsletterRecallDependencies = {
  embeddings: EmbeddingClient;
  qdrant: QdrantClient;
};

export type NewsletterRecallResult = {
  status: "available" | "unavailable";
  executed: boolean;
  matches: MarkdownSemanticSearchResult[];
  reason?: "dependencies_unavailable" | "qdrant_unhealthy" | "retrieval_failed" | "retrieval_timeout";
};

class NewsletterRecallTimeoutError extends Error {}

function boundedQuery(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function unavailable(reason: NewsletterRecallResult["reason"]): NewsletterRecallResult {
  return {
    status: "unavailable",
    executed: false,
    matches: [],
    reason
  };
}

function defaultDependencies(
  settings: Settings | undefined,
  fetchImpl: typeof fetch | undefined
): NewsletterRecallDependencies | undefined {
  if (!settings || settings.appEnv === "test") {
    return undefined;
  }
  return {
    embeddings: new OpenAIEmbeddingClient(settings, fetchImpl),
    qdrant: new HttpQdrantClient(settings, fetchImpl)
  };
}

async function withinRecallDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new NewsletterRecallTimeoutError("newsletter semantic recall timed out")), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

/**
 * Performs a host-owned, read-only semantic lookup over newsletter chunks.
 * Provider failures deliberately collapse to an unavailable result so an
 * owner conversation does not fail and the prompt cannot claim retrieval.
 */
export async function recallNewsletterKnowledge(options: {
  context: RequestContext;
  store: AgentStore;
  query: string;
  settings?: Settings;
  dependencies?: NewsletterRecallDependencies;
  fetchImpl?: typeof fetch;
  excludePaths?: readonly string[];
  limit?: number;
  timeoutMs?: number;
}): Promise<NewsletterRecallResult> {
  const query = boundedQuery(options.query);
  const settings = options.settings;
  const dependencies = options.dependencies ?? defaultDependencies(options.settings, options.fetchImpl);
  if (!query || !dependencies || !settings) {
    return unavailable("dependencies_unavailable");
  }

  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? RECALL_TIMEOUT_MS, RECALL_TIMEOUT_MS));
  const excludedPaths = new Set(options.excludePaths ?? []);
  try {
    return await withinRecallDeadline((async (): Promise<NewsletterRecallResult> => {
      const health = await dependencies.qdrant.health();
      if (!health.ok) {
        return unavailable("qdrant_unhealthy");
      }
      const [vector] = await dependencies.embeddings.embedTexts({
        model: settings.ragEmbeddingModel,
        dimensions: settings.ragEmbeddingDimensions,
        texts: [query]
      });
      if (!vector || vector.length !== settings.ragEmbeddingDimensions) {
        return unavailable("retrieval_failed");
      }
      const hits = await dependencies.qdrant.search(
        qdrantCollectionForUser(options.context.userId),
        vector,
        {
          pathPrefix: NEWSLETTER_PATH_PREFIX,
          limit: SEARCH_CANDIDATE_LIMIT
        }
      );
      const matches = await options.store.searchMarkdownSemantic(options.context, {
        pointIds: hits.map((hit) => hit.id),
        scoresByPointId: Object.fromEntries(hits.map((hit) => [hit.id, hit.score])),
        pathPrefix: NEWSLETTER_PATH_PREFIX,
        limit: SEARCH_CANDIDATE_LIMIT
      });
      const seenPaths = new Set<string>();
      const boundedMatches = matches
        .filter((match) => NEWSLETTER_PATH_PATTERN.test(match.path))
        .filter((match) => !excludedPaths.has(match.path))
        .filter((match) => Number.isFinite(match.score) && match.score >= MINIMUM_RECALL_SCORE)
        .filter((match) => {
          if (seenPaths.has(match.path)) {
            return false;
          }
          seenPaths.add(match.path);
          return true;
        })
        .slice(0, limit)
        .map((match) => ({
          ...match,
          excerpt: match.excerpt.replace(/\s+/g, " ").trim().slice(0, 700)
        }));
      return {
        status: "available",
        executed: true,
        matches: boundedMatches
      };
    })(), timeoutMs);
  } catch (error) {
    return unavailable(error instanceof NewsletterRecallTimeoutError ? "retrieval_timeout" : "retrieval_failed");
  }
}
