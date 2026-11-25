export type DiffSegmentKind = "equal" | "removed" | "added";

export interface DiffSegment {
  kind: DiffSegmentKind;
  text: string;
}

export interface WordDiffResult {
  segments: DiffSegment[];
  addedWords: number;
  removedWords: number;
  identical: boolean;
}

const TOKEN_RE = /\S+|\s+/g;
const MAX_LCS_CELLS = 250_000;

function tokenizeWithWhitespace(text: string): string[] {
  if (!text) return [];
  return text.match(TOKEN_RE) ?? [];
}

function countNonWhitespaceTokens(tokens: string[]): number {
  let count = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].trim().length > 0) count++;
  }
  return count;
}

function pushSegment(out: DiffSegment[], kind: DiffSegmentKind, text: string): void {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.kind === kind) {
    last.text += text;
  } else {
    out.push({ kind, text });
  }
}

/**
 * Exact LCS diff for two token slices whose product fits within `MAX_LCS_CELLS`.
 */
function lcsDiffTokens(a: string[], b: string[]): DiffSegment[] {
  const m = a.length;
  const n = b.length;
  if (m === 0 && n === 0) return [];
  if (m === 0) return [{ kind: "added", text: b.join("") }];
  if (n === 0) return [{ kind: "removed", text: a.join("") }];

  const width = n + 1;
  const dp = new Uint32Array((m + 1) * width);

  for (let i = m - 1; i >= 0; i--) {
    const row = i * width;
    const nextRow = (i + 1) * width;
    const tokA = a[i];
    const matchWeight = tokA.trim().length > 0 ? 4 : 1;
    for (let j = n - 1; j >= 0; j--) {
      if (tokA === b[j]) {
        dp[row + j] = dp[nextRow + j + 1] + matchWeight;
      } else {
        const down = dp[nextRow + j];
        const right = dp[row + j + 1];
        dp[row + j] = down >= right ? down : right;
      }
    }
  }

  const out: DiffSegment[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      pushSegment(out, "equal", a[i]);
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
      pushSegment(out, "removed", a[i]);
      i++;
    } else {
      pushSegment(out, "added", b[j]);
      j++;
    }
  }
  while (i < m) {
    pushSegment(out, "removed", a[i++]);
  }
  while (j < n) {
    pushSegment(out, "added", b[j++]);
  }
  return out;
}

/**
 * Line-level fallback for very large texts whose word-level LCS matrix would exceed `MAX_LCS_CELLS`.
 */
function lineFallbackDiff(leftText: string, rightText: string): DiffSegment[] {
  const leftLines = leftText.split(/(\n)/);
  const rightLines = rightText.split(/(\n)/);
  if (leftLines.length * rightLines.length <= MAX_LCS_CELLS) {
    return lcsDiffTokens(leftLines, rightLines);
  }
  const out: DiffSegment[] = [];
  if (leftText) pushSegment(out, "removed", leftText);
  if (rightText) pushSegment(out, "added", rightText);
  return out;
}

/**
 * Computes a word-level diff between two texts, preserving whitespace and line breaks.
 * Trims common prefixes/suffixes in O(N) first so nearly identical notes diff almost instantaneously.
 */
export function diffWords(leftText: string, rightText: string): WordDiffResult {
  const aNorm = leftText.replace(/\r\n/g, "\n").trim();
  const bNorm = rightText.replace(/\r\n/g, "\n").trim();
  if (aNorm === bNorm) {
    return {
      segments: aNorm ? [{ kind: "equal", text: aNorm }] : [],
      addedWords: 0,
      removedWords: 0,
      identical: true,
    };
  }

  const aTokens = tokenizeWithWhitespace(aNorm);
  const bTokens = tokenizeWithWhitespace(bNorm);

  let prefixLen = 0;
  const minLen = Math.min(aTokens.length, bTokens.length);
  while (prefixLen < minLen && aTokens[prefixLen] === bTokens[prefixLen]) {
    prefixLen++;
  }

  let suffixLen = 0;
  while (
    suffixLen < minLen - prefixLen &&
    aTokens[aTokens.length - 1 - suffixLen] === bTokens[bTokens.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const aMid = aTokens.slice(prefixLen, aTokens.length - suffixLen);
  const bMid = bTokens.slice(prefixLen, bTokens.length - suffixLen);

  const segments: DiffSegment[] = [];
  if (prefixLen > 0) {
    pushSegment(segments, "equal", aTokens.slice(0, prefixLen).join(""));
  }

  const midSegments =
    aMid.length * bMid.length <= MAX_LCS_CELLS
      ? lcsDiffTokens(aMid, bMid)
      : lineFallbackDiff(aMid.join(""), bMid.join(""));

  for (const seg of midSegments) {
    pushSegment(segments, seg.kind, seg.text);
  }

  if (suffixLen > 0) {
    pushSegment(segments, "equal", aTokens.slice(aTokens.length - suffixLen).join(""));
  }

  let addedWords = 0;
  let removedWords = 0;
  for (const seg of segments) {
    if (seg.kind === "added") addedWords += countNonWhitespaceTokens(tokenizeWithWhitespace(seg.text));
    else if (seg.kind === "removed") removedWords += countNonWhitespaceTokens(tokenizeWithWhitespace(seg.text));
  }

  return {
    segments,
    addedWords,
    removedWords,
    identical: addedWords === 0 && removedWords === 0,
  };
}

/**
 * Builds the plain body + OCR text string used for side-by-side word diffing.
 * Strips Joplin `:/<32-hex>` attachment links so filename differences do not clutter the diff.
 */
export function buildComparableText(
  body: string | undefined,
  attachments: Array<{ id: string; ocrText?: string }> | undefined
): string {
  const resourceIds = new Set((attachments ?? []).map((a) => a.id.toLowerCase()));
  let cleanedBody = body ?? "";
  if (cleanedBody && resourceIds.size > 0 && cleanedBody.includes(":/")) {
    cleanedBody = cleanedBody
      .replace(/!\[[^\]]*\]\(\s*:\/([0-9a-fA-F]{32})(?:\s+"[^"]*")?\s*\)/g, (m, id: string) =>
        resourceIds.has(id.toLowerCase()) ? "" : m
      )
      .replace(/\[[^\]]*\]\(\s*:\/([0-9a-fA-F]{32})(?:#[^\s()"'<>]*)?(?:\s+"[^"]*")?\s*\)/g, (m, id: string) =>
        resourceIds.has(id.toLowerCase()) ? "" : m
      )
      .replace(/<img\b[^>]*\bsrc=["']:\/([0-9a-fA-F]{32})["'][^>]*>/gi, (m, id: string) =>
        resourceIds.has(id.toLowerCase()) ? "" : m
      )
      .replace(/<a\b[^>]*\bhref=["']:\/([0-9a-fA-F]{32})(?:#[^"']*)?["'][^>]*>[\s\S]*?<\/a>/gi, (m, id: string) =>
        resourceIds.has(id.toLowerCase()) ? "" : m
      );
  }
  const bodyPart = cleanedBody.trim();
  const ocrParts = (attachments ?? [])
    .map((a) => a.ocrText?.trim() ?? "")
    .filter(Boolean)
    .sort();
  if (bodyPart && ocrParts.length > 0) {
    return `${bodyPart}\n\n${ocrParts.join("\n\n")}`;
  }
  return bodyPart || ocrParts.join("\n\n");
}
