export type DiffLine = {
  kind: "context" | "add" | "remove";
  text: string;
};

export type ProposalHunk = {
  id: number;
  before: string[];
  after: string[];
};

const MAX_LCS_LINES = 240;

function splitLines(value: string): string[] {
  return value.replace(/\r\n?/g, "\n").split("\n");
}

/**
 * Produce a compact, deterministic line diff for AI proposals.
 * Large drafts deliberately avoid an O(n²) LCS and fall back to a bounded
 * changed-region view so previewing never stalls typing.
 */
export function buildProposalDiff(before: string, after: string): DiffLine[] {
  if (before === after) return splitLines(before).map((text) => ({ kind: "context", text }));
  const left = splitLines(before);
  const right = splitLines(after);
  if (left.length > MAX_LCS_LINES || right.length > MAX_LCS_LINES) {
    let prefix = 0;
    while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
    let suffix = 0;
    while (
      suffix < left.length - prefix &&
      suffix < right.length - prefix &&
      left[left.length - suffix - 1] === right[right.length - suffix - 1]
    ) suffix += 1;
    return [
      ...left.slice(Math.max(0, prefix - 2), prefix).map((text) => ({ kind: "context" as const, text })),
      ...left.slice(prefix, left.length - suffix).map((text) => ({ kind: "remove" as const, text })),
      ...right.slice(prefix, right.length - suffix).map((text) => ({ kind: "add" as const, text })),
      ...right.slice(right.length - suffix, right.length - Math.max(0, suffix - 2)).map((text) => ({ kind: "context" as const, text })),
    ];
  }

  const table = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i][j] = left[i] === right[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      result.push({ kind: "context", text: left[i] });
      i += 1;
      j += 1;
    } else if (j < right.length && (i === left.length || table[i][j + 1] >= table[i + 1][j])) {
      result.push({ kind: "add", text: right[j] });
      j += 1;
    } else {
      result.push({ kind: "remove", text: left[i] });
      i += 1;
    }
  }
  return result;
}

function groupedDiff(before: string, after: string):
  ({ kind: "context"; line: string } | { kind: "change"; hunk: ProposalHunk })[] {
  const groups: (
    { kind: "context"; line: string } | { kind: "change"; hunk: ProposalHunk }
  )[] = [];
  let active: ProposalHunk | null = null;
  for (const line of buildProposalDiff(before, after)) {
    if (line.kind === "context") {
      active = null;
      groups.push({ kind: "context", line: line.text });
      continue;
    }
    if (!active) {
      active = { id: groups.filter((item) => item.kind === "change").length, before: [], after: [] };
      groups.push({ kind: "change", hunk: active });
    }
    if (line.kind === "remove") active.before.push(line.text);
    else active.after.push(line.text);
  }
  return groups;
}

export function buildProposalHunks(before: string, after: string): ProposalHunk[] {
  return groupedDiff(before, after)
    .filter((group): group is { kind: "change"; hunk: ProposalHunk } => group.kind === "change")
    .map((group) => group.hunk);
}

/** Build the document produced by accepting only the selected change hunks. */
export function applyProposalHunkDecisions(
  before: string,
  after: string,
  accepted: Record<number, boolean>,
): string {
  const lines: string[] = [];
  for (const group of groupedDiff(before, after)) {
    if (group.kind === "context") {
      lines.push(group.line);
      continue;
    }
    lines.push(...(accepted[group.hunk.id] ? group.hunk.after : group.hunk.before));
  }
  return lines.join("\n");
}
