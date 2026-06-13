const SNAPSHOT_CHAR_LIMIT = 12_000;
const DIFF_LINE_LIMIT = 220;

const sensitiveLinePattern = /\b(password|passwd|pwd|secret|token|api\s*key|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization|bearer)\b/i;
const assignmentSecretPattern = /(:\s*|=\s*)([A-Za-z0-9_./+=@:-]{8,})/g;

export type MarkdownSnapshot = {
  markdown: string;
  truncated: boolean;
};

export type MarkdownDiff = {
  unified: string;
  truncated: boolean;
  addedLines: number;
  removedLines: number;
};

export function redactedMarkdownSnapshot(markdown: string | null | undefined): MarkdownSnapshot {
  const input = markdown ?? "";
  const truncated = input.length > SNAPSHOT_CHAR_LIMIT;
  const bounded = truncated ? input.slice(0, SNAPSHOT_CHAR_LIMIT) : input;
  const redacted = bounded
    .split("\n")
    .map((line) => {
      if (!sensitiveLinePattern.test(line)) {
        return line;
      }
      const redacted = line.replace(assignmentSecretPattern, "$1[redacted]");
      return redacted === line ? "[redacted sensitive line]" : redacted;
    })
    .join("\n");
  return {
    markdown: redacted,
    truncated
  };
}

export function buildUnifiedMarkdownDiff(before: string, after: string): MarkdownDiff {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const rows = beforeLines.length + 1;
  const cols = afterLines.length + 1;
  const table = Array.from({ length: rows }, () => Array<number>(cols).fill(0));
  const cell = (row: number, col: number): number => table[row]?.[col] ?? 0;

  for (let i = beforeLines.length - 1; i >= 0; i -= 1) {
    for (let j = afterLines.length - 1; j >= 0; j -= 1) {
      const row = table[i];
      if (!row) {
        continue;
      }
      row[j] = beforeLines[i] === afterLines[j]
        ? cell(i + 1, j + 1) + 1
        : Math.max(cell(i + 1, j), cell(i, j + 1));
    }
  }

  const lines: string[] = [];
  let addedLines = 0;
  let removedLines = 0;
  let i = 0;
  let j = 0;
  while (i < beforeLines.length || j < afterLines.length) {
    if (i < beforeLines.length && j < afterLines.length && beforeLines[i] === afterLines[j]) {
      lines.push(` ${beforeLines[i]}`);
      i += 1;
      j += 1;
    } else if (j < afterLines.length && (i === beforeLines.length || cell(i, j + 1) >= cell(i + 1, j))) {
      lines.push(`+${afterLines[j]}`);
      addedLines += 1;
      j += 1;
    } else if (i < beforeLines.length) {
      lines.push(`-${beforeLines[i]}`);
      removedLines += 1;
      i += 1;
    }
  }

  const truncated = lines.length > DIFF_LINE_LIMIT;
  return {
    unified: (truncated ? lines.slice(0, DIFF_LINE_LIMIT) : lines).join("\n"),
    truncated,
    addedLines,
    removedLines
  };
}

export function markdownAuditDetails(input: {
  path: string;
  version: number;
  previousVersion: number | null;
  beforeMarkdown: string;
  afterMarkdown: string;
}): Record<string, unknown> {
  const before = redactedMarkdownSnapshot(input.beforeMarkdown);
  const after = redactedMarkdownSnapshot(input.afterMarkdown);
  const diff = buildUnifiedMarkdownDiff(before.markdown, after.markdown);
  return {
    path: input.path,
    version: input.version,
    previous_version: input.previousVersion,
    before_markdown: before.markdown,
    after_markdown: after.markdown,
    snapshot_truncated: before.truncated || after.truncated,
    unified_diff: diff.unified,
    diff_truncated: diff.truncated,
    added_lines: diff.addedLines,
    removed_lines: diff.removedLines
  };
}
