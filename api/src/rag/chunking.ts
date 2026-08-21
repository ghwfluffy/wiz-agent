import { createHash } from "node:crypto";
import {
  basenameForPath,
  hashMarkdown,
  normalizeMarkdownPath,
  parseMarkdownSections
} from "../memory/markdownFilesystem.js";
import type { MarkdownDocumentRecord } from "../domain/types.js";

const MAX_CHUNK_CHARS = 1400;

function wellFormedText(value: string): string {
  return value.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "\uFFFD"
  );
}

export type RagChunk = {
  sectionId: string | null;
  headingPath: string[];
  chunkIndex: number;
  content: string;
  contentHash: string;
  pointId: string;
  path: string;
  dir: string;
  topLevel: string;
  filename: string;
  pathPrefixes: string[];
  title: string | null;
};

export function deterministicPointId(userId: string, documentId: string, documentVersion: number, chunkIndex: number): string {
  const hex = createHash("sha256")
    .update(`${userId}:${documentId}:${documentVersion}:${chunkIndex}`)
    .digest("hex")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function pathPrefixesForPath(path: string): string[] {
  const parts = normalizeMarkdownPath(path).split("/").filter(Boolean);
  const prefixes = ["/"];
  for (let index = 0; index < parts.length; index += 1) {
    prefixes.push(`/${parts.slice(0, index + 1).join("/")}`);
  }
  return prefixes;
}

function pathMetadata(path: string): Pick<RagChunk, "path" | "dir" | "topLevel" | "filename" | "pathPrefixes"> {
  const normalized = normalizeMarkdownPath(path);
  const parts = normalized.split("/").filter(Boolean);
  return {
    path: normalized,
    dir: parts.length <= 1 ? "/" : `/${parts.slice(0, -1).join("/")}`,
    topLevel: parts[0] ?? "",
    filename: basenameForPath(normalized),
    pathPrefixes: pathPrefixesForPath(normalized)
  };
}

function splitSectionContent(content: string): string[] {
  const trimmed = wellFormedText(content.trim());
  if (!trimmed) {
    return [];
  }
  if (trimmed.length <= MAX_CHUNK_CHARS) {
    return [trimmed];
  }
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of trimmed.split(/\n{2,}/)) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= MAX_CHUNK_CHARS) {
      current = candidate;
      continue;
    }
    if (current) {
      chunks.push(current);
      current = "";
    }
    for (let index = 0; index < paragraph.length;) {
      let end = Math.min(index + MAX_CHUNK_CHARS, paragraph.length);
      const finalCodeUnit = paragraph.charCodeAt(end - 1);
      const nextCodeUnit = paragraph.charCodeAt(end);
      if (
        end < paragraph.length
        && finalCodeUnit >= 0xD800
        && finalCodeUnit <= 0xDBFF
        && nextCodeUnit >= 0xDC00
        && nextCodeUnit <= 0xDFFF
      ) {
        end -= 1;
      }
      const piece = paragraph.slice(index, end).trim();
      if (piece) {
        chunks.push(piece);
      }
      index = end;
    }
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

export function chunkMarkdownDocumentWithStats(
  document: MarkdownDocumentRecord,
  limits: { maxSections?: number; maxChunks?: number } = {}
): {
  chunks: RagChunk[];
  sectionCount: number;
} {
  const metadata = pathMetadata(document.path);
  const chunks: RagChunk[] = [];
  const lines = document.markdown.split("\n");
  const sections = parseMarkdownSections(document.markdown);
  if (limits.maxSections !== undefined && sections.length > limits.maxSections) {
    return { chunks, sectionCount: sections.length };
  }
  for (const section of sections) {
    const content = lines.slice(section.lineStart - 1, section.lineEnd).join("\n");
    for (const piece of splitSectionContent(content)) {
      const chunkIndex = chunks.length;
      chunks.push({
        ...metadata,
        sectionId: section.sectionId,
        headingPath: section.headingPath,
        chunkIndex,
        content: piece,
        contentHash: hashMarkdown(piece),
        pointId: deterministicPointId(document.userId, document.id, document.version, chunkIndex),
        title: document.title
      });
      if (limits.maxChunks !== undefined && chunks.length > limits.maxChunks) {
        return { chunks, sectionCount: sections.length };
      }
    }
  }
  return { chunks, sectionCount: sections.length };
}

export function chunkMarkdownDocument(document: MarkdownDocumentRecord): RagChunk[] {
  return chunkMarkdownDocumentWithStats(document).chunks;
}
