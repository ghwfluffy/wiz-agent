import { createHash } from "node:crypto";

export type ParsedMarkdownSection = {
  sectionId: string;
  parentSectionId: string | null;
  heading: string;
  headingPath: string[];
  level: number;
  lineStart: number;
  lineEnd: number;
  contentHash: string;
};

export function hashMarkdown(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeMarkdownPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed.startsWith("/")) {
    throw new Error("Markdown paths must be absolute.");
  }
  const parts = trimmed.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) {
    throw new Error("Markdown paths may not contain relative segments.");
  }
  return `/${parts.join("/")}`;
}

export function normalizeMarkdownDirectory(path: string): string {
  const normalized = normalizeMarkdownPath(path);
  return normalized === "/" ? "/" : normalized.replace(/\/+$/g, "");
}

export function basenameForPath(path: string): string {
  const normalized = normalizeMarkdownPath(path);
  return normalized.split("/").filter(Boolean).at(-1) ?? "";
}

export function titleFromMarkdown(markdown: string): string | null {
  const firstHeading = markdown.match(/^#\s+(.+)$/m);
  return firstHeading?.[1]?.trim() || null;
}

function slugPart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/`+/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "section";
}

function uniqueSectionId(base: string, used: Map<string, number>): string {
  const count = used.get(base) ?? 0;
  used.set(base, count + 1);
  return count === 0 ? base : `${base}-${count + 1}`;
}

export function parseMarkdownSections(markdown: string): ParsedMarkdownSection[] {
  const lines = markdown.split("\n");
  const headings: Array<{ line: number; level: number; heading: string; path: string[] }> = [];
  const stack: string[] = [];

  lines.forEach((line, index) => {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!match) {
      return;
    }
    const marker = match[1] ?? "";
    const headingText = match[2] ?? "";
    const level = marker.length;
    const heading = headingText.trim();
    stack.length = level - 1;
    stack[level - 1] = heading;
    headings.push({
      line: index + 1,
      level,
      heading,
      path: stack.slice(0, level)
    });
  });

  const sections: ParsedMarkdownSection[] = [];
  const used = new Map<string, number>();

  const firstHeading = headings[0];
  if (headings.length === 0 || (firstHeading && firstHeading.line > 1)) {
    const lineEnd = headings.length === 0 ? lines.length : (firstHeading?.line ?? 1) - 1;
    const content = lines.slice(0, lineEnd).join("\n");
    sections.push({
      sectionId: "_preamble",
      parentSectionId: null,
      heading: "_preamble",
      headingPath: [],
      level: 0,
      lineStart: 1,
      lineEnd,
      contentHash: hashMarkdown(content)
    });
  }

  const idsByHeadingIndex = new Map<number, string>();
  headings.forEach((heading, index) => {
    const sectionId = uniqueSectionId(heading.path.map(slugPart).join("/"), used);
    idsByHeadingIndex.set(index, sectionId);
  });

  headings.forEach((heading, index) => {
    const next = headings[index + 1];
    let parentSectionId: string | null = null;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const candidate = headings[cursor];
      if (candidate && candidate.level < heading.level) {
        parentSectionId = idsByHeadingIndex.get(cursor) ?? null;
        break;
      }
    }
    const lineEnd = next ? next.line - 1 : lines.length;
    const content = lines.slice(heading.line - 1, lineEnd).join("\n");
    sections.push({
      sectionId: idsByHeadingIndex.get(index) ?? slugPart(heading.heading),
      parentSectionId,
      heading: heading.heading,
      headingPath: heading.path,
      level: heading.level,
      lineStart: heading.line,
      lineEnd,
      contentHash: hashMarkdown(content)
    });
  });

  return sections;
}

export function sectionMarkdown(markdown: string, section: Pick<ParsedMarkdownSection, "lineStart" | "lineEnd">): string {
  return markdown.split("\n").slice(section.lineStart - 1, section.lineEnd).join("\n");
}

export function replaceSectionMarkdown(
  markdown: string,
  section: Pick<ParsedMarkdownSection, "lineStart" | "lineEnd">,
  replacement: string
): string {
  const lines = markdown.split("\n");
  const replacementLines = replacement.split("\n");
  lines.splice(section.lineStart - 1, section.lineEnd - section.lineStart + 1, ...replacementLines);
  return lines.join("\n");
}

export function appendToSectionMarkdown(
  markdown: string,
  section: Pick<ParsedMarkdownSection, "lineEnd">,
  addition: string
): string {
  const lines = markdown.split("\n");
  const insert = ["", ...addition.trimEnd().split("\n")];
  lines.splice(section.lineEnd, 0, ...insert);
  return lines.join("\n");
}

export function memorySlugToMarkdownPath(slug: string): string {
  if (slug === "personal-profile") {
    return "/personal/profile.md";
  }
  if (slug === "newsletter-preferences") {
    return "/preferences/newsletters.md";
  }
  if (slug === "agent-schedule") {
    return "/assistant/schedule.md";
  }
  const newsletter = /^newsletters-(\d{4}-\d{2}-\d{2})-(.+)$/.exec(slug);
  if (newsletter) {
    return `/newsletters/${newsletter[1]}/${newsletter[2]}.md`;
  }
  return `/legacy/${slug}.md`;
}
