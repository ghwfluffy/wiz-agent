import { createHash } from "node:crypto";
import type { AgentStore, MarkdownDocumentRecord, RequestContext } from "../domain/types.js";
import { normalizeMarkdownPath } from "./markdownFilesystem.js";

export const MEMORY_LIST_ROOT = "/personal/lists";

export type MemoryListStatus = "active" | "archived" | "all";

export type MemoryListItem = {
  id: string;
  item: string;
  status: "active" | "archived";
  addedAt: string | null;
  source: string | null;
  notes: string | null;
  archivedAt: string | null;
  archiveReason: string | null;
};

export type ParsedMemoryList = {
  listId: string;
  title: string;
  path: string;
  items: MemoryListItem[];
};

const canonicalListHints: Array<{ id: string; title: string; patterns: RegExp[] }> = [
  { id: "movies", title: "Movies", patterns: [/\b(movie|movies|film|films|watch\s*list|watchlist|movie\s*night|western|westerns)\b/i] },
  { id: "project-ideas", title: "Project Ideas", patterns: [/\b(project\s*idea|project\s*ideas|idea\s*bucket|build\s*idea)\b/i] },
  { id: "books", title: "Books", patterns: [/\b(book|books|reading|to\s*read|read\s*later)\b/i] },
  { id: "restaurants", title: "Restaurants", patterns: [/\b(restaurant|restaurants|place\s*to\s*eat|places\s*to\s*eat|dinner\s*spot|lunch\s*spot)\b/i] },
  { id: "research", title: "Research", patterns: [/\b(research|research\s*topic|research\s*bucket|look\s*into|investigate)\b/i] },
  { id: "gift-ideas", title: "Gift Ideas", patterns: [/\b(gift|gifts|present|presents)\b/i] },
  { id: "things-to-buy", title: "Things To Buy", patterns: [/\b(things?\s*to\s*buy|shopping|buy\s*later|purchase\s*later)\b/i] }
];

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/['"`]+/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "list";
}

function titleize(slug: string): string {
  const canonical = canonicalListHints.find((hint) => hint.id === slug);
  if (canonical) {
    return canonical.title;
  }
  return slug.split("-").map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(" ");
}

export function normalizeMemoryListId(listName: string): string {
  const trimmed = listName.trim();
  const canonical = canonicalListHints.find((hint) => hint.patterns.some((pattern) => pattern.test(trimmed)));
  return canonical?.id ?? slugify(trimmed);
}

export function memoryListPathForName(listName: string): string {
  return `${MEMORY_LIST_ROOT}/${normalizeMemoryListId(listName)}.md`;
}

export function validateMemoryListPath(path: string): string {
  const normalized = normalizeMarkdownPath(path);
  if (!/^\/personal\/lists\/[a-z0-9][a-z0-9-]*\.md$/.test(normalized)) {
    throw new Error("Memory list paths must be markdown files under /personal/lists/.");
  }
  return normalized;
}

function listIdFromPath(path: string): string {
  return path.split("/").at(-1)?.replace(/\.md$/i, "") || "list";
}

function markerForList(listId: string): string {
  return `<!-- memory-list:v1 list_id="${listId}" -->`;
}

function normalizeComparable(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function itemId(listId: string, item: string): string {
  return `mli_${createHash("sha1").update(`${listId}:${normalizeComparable(item)}`).digest("hex").slice(0, 16)}`;
}

function escapeLine(value: string): string {
  return value.replace(/\r?\n/g, " ").trim();
}

function renderItem(item: MemoryListItem): string[] {
  const checkbox = item.status === "archived" ? "x" : " ";
  const lines = [`- [${checkbox}] ${escapeLine(item.item)} <!-- memory-list-item:${item.id} -->`];
  if (item.addedAt) {
    lines.push(`  - added: ${item.addedAt}`);
  }
  if (item.source) {
    lines.push(`  - source: ${escapeLine(item.source)}`);
  }
  if (item.notes) {
    lines.push(`  - notes: ${escapeLine(item.notes)}`);
  }
  if (item.archivedAt) {
    lines.push(`  - archived: ${item.archivedAt}`);
  }
  if (item.archiveReason) {
    lines.push(`  - archive_reason: ${escapeLine(item.archiveReason)}`);
  }
  return lines;
}

function renderList(list: ParsedMemoryList): string {
  const lines = [
    `# ${list.title}`,
    "",
    markerForList(list.listId),
    ""
  ];
  for (const item of list.items) {
    lines.push(...renderItem(item));
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function parseMetadataLine(line: string): { key: string; value: string } | null {
  const match = /^\s{2}-\s+([a-z_]+):\s*(.*)\s*$/.exec(line);
  return match ? { key: match[1] ?? "", value: match[2] ?? "" } : null;
}

export function parseMemoryListMarkdown(path: string, markdown: string): ParsedMemoryList {
  const normalized = validateMemoryListPath(path);
  const fallbackListId = listIdFromPath(normalized);
  const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || titleize(fallbackListId);
  const listId = markdown.match(/<!--\s*memory-list:v1\s+list_id="([^"]+)"\s*-->/)?.[1]?.trim() || fallbackListId;
  const items: MemoryListItem[] = [];
  let current: MemoryListItem | null = null;
  for (const line of markdown.split("\n")) {
    const itemMatch = /^-\s+\[([ xX])\]\s+(.+?)\s*(?:<!--\s*memory-list-item:([^>\s]+)\s*-->)?\s*$/.exec(line);
    if (itemMatch) {
      const itemText = (itemMatch[2] ?? "").trim();
      current = {
        id: itemMatch[3]?.trim() || itemId(listId, itemText),
        item: itemText,
        status: (itemMatch[1] ?? " ") === " " ? "active" : "archived",
        addedAt: null,
        source: null,
        notes: null,
        archivedAt: null,
        archiveReason: null
      };
      items.push(current);
      continue;
    }
    const metadata = current ? parseMetadataLine(line) : null;
    if (!metadata || !current) {
      continue;
    }
    if (metadata.key === "added") {
      current.addedAt = metadata.value || null;
    } else if (metadata.key === "source") {
      current.source = metadata.value || null;
    } else if (metadata.key === "notes") {
      current.notes = metadata.value || null;
    } else if (metadata.key === "archived") {
      current.archivedAt = metadata.value || null;
      current.status = "archived";
    } else if (metadata.key === "archive_reason") {
      current.archiveReason = metadata.value || null;
    }
  }
  return { listId, title, path: normalized, items };
}

function filterStatus(items: MemoryListItem[], status: MemoryListStatus): MemoryListItem[] {
  if (status === "all") {
    return items;
  }
  return items.filter((item) => item.status === status);
}

async function readList(options: {
  store: AgentStore;
  context: RequestContext;
  listName?: string;
  path?: string;
}): Promise<{ document: MarkdownDocumentRecord | undefined; list: ParsedMemoryList; path: string; listId: string }> {
  const path = options.path ? validateMemoryListPath(options.path) : memoryListPathForName(options.listName ?? "list");
  const document = await options.store.getMarkdownDocument(options.context, path);
  const listId = listIdFromPath(path);
  return {
    document,
    list: document
      ? parseMemoryListMarkdown(path, document.markdown)
      : { listId, title: titleize(listId), path, items: [] },
    path,
    listId
  };
}

export async function addMemoryListItem(options: {
  store: AgentStore;
  context: RequestContext;
  listName: string;
  item: string;
  notes?: string | null;
  sourceMessageId?: string | null;
  rationale: string;
  now?: Date;
}) {
  const current = await readList(options);
  const comparable = normalizeComparable(options.item);
  const duplicate = current.list.items.find((item) => normalizeComparable(item.item) === comparable);
  if (duplicate) {
    return {
      path: current.path,
      list_id: current.list.listId,
      list_title: current.list.title,
      item_id: duplicate.id,
      duplicate: true,
      item_count: current.list.items.filter((item) => item.status === "active").length,
      version: current.document?.version ?? null,
      rationale: options.rationale
    };
  }
  const item: MemoryListItem = {
    id: itemId(current.list.listId, options.item),
    item: escapeLine(options.item),
    status: "active",
    addedAt: (options.now ?? new Date()).toISOString(),
    source: options.sourceMessageId ? `owner_message:${escapeLine(options.sourceMessageId)}` : null,
    notes: options.notes ? escapeLine(options.notes) : null,
    archivedAt: null,
    archiveReason: null
  };
  current.list.items.push(item);
  const written = await options.store.writeMarkdownDocument(options.context, {
    path: current.path,
    markdown: renderList(current.list),
    expectedVersion: current.document?.version,
    provenance: {
      sourceKind: options.sourceMessageId ? "owner_message" : "owner_statement",
      sourceId: options.sourceMessageId ?? null,
      sourceLabel: options.item,
      confidence: "high",
      evidence: [options.rationale],
      durability: "durable",
      lastConfirmedAt: item.addedAt
    }
  });
  if ("code" in written) {
    return written;
  }
  await options.store.recordAudit(options.context, "memory_list.item.add", "markdown_document", written.id, {
    path: current.path,
    list_id: current.list.listId,
    item_id: item.id,
    duplicate: false
  });
  return {
    path: written.path,
    markdown_document_id: written.id,
    list_id: current.list.listId,
    list_title: current.list.title,
    item_id: item.id,
    duplicate: false,
    item_count: current.list.items.filter((entry) => entry.status === "active").length,
    version: written.version,
    rationale: options.rationale
  };
}

export async function listMemoryItems(options: {
  store: AgentStore;
  context: RequestContext;
  listName?: string;
  path?: string;
  status?: MemoryListStatus;
  limit?: number;
}) {
  const current = await readList(options);
  const status = options.status ?? "active";
  const items = filterStatus(current.list.items, status).slice(0, Math.max(1, Math.min(options.limit ?? 50, 100)));
  return {
    path: current.path,
    list_id: current.list.listId,
    list_title: current.list.title,
    updated_at: current.document?.updatedAt ?? null,
    version: current.document?.version ?? null,
    item_count: items.length,
    items
  };
}

function scoreList(query: string, list: ParsedMemoryList): number {
  const normalizedQuery = normalizeComparable(query);
  const queryTokens = new Set(normalizedQuery.split(" ").filter(Boolean));
  if (queryTokens.size === 0) {
    return 0;
  }
  let score = 0;
  const listText = normalizeComparable(`${list.listId} ${list.title}`);
  if (listText.includes(normalizedQuery)) {
    score += 8;
  }
  for (const hint of canonicalListHints) {
    if (hint.id === list.listId && hint.patterns.some((pattern) => pattern.test(query))) {
      score += 6;
    }
  }
  for (const token of queryTokens) {
    if (listText.split(" ").includes(token)) {
      score += 2;
    }
  }
  for (const item of list.items) {
    const itemText = normalizeComparable(`${item.item} ${item.notes ?? ""}`);
    if (itemText.includes(normalizedQuery)) {
      score += 10;
    }
    for (const token of queryTokens) {
      if (itemText.split(" ").includes(token)) {
        score += 3;
      }
    }
  }
  return score;
}

export async function searchMemoryLists(options: {
  store: AgentStore;
  context: RequestContext;
  query: string;
  limit?: number;
}) {
  const entries = await options.store.listMarkdownDirectory(options.context, MEMORY_LIST_ROOT);
  const files = entries.filter((entry) => entry.type === "file" && entry.path.endsWith(".md"));
  const candidates = [];
  for (const file of files) {
    const document = await options.store.getMarkdownDocument(options.context, file.path);
    if (!document) {
      continue;
    }
    const list = parseMemoryListMarkdown(document.path, document.markdown);
    const score = scoreList(options.query, list);
    if (score <= 0) {
      continue;
    }
    const matchedItems = list.items
      .filter((item) => scoreList(options.query, { ...list, items: [item] }) > 0)
      .slice(0, 10);
    candidates.push({
      path: list.path,
      list_id: list.listId,
      list_title: list.title,
      score,
      confidence: score >= 12 ? "high" : score >= 6 ? "medium" : "low",
      updated_at: document.updatedAt,
      matched_items: matchedItems
    });
  }
  candidates.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return {
    query: options.query,
    candidates: candidates.slice(0, Math.max(1, Math.min(options.limit ?? 10, 25))),
    guidance: "Use high-confidence matches directly; for low-confidence matches, say the match is uncertain."
  };
}

function findMutableItem(list: ParsedMemoryList, input: { itemId?: string; item?: string }): MemoryListItem | undefined {
  if (input.itemId) {
    return list.items.find((item) => item.id === input.itemId);
  }
  if (input.item) {
    const comparable = normalizeComparable(input.item);
    return list.items.find((item) => normalizeComparable(item.item) === comparable);
  }
  return undefined;
}

export async function updateMemoryListItem(options: {
  store: AgentStore;
  context: RequestContext;
  listName?: string;
  path?: string;
  itemId?: string;
  item?: string;
  newItem?: string | null;
  notes?: string | null;
  status?: "active" | "archived";
  archiveReason?: string | null;
  rationale: string;
  now?: Date;
}) {
  const current = await readList(options);
  const target = findMutableItem(current.list, options);
  if (!target || !current.document) {
    return { reason: "item_not_found", path: current.path };
  }
  if (options.newItem !== undefined && options.newItem !== null) {
    target.item = escapeLine(options.newItem);
  }
  if (options.notes !== undefined) {
    target.notes = options.notes ? escapeLine(options.notes) : null;
  }
  if (options.status) {
    target.status = options.status;
    if (options.status === "archived") {
      target.archivedAt = target.archivedAt ?? (options.now ?? new Date()).toISOString();
      target.archiveReason = options.archiveReason ? escapeLine(options.archiveReason) : target.archiveReason;
    } else {
      target.archivedAt = null;
      target.archiveReason = null;
    }
  }
  const written = await options.store.writeMarkdownDocument(options.context, {
    path: current.path,
    markdown: renderList(current.list),
    expectedVersion: current.document.version,
    provenance: {
      sourceKind: "owner_statement",
      sourceId: target.id,
      sourceLabel: target.item,
      confidence: "high",
      evidence: [options.rationale],
      durability: "durable",
      lastConfirmedAt: options.now?.toISOString()
    }
  });
  if ("code" in written) {
    return written;
  }
  await options.store.recordAudit(options.context, "memory_list.item.update", "markdown_document", written.id, {
    path: current.path,
    list_id: current.list.listId,
    item_id: target.id
  });
  return {
    path: written.path,
    markdown_document_id: written.id,
    list_id: current.list.listId,
    item_id: target.id,
    status: target.status,
    version: written.version,
    rationale: options.rationale
  };
}

export async function removeMemoryListItem(options: {
  store: AgentStore;
  context: RequestContext;
  listName?: string;
  path?: string;
  itemId?: string;
  item?: string;
  reason?: string | null;
  rationale: string;
  now?: Date;
}) {
  const current = await readList(options);
  const target = findMutableItem(current.list, options);
  if (!target || !current.document) {
    return { reason: "item_not_found", path: current.path };
  }
  target.status = "archived";
  target.archivedAt = target.archivedAt ?? (options.now ?? new Date()).toISOString();
  target.archiveReason = options.reason ? escapeLine(options.reason) : target.archiveReason;
  const written = await options.store.writeMarkdownDocument(options.context, {
    path: current.path,
    markdown: renderList(current.list),
    expectedVersion: current.document.version,
    provenance: {
      sourceKind: "owner_statement",
      sourceId: target.id,
      sourceLabel: target.item,
      confidence: "high",
      evidence: [options.rationale, options.reason ?? ""],
      durability: "durable",
      lastConfirmedAt: options.now?.toISOString()
    }
  });
  if ("code" in written) {
    return written;
  }
  await options.store.recordAudit(options.context, "memory_list.item.remove", "markdown_document", written.id, {
    path: current.path,
    list_id: current.list.listId,
    item_id: target.id,
    mode: "archive"
  });
  return {
    path: written.path,
    markdown_document_id: written.id,
    list_id: current.list.listId,
    item_id: target.id,
    removed: false,
    archived: true,
    item_count: current.list.items.filter((item) => item.status === "active").length,
    version: written.version,
    rationale: options.rationale
  };
}
