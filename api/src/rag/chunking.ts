import { createHash } from "node:crypto";
import {
  basenameForPath,
  hashMarkdown,
  normalizeMarkdownPath,
  parseMarkdownSections,
  sectionMarkdown
} from "../memory/markdownFilesystem.js";
import type { MarkdownDocumentRecord } from "../domain/types.js";

const MAX_CHUNK_CHARS = 1400;

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
  const trimmed = content.trim();
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
    for (let index = 0; index < paragraph.length; index += MAX_CHUNK_CHARS) {
      const piece = paragraph.slice(index, index + MAX_CHUNK_CHARS).trim();
      if (piece) {
        chunks.push(piece);
      }
    }
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

export function chunkMarkdownDocument(document: MarkdownDocumentRecord): RagChunk[] {
  const metadata = pathMetadata(document.path);
  const chunks: RagChunk[] = [];
  for (const section of parseMarkdownSections(document.markdown)) {
    const content = sectionMarkdown(document.markdown, section);
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
    }
  }
  return chunks;
}
