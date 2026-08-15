import type { Settings } from "../config/settings.js";
import type {
  AgentStore,
  RequestContext,
  WebResearchBundle,
  WebResearchSessionRecord
} from "../domain/types.js";
import {
  OpenAIWebResearchClient,
  type WebResearchClient,
  type WebResearchClientResult
} from "./openAiWebResearchClient.js";
import {
  assertOnlyKnownSourceUrls,
  canonicalizePublicUrl,
  prepareWebResearchQuery,
  sanitizeExternalEvidenceText,
  sanitizeExternalText,
  validateResearchSources,
  WebResearchPolicyError
} from "./webResearchSafety.js";

export type ConductWebResearchInput = {
  query: string;
  priorResearchSessionId?: string;
  purpose: "owner_question" | "follow_up" | "newsletter_enrichment";
  conversationThreadId?: string | null;
  sourceMessageId?: string | null;
  sourceTaskId?: string | null;
  sourceMarkdownPaths?: string[];
};

export async function conductWebResearch(options: {
  context: RequestContext;
  store: AgentStore;
  settings: Settings;
  input: ConductWebResearchInput;
  client?: WebResearchClient;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  now?: Date;
}): Promise<WebResearchSessionRecord> {
  if (!options.settings.agentWebResearchEnabled) {
    throw new Error("Web research is disabled by deployment policy.");
  }

  const now = options.now ?? new Date();
  const prior = options.input.priorResearchSessionId
    ? await options.store.getWebResearchSession(options.context, options.input.priorResearchSessionId)
    : undefined;
  if (options.input.priorResearchSessionId && !prior) {
    throw new WebResearchPolicyError(
      "prior_research_not_found",
      "The prior research session is missing or belongs to another user."
    );
  }
  if (prior && Date.parse(prior.expiresAt) <= now.getTime()) {
    throw new WebResearchPolicyError(
      "prior_research_expired",
      "The prior research context expired; start a fresh web research request."
    );
  }
  if (options.input.conversationThreadId) {
    const thread = await options.store.getConversationThread(options.context, options.input.conversationThreadId);
    if (!thread) {
      throw new WebResearchPolicyError(
        "conversation_thread_not_found",
        "The web research conversation thread is unavailable for this user."
      );
    }
  }

  const sourceMarkdownPaths = await validatedNewsletterPaths(
    options.store,
    options.context,
    options.input.sourceMarkdownPaths ?? []
  );
  const prepared = await prepareWebResearchQuery(options.input.query, options.settings);
  const client = options.client ?? new OpenAIWebResearchClient(options.settings, {
    fetchImpl: options.fetchImpl
  });
  const result = await client.research({
    query: prepared.query,
    priorBundle: prior?.bundle,
    queryWarnings: prepared.warnings,
    signal: options.signal,
    now
  });
  const normalized = await normalizeClientResult(result, options.settings, now);
  const expiresAt = new Date(
    now.getTime() + options.settings.agentWebResearchRetentionDays * 24 * 60 * 60 * 1000
  ).toISOString();
  return options.store.createWebResearchSession(options.context, {
    parentSessionId: prior?.id ?? null,
    conversationThreadId: options.input.conversationThreadId ?? prior?.conversationThreadId ?? null,
    sourceMessageId: options.input.sourceMessageId ?? null,
    sourceTaskId: options.input.sourceTaskId ?? null,
    outboundMessageId: null,
    query: prepared.query,
    purpose: prior ? "follow_up" : options.input.purpose,
    sourceMarkdownPaths,
    bundle: normalized.bundle,
    riskLevel: normalized.riskLevel,
    expiresAt
  });
}

async function validatedNewsletterPaths(
  store: AgentStore,
  context: RequestContext,
  paths: string[]
): Promise<string[]> {
  const accepted: string[] = [];
  for (const path of [...new Set(paths)].slice(0, 10)) {
    if (!/^\/newsletters\/\d{4}-\d{2}-\d{2}\/[a-zA-Z0-9._-]+\.md$/.test(path)) {
      throw new WebResearchPolicyError(
        "invalid_newsletter_source_path",
        "Web research source paths must identify ingested newsletter knowledge."
      );
    }
    if (!await store.getMarkdownDocument(context, path)) {
      throw new WebResearchPolicyError(
        "newsletter_source_not_found",
        "A referenced newsletter source was not found for this user."
      );
    }
    accepted.push(path);
  }
  return accepted;
}

async function normalizeClientResult(
  result: WebResearchClientResult,
  settings: Settings,
  now: Date
): Promise<WebResearchClientResult> {
  const originalSources = result.bundle.sources.slice(0, settings.agentWebResearchMaxSources);
  const sources = await validateResearchSources(originalSources, settings.agentWebResearchMaxSources);
  const sourceIdMap = new Map<string, string>();
  for (const original of originalSources) {
    let canonical: string;
    try {
      canonical = canonicalizePublicUrl(original.url);
    } catch {
      continue;
    }
    const validated = sources.find((source) => source.url === canonical);
    if (validated) {
      sourceIdMap.set(original.id, validated.id);
    }
  }
  if (result.bundle.status !== "unsafe" && sources.length === 0) {
    throw new WebResearchPolicyError(
      "missing_validated_sources",
      "Web research did not produce validated public evidence."
    );
  }

  const remapIds = (ids: string[]): string[] => {
    const mapped = [...new Set(ids.map((id) => sourceIdMap.get(id)).filter((id): id is string => Boolean(id)))];
    if (result.bundle.status !== "unsafe" && mapped.length === 0) {
      throw new WebResearchPolicyError(
        "missing_claim_source",
        "Web research evidence lost its validated source reference."
      );
    }
    return mapped;
  };
  const answer = sanitizeExternalEvidenceText(result.bundle.answer, settings.agentWebResearchMaxOutputChars);
  const claims = result.bundle.claims.slice(0, 30).map((claim, index) => ({
    id: `c${index + 1}`,
    text: sanitizeExternalEvidenceText(claim.text, 1200),
    sourceIds: remapIds(claim.sourceIds)
  })).filter((claim) => claim.text && claim.sourceIds.length > 0);
  const entities = result.bundle.entities.slice(0, 30).map((entity, index) => ({
    id: `e${index + 1}`,
    label: sanitizeExternalEvidenceText(entity.label, 300),
    description: sanitizeExternalEvidenceText(entity.description, 1000),
    sourceIds: remapIds(entity.sourceIds)
  })).filter((entity) => entity.label && entity.description && entity.sourceIds.length > 0);
  if (result.bundle.status !== "unsafe" && (!answer || claims.length === 0)) {
    throw new WebResearchPolicyError(
      "sanitized_evidence_empty",
      "Web research returned no safe citable answer."
    );
  }
  assertOnlyKnownSourceUrls(
    [answer, ...claims.map((claim) => claim.text), ...entities.flatMap((entity) => [entity.label, entity.description])].join("\n"),
    sources
  );
  const bundle: WebResearchBundle = {
    status: result.bundle.status,
    answer: answer || "I could not safely extract a citable answer from the web results.",
    claims,
    entities,
    sources,
    warnings: [...new Set(result.bundle.warnings.map((warning) => sanitizeExternalText(warning, 160)).filter(Boolean))].slice(0, 12),
    taint: "external_web",
    searchedAt: now.toISOString()
  };
  return {
    bundle,
    riskLevel: result.riskLevel
  };
}
