import { createHash, type Hash } from 'node:crypto';
import type {
  DuplicateTier,
  RawJoplinItem,
  ResourceMetadata,
} from '../types/index.js';
import { markupLanguageOf, MARKUP_HTML, stripHtml, stripMarkdown } from './serializer.js';

/** Minimum normalized text length for a text-only note to qualify as an identical duplicate */
const MIN_IDENTICAL_TEXT_CHARS = 20;
/** Minimum word tokens for a text-only note to qualify as an identical duplicate */
const MIN_IDENTICAL_WORDS = 3;
/** Minimum word tokens for a note to participate in near-duplicate matching */
const MIN_NEAR_WORDS = 12;
/** Shingle width (word n-gram size) for near-duplicate detection */
const SHINGLE_WIDTH = 4;
/** Minimum unique shingles required to participate in near-duplicate matching */
const MIN_SHINGLES = 8;
/** Maximum normalized characters inspected per note for near-duplicate features */
const MAX_NEAR_CHARS = 16_000;
/** Maximum word tokens inspected per note for near-duplicate shingles and word-bag Jaccard */
const MAX_NEAR_WORDS = 2_000;
/** Chunk size for whitespace-aligned streaming normalization of large notes/OCR text (stays in V8 young gen) */
const NORM_CHUNK_CHARS = 16_384;
/** Maximum unique shingles stored per note (KMV smallest-hash sketch: 384 * 4B = 1.5 KB max) */
const MAX_SHINGLES_PER_NOTE = 384;
/** Number of smallest shingle hashes indexed per note for candidate retrieval */
const BOTTOM_K_INDEX = 48;
/** Skip shingles appearing in more than this many distinct notes (corpus boilerplate) */
const MAX_SHINGLE_DF = 60;
/** Minimum 4-word shingle Jaccard for near-duplicates */
const MIN_SHINGLE_JACCARD = 0.55;
/** Minimum unique word Jaccard for near-duplicates */
const MIN_WORD_JACCARD = 0.72;
/** Minimum word-count ratio between near-duplicate notes */
const MIN_LENGTH_RATIO = 0.7;
/** Minimum Jaccard agreement on extracted dates/numbers/months when present */
const MIN_FACT_JACCARD = 0.75;
/** Minimum Jaccard agreement on explicit month/quarter tokens when both notes contain them */
const MIN_MONTH_JACCARD = 0.75;
/** Minimum total attachment byte-size ratio for near-duplicate notes with attachments */
const MIN_ATTACHMENT_SIZE_RATIO = 0.65;

const INBOX_SEGMENT_RE = /^(?:pending(?:\s+to\s+sort)?|inbox|unsorted|to\s+sort|unfiled)$/i;

const MONTH_ALIASES: Record<string, string> = {
  january: 'm:jan',
  jan: 'm:jan',
  february: 'm:feb',
  feb: 'm:feb',
  march: 'm:mar',
  mar: 'm:mar',
  april: 'm:apr',
  apr: 'm:apr',
  june: 'm:jun',
  jun: 'm:jun',
  july: 'm:jul',
  jul: 'm:jul',
  august: 'm:aug',
  aug: 'm:aug',
  september: 'm:sep',
  sept: 'm:sep',
  sep: 'm:sep',
  october: 'm:oct',
  oct: 'm:oct',
  november: 'm:nov',
  nov: 'm:nov',
  december: 'm:dec',
  dec: 'm:dec',
};

const MONTH_BIT: Record<string, number> = {
  'm:jan': 1 << 0,
  'm:feb': 1 << 1,
  'm:mar': 1 << 2,
  'm:apr': 1 << 3,
  'm:may': 1 << 4,
  'm:jun': 1 << 5,
  'm:jul': 1 << 6,
  'm:aug': 1 << 7,
  'm:sep': 1 << 8,
  'm:oct': 1 << 9,
  'm:nov': 1 << 10,
  'm:dec': 1 << 11,
  'q:q1': 1 << 12,
  'q:q2': 1 << 13,
  'q:q3': 1 << 14,
  'q:q4': 1 << 15,
};

const COLLAPSE_WS_RE = /(?:[\t\n\r\f\v\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]| {2,})\s*/g;
const MULTI_SPACE_RE = / {2,}/g;
const CJK_CHAR_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const UNICODE_WORD_CHAR_RE = /^[\p{L}\p{N}]/u;
const WORD_SEGMENT_RE = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;
const NUMBER_RE = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;
const MAY_DATE_RE = /\b(?:may\s+\d{1,4}|\d{1,2}(?:st|nd|rd|th)?\s+may)\b/g;
const QUARTER_RE = /\bq[1-4]\b/g;
const ALPHA_WORD_RE = /[a-z]{3,9}/g;

const EMPTY_ATTACHMENTS: AttachmentSpec[] = [];
const EMPTY_UINT32 = new Uint32Array(0);

export interface DuplicateNoteInput {
  note: RawJoplinItem;
  notebookTitle: string;
  notebookPath: string;
  tagCount: number;
  linkedResources: ResourceMetadata[];
}

export interface DetectedDuplicateCluster {
  id: string;
  tier: DuplicateTier;
  score: number;
  evidence: string;
  suggestedKeeperId: string;
  noteIds: string[];
}

interface AttachmentSpec {
  mime: string;
  mimeGroup: string;
  size: number;
}

interface NoteFingerprint {
  inputIndex: number;
  noteId: string;
  title: string;
  createdTime: number;
  updatedTime: number;
  tagCount: number;
  isInboxLike: boolean;
  hasBodyText: boolean;
  hasOcrText: boolean;
  combinedLength: number;
  combinedHash: string;
  wordCount: number;
  attachments: AttachmentSpec[];
  attachmentSig: string;
  totalAttachmentBytes: number;
  hasSubstantialAttachment: boolean;
  /** Canonical ordering of linkedResources indices when >= 2 resources carry OCR text */
  ocrOrder?: number[];
  /** Compact sorted KMV sketch of 4-word shingle hashes from bounded prefix (<= 2 KB) */
  shingles?: Uint32Array;
  /** Lazily populated ONLY when a candidate pair passes shingle Jaccard */
  wordHashes?: Uint32Array;
  factHashes?: Uint32Array;
  monthMask?: number;
}

/**
 * Canonical unordered pair key for two 32-hex note IDs (used for dismissed duplicate pairs).
 */
export function canonicalPairKey(idA: string, idB: string): string {
  return idA < idB ? `${idA}:${idB}` : `${idB}:${idA}`;
}

/** Formats byte counts concisely for duplicate evidence labels. */
export function formatBytesCompact(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let val = bytes;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val >= 10 || i === 0 ? Math.round(val) : val.toFixed(1)} ${units[i]}`;
}

/** Whether a notebook title/path represents an inbox or unsorted holding area. */
export function isInboxLikeNotebook(notebookTitle: string, notebookPath: string): boolean {
  const trimmedTitle = notebookTitle.trim();
  const trimmedPath = notebookPath.trim();
  if (!trimmedTitle && !trimmedPath) return true;
  if (trimmedTitle && INBOX_SEGMENT_RE.test(trimmedTitle)) return true;
  if (trimmedPath) {
    for (const seg of trimmedPath.split('/')) {
      if (INBOX_SEGMENT_RE.test(seg.trim())) return true;
    }
  }
  return false;
}

function mimeGroupOf(mime: string): string {
  const lower = mime.toLowerCase().trim();
  if (lower.startsWith('image/')) return 'image';
  if (lower === 'application/pdf') return 'pdf';
  if (lower.startsWith('audio/')) return 'audio';
  if (lower.startsWith('video/')) return 'video';
  return lower || 'application/octet-stream';
}

function isBlank(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code > 32) {
      // Non-ASCII whitespace check (e.g. NBSP, ideographic space)
      if (code < 128) return false;
      if (str[i].trim().length > 0) return false;
    } else if (code !== 32 && code !== 9 && code !== 10 && code !== 13 && code !== 11 && code !== 12) {
      return false;
    }
  }
  return true;
}

/**
 * Removes Joplin attachment links (`![...](:/id)`, `[...](:/id)`, `<img src=":/id">`, `<a href=":/id">`)
 * targeting known resources so attachment filenames do not distort text comparison.
 */
function stripResourceLinks(body: string, hasResourceId: (idLower: string) => boolean): string {
  if (!body || !body.includes(':/')) return body;
  let cleaned = body;
  if (cleaned.includes('![')) {
    cleaned = cleaned.replace(
      /!\[[^\]]*\]\(\s*:\/([0-9a-fA-F]{32})(?:\s+"[^"]*")?\s*\)/g,
      (match, id: string) => (hasResourceId(id.toLowerCase()) ? ' ' : match)
    );
  }
  if (cleaned.includes('[')) {
    cleaned = cleaned.replace(
      /\[[^\]]*\]\(\s*:\/([0-9a-fA-F]{32})(?:#[^\s()"'<>]*)?(?:\s+"[^"]*")?\s*\)/g,
      (match, id: string) => (hasResourceId(id.toLowerCase()) ? ' ' : match)
    );
  }
  if (cleaned.includes('<')) {
    cleaned = cleaned.replace(
      /<img\b[^>]*\bsrc=["']:\/([0-9a-fA-F]{32})["'][^>]*>/gi,
      (match, id: string) => (hasResourceId(id.toLowerCase()) ? ' ' : match)
    );
    cleaned = cleaned.replace(
      /<a\b[^>]*\bhref=["']:\/([0-9a-fA-F]{32})(?:#[^"']*)?["'][^>]*>[\s\S]*?<\/a>/gi,
      (match, id: string) => (hasResourceId(id.toLowerCase()) ? ' ' : match)
    );
  }
  return cleaned;
}

/** Normalizes text for content comparison: NFKC, lowercase, collapsed single spaces. */
export function normalizeContentText(raw: string): string {
  if (!raw) return '';
  let out = raw.normalize('NFKC').toLowerCase().replace(COLLAPSE_WS_RE, ' ');
  if (out.includes('  ')) out = out.replace(MULTI_SPACE_RE, ' ');
  return out.trim();
}

/** Normalizes already-whitespace-collapsed plaintext (from stripHtml/stripMarkdown) without re-running whitespace regexes when pure ASCII. */
function normalizeCollapsedText(raw: string): string {
  if (!raw) return '';
  const normed = raw.normalize('NFKC');
  const lower = normed.toLowerCase();
  // NFKC can introduce spaces from compatibility chars (e.g. U+00A8); only re-collapse if non-ASCII changed length or added double spaces
  if (normed !== raw || lower.includes('  ')) {
    let out = lower.replace(COLLAPSE_WS_RE, ' ');
    if (out.includes('  ')) out = out.replace(MULTI_SPACE_RE, ' ');
    return out.trim();
  }
  return lower;
}

function isAsciiWs(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13;
}

/**
 * Streams normalized text in whitespace-aligned chunks so multi-megabyte OCR strings are hashed
 * and word-counted without ever allocating a full normalized copy.
 * Emits non-empty chunks separated by logical single spaces. Returning `false` from `onChunk`
 * stops streaming early (used for bounded-prefix extraction).
 */
function streamNormalizedChunks(
  raw: string,
  onChunk: (chunk: string) => boolean | void,
  alreadyCollapsed = false
): void {
  if (!raw) return;
  const normalize = alreadyCollapsed ? normalizeCollapsedText : normalizeContentText;
  if (raw.length <= NORM_CHUNK_CHARS) {
    const norm = normalize(raw);
    if (norm) onChunk(norm);
    return;
  }

  let pos = 0;
  const len = raw.length;
  while (pos < len) {
    while (pos < len && isAsciiWs(raw.charCodeAt(pos))) pos++;
    if (pos >= len) break;

    let end = Math.min(len, pos + NORM_CHUNK_CHARS);
    if (end < len) {
      let split = end;
      while (split > pos && !isAsciiWs(raw.charCodeAt(split))) {
        split--;
      }
      if (split > pos) {
        end = split;
      } else {
        // No ASCII whitespace before end; scan forward to avoid splitting a token across chunks
        split = end;
        while (split < len && !isAsciiWs(raw.charCodeAt(split))) {
          split++;
        }
        end = split;
      }
    }

    const norm = normalize(raw.slice(pos, end));
    pos = end;
    if (norm) {
      if (onChunk(norm) === false) return;
    }
  }
}

function isAsciiWordCode(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || (code >= 65 && code <= 90);
}

function isCjkCode(code: number): boolean {
  return (
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff)
  );
}

function isNonCjkWordCodeAt(text: string, idx: number): boolean {
  const code = text.charCodeAt(idx);
  if (code < 128) return isAsciiWordCode(code);
  if (isCjkCode(code)) return false;
  const cp = text.codePointAt(idx)!;
  const ch = cp > 0xffff ? text.slice(idx, idx + 2) : text[idx];
  return UNICODE_WORD_CHAR_RE.test(ch);
}

/**
 * Counts word tokens in normalized text without allocating any word strings or arrays.
 * Matches `tokenizeWords(normalized).length` (including CJK single-character splitting and contractions).
 */
export function countWordsInNormalized(normalized: string): number {
  const len = normalized.length;
  if (len === 0) return 0;
  let count = 0;
  let inWord = false;

  for (let i = 0; i < len; ) {
    const code = normalized.charCodeAt(i);
    if (code < 128) {
      if (isAsciiWordCode(code)) {
        if (!inWord) {
          count++;
          inWord = true;
        }
      } else if (code === 39 && inWord && i + 1 < len && isNonCjkWordCodeAt(normalized, i + 1)) {
        // Apostrophe inside contraction (e.g. don't) keeps the current word open
      } else {
        inWord = false;
      }
      i++;
    } else if (isCjkCode(code)) {
      count++;
      inWord = false;
      i++;
    } else if (code === 0x2019 && inWord && i + 1 < len && isNonCjkWordCodeAt(normalized, i + 1)) {
      i++;
    } else {
      const cp = normalized.codePointAt(i)!;
      const step = cp > 0xffff ? 2 : 1;
      const ch = step === 2 ? normalized.slice(i, i + 2) : normalized[i];
      if (UNICODE_WORD_CHAR_RE.test(ch)) {
        if (!inWord) {
          count++;
          inWord = true;
        }
      } else {
        inWord = false;
      }
      i += step;
    }
  }
  return count;
}

function avalanche32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function hashString32(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return avalanche32(h);
}

/** ASCII character class lookup table: 0 = delimiter, 1 = [a-zA-Z0-9], 2 = apostrophe (') */
const ASCII_CHAR_CLASS = new Uint8Array(128);
for (let c = 48; c <= 57; c++) ASCII_CHAR_CLASS[c] = 1;
for (let c = 65; c <= 90; c++) ASCII_CHAR_CLASS[c] = 1;
for (let c = 97; c <= 122; c++) ASCII_CHAR_CLASS[c] = 1;
ASCII_CHAR_CLASS[39] = 2;

/** Out-param updated by `scanPrefixWordHashes` with the character index where scanning stopped. */
let lastScanEndChar = 0;

/**
 * Scans normalized text and writes 32-bit FNV-1a word hashes directly into `outHashes` up to
 * `maxWords` tokens without allocating any word strings. Runs a tight ASCII inner loop and
 * switches to Unicode/CJK handling only if a non-ASCII character (>= 128) is encountered.
 */
function scanPrefixWordHashes(normalized: string, outHashes: Uint32Array, maxWords: number): number {
  const len = normalized.length;
  lastScanEndChar = len;
  if (len === 0 || maxWords <= 0) return 0;

  let count = 0;
  let i = 0;

  while (i < len && count < maxWords) {
    // Skip ASCII delimiters
    while (i < len) {
      const c = normalized.charCodeAt(i);
      if (c >= 128) return scanUnicodePrefixWordHashes(normalized, outHashes, maxWords, i, count);
      if (ASCII_CHAR_CLASS[c] === 1) break;
      i++;
    }
    if (i >= len) break;

    const wordStart = i;
    let h = 2166136261;
    while (i < len) {
      const c = normalized.charCodeAt(i);
      if (c >= 128) {
        return scanUnicodePrefixWordHashes(normalized, outHashes, maxWords, wordStart, count);
      }
      const cls = ASCII_CHAR_CLASS[c];
      if (cls === 1) {
        h = Math.imul(h ^ c, 16777619);
        i++;
      } else if (cls === 2 && i + 1 < len) {
        const next = normalized.charCodeAt(i + 1);
        if (next >= 128) {
          return scanUnicodePrefixWordHashes(normalized, outHashes, maxWords, wordStart, count);
        }
        if (ASCII_CHAR_CLASS[next] === 1) {
          h = Math.imul(h ^ c, 16777619);
          i++;
        } else {
          break;
        }
      } else {
        break;
      }
    }
    outHashes[count++] = h >>> 0;
  }
  lastScanEndChar = i;
  return count;
}

function scanUnicodePrefixWordHashes(
  normalized: string,
  outHashes: Uint32Array,
  maxWords: number,
  startIdx: number,
  startCount: number
): number {
  const len = normalized.length;
  let count = startCount;
  let inWord = false;
  let h = 2166136261;
  let i = startIdx;

  for (; i < len && count < maxWords; ) {
    const code = normalized.charCodeAt(i);
    if (code < 128) {
      const cls = ASCII_CHAR_CLASS[code];
      if (cls === 1) {
        if (!inWord) {
          h = 2166136261;
          inWord = true;
        }
        h = Math.imul(h ^ code, 16777619);
      } else if (cls === 2 && inWord && i + 1 < len && isNonCjkWordCodeAt(normalized, i + 1)) {
        h = Math.imul(h ^ code, 16777619);
      } else if (inWord) {
        outHashes[count++] = h >>> 0;
        inWord = false;
      }
      i++;
    } else if (isCjkCode(code)) {
      if (inWord) {
        outHashes[count++] = h >>> 0;
        inWord = false;
        if (count >= maxWords) break;
      }
      outHashes[count++] = Math.imul(2166136261 ^ code, 16777619) >>> 0;
      i++;
    } else if (code === 0x2019 && inWord && i + 1 < len && isNonCjkWordCodeAt(normalized, i + 1)) {
      h = Math.imul(h ^ code, 16777619);
      i++;
    } else {
      const cp = normalized.codePointAt(i)!;
      const step = cp > 0xffff ? 2 : 1;
      const ch = step === 2 ? normalized.slice(i, i + 2) : normalized[i];
      if (UNICODE_WORD_CHAR_RE.test(ch)) {
        if (!inWord) {
          h = 2166136261;
          inWord = true;
        }
        h = Math.imul(h ^ code, 16777619);
        if (step === 2) {
          h = Math.imul(h ^ normalized.charCodeAt(i + 1), 16777619);
        }
      } else if (inWord) {
        outHashes[count++] = h >>> 0;
        inWord = false;
      }
      i += step;
    }
  }

  if (inWord && count < maxWords) {
    outHashes[count++] = h >>> 0;
  }
  lastScanEndChar = i;
  return count;
}

/** Tokenizes normalized text into words (splitting CJK runs into characters so n-grams work without spaces). */
export function tokenizeWords(normalized: string): string[] {
  if (!normalized) return [];
  const words: string[] = [];
  const matches = normalized.match(WORD_SEGMENT_RE);
  if (!matches) return words;
  for (const seg of matches) {
    if (CJK_CHAR_RE.test(seg)) {
      let asciiBuf = '';
      for (const ch of seg) {
        if (CJK_CHAR_RE.test(ch)) {
          if (asciiBuf) {
            words.push(asciiBuf);
            asciiBuf = '';
          }
          words.push(ch);
        } else {
          asciiBuf += ch;
        }
      }
      if (asciiBuf) words.push(asciiBuf);
    } else {
      words.push(seg);
    }
  }
  return words;
}

/**
 * Extracts normalized numeric amounts, dates, months, and quarters so documents sharing boilerplate
 * (such as monthly bank statements or invoices) are distinguished by their concrete figures and dates.
 */
export function extractFactualTokens(normalized: string): { facts: Set<string>; months: Set<string> } {
  const facts = new Set<string>();
  const months = new Set<string>();
  if (!normalized) return { facts, months };

  const numbers = normalized.match(NUMBER_RE);
  if (numbers) {
    for (const raw of numbers) {
      let clean = raw.replace(/,/g, '');
      if (clean.includes('.')) {
        clean = clean.replace(/\.?0+$/, '');
      }
      // Collapse leading zeros on short numeric tokens (e.g. 03 -> 3) while keeping codes like 0042 distinct if longer
      if (clean.length === 2 && clean.startsWith('0') && clean !== '00') {
        clean = clean.slice(1);
      }
      if (clean) facts.add(`n:${clean}`);
    }
  }

  if (MAY_DATE_RE.test(normalized)) {
    MAY_DATE_RE.lastIndex = 0;
    months.add('m:may');
    facts.add('m:may');
  }

  const quarters = normalized.match(QUARTER_RE);
  if (quarters) {
    for (const q of quarters) {
      months.add(`q:${q}`);
      facts.add(`q:${q}`);
    }
  }

  const wordMatches = normalized.match(ALPHA_WORD_RE);
  if (wordMatches) {
    for (const w of wordMatches) {
      const alias = MONTH_ALIASES[w];
      if (alias) {
        months.add(alias);
        facts.add(alias);
      }
    }
  }

  return { facts, months };
}

/** Compact equivalent of `extractFactualTokens`: sorted `Uint32Array` of fact hashes + 16-bit month/quarter mask. */
function extractFactualSignature(normalized: string): { factHashes: Uint32Array; monthMask: number } {
  if (!normalized) return { factHashes: EMPTY_UINT32, monthMask: 0 };
  const rawHashes: number[] = [];
  let monthMask = 0;

  NUMBER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NUMBER_RE.exec(normalized)) !== null) {
    let clean = m[0];
    if (clean.includes(',')) clean = clean.replace(/,/g, '');
    if (clean.includes('.')) clean = clean.replace(/\.?0+$/, '');
    if (clean.length === 2 && clean.startsWith('0') && clean !== '00') {
      clean = clean.slice(1);
    }
    if (clean) rawHashes.push(hashString32(`n:${clean}`));
  }

  MAY_DATE_RE.lastIndex = 0;
  if (MAY_DATE_RE.test(normalized)) {
    MAY_DATE_RE.lastIndex = 0;
    monthMask |= MONTH_BIT['m:may'];
    rawHashes.push(hashString32('m:may'));
  }

  QUARTER_RE.lastIndex = 0;
  while ((m = QUARTER_RE.exec(normalized)) !== null) {
    const key = `q:${m[0]}`;
    monthMask |= MONTH_BIT[key] ?? 0;
    rawHashes.push(hashString32(key));
  }

  ALPHA_WORD_RE.lastIndex = 0;
  while ((m = ALPHA_WORD_RE.exec(normalized)) !== null) {
    const alias = MONTH_ALIASES[m[0]];
    if (alias) {
      monthMask |= MONTH_BIT[alias] ?? 0;
      rawHashes.push(hashString32(alias));
    }
  }

  if (rawHashes.length === 0) {
    return { factHashes: EMPTY_UINT32, monthMask };
  }
  const arr = Uint32Array.from(rawHashes);
  arr.sort();
  return { factHashes: dedupeSortedUint32(arr, arr.length), monthMask };
}

function dedupeSortedUint32(sorted: Uint32Array, len: number, maxLen = len): Uint32Array {
  let uniqueLen = 0;
  for (let i = 0; i < len; i++) {
    if (i === 0 || sorted[i] !== sorted[i - 1]) {
      sorted[uniqueLen++] = sorted[i];
    }
  }
  const finalLen = Math.min(uniqueLen, maxLen);
  return sorted.slice(0, finalLen);
}

/** Unrolled 32-bit FNV-1a + Murmur3 avalanche mix over 4 consecutive word hashes (SHINGLE_WIDTH = 4). */
function hashShingle4(w0: number, w1: number, w2: number, w3: number): number {
  let h = Math.imul(2166136261 ^ w0, 16777619);
  h ^= h >>> 13;
  h = Math.imul(h ^ w1, 16777619);
  h ^= h >>> 13;
  h = Math.imul(h ^ w2, 16777619);
  h ^= h >>> 13;
  h = Math.imul(h ^ w3, 16777619);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Builds a sorted, deduplicated `Uint32Array` of 4-word shingle hashes from pre-hashed prefix words.
 * Retains at most `MAX_SHINGLES_PER_NOTE` smallest hashes (KMV sketch).
 * For large shingle counts, pre-filters hashes below an estimated KMV cutoff so only ~1.6*K items
 * are sorted instead of the full array (falling back to a full sort if unique count < K).
 */
function buildShingleSetFromWordHashes(
  wordHashes: Uint32Array,
  tokenCount: number,
  scratchShingles: Uint32Array
): Uint32Array {
  const count = tokenCount - SHINGLE_WIDTH + 1;
  if (count <= 0) return EMPTY_UINT32;

  if (count > MAX_SHINGLES_PER_NOTE * 2) {
    // 1.6x safety margin guarantees >= MAX_SHINGLES_PER_NOTE unique hashes pass with >99.9999% probability
    const cutoff = Math.min(0xffffffff, Math.floor(((MAX_SHINGLES_PER_NOTE * 1.6) / count) * 4294967296)) >>> 0;
    let kept = 0;
    let w0 = wordHashes[0];
    let w1 = wordHashes[1];
    let w2 = wordHashes[2];
    for (let i = 0; i < count; i++) {
      const w3 = wordHashes[i + 3];
      const h = hashShingle4(w0, w1, w2, w3);
      if (h <= cutoff) {
        scratchShingles[kept++] = h;
      }
      w0 = w1;
      w1 = w2;
      w2 = w3;
    }
    if (kept >= MAX_SHINGLES_PER_NOTE) {
      scratchShingles.subarray(0, kept).sort();
      const deduped = dedupeSortedUint32(scratchShingles, kept, MAX_SHINGLES_PER_NOTE);
      if (deduped.length === MAX_SHINGLES_PER_NOTE) {
        return deduped;
      }
    }
  }

  let w0 = wordHashes[0];
  let w1 = wordHashes[1];
  let w2 = wordHashes[2];
  for (let i = 0; i < count; i++) {
    const w3 = wordHashes[i + 3];
    scratchShingles[i] = hashShingle4(w0, w1, w2, w3);
    w0 = w1;
    w1 = w2;
    w2 = w3;
  }
  scratchShingles.subarray(0, count).sort();
  return dedupeSortedUint32(scratchShingles, count, MAX_SHINGLES_PER_NOTE);
}

/** Two-pointer Jaccard similarity over two sorted unique `Uint32Array` sets. */
function sortedUint32JaccardStats(
  a: Uint32Array,
  b: Uint32Array
): { inter: number; union: number; jaccard: number } {
  const lenA = a.length;
  const lenB = b.length;
  if (lenA === 0 && lenB === 0) return { inter: 0, union: 0, jaccard: 1 };
  if (lenA === 0 || lenB === 0) return { inter: 0, union: lenA + lenB, jaccard: 0 };
  let i = 0;
  let j = 0;
  let inter = 0;
  while (i < lenA && j < lenB) {
    const va = a[i];
    const vb = b[j];
    if (va === vb) {
      inter++;
      i++;
      j++;
    } else if (va < vb) {
      i++;
    } else {
      j++;
    }
  }
  const union = lenA + lenB - inter;
  return { inter, union, jaccard: union > 0 ? inter / union : 0 };
}

function sortedUint32Jaccard(a: Uint32Array, b: Uint32Array): number {
  if (a.length === 0 || b.length === 0) return 0;
  return sortedUint32JaccardStats(a, b).jaccard;
}

function popcount16(mask: number): number {
  let v = mask & 0xffff;
  let c = 0;
  while (v) {
    v &= v - 1;
    c++;
  }
  return c;
}

/**
 * Ranks notes to pick the suggested keeper:
 * 1. Filed outside inbox-like notebooks ("Pending to sort", "Inbox", ...)
 * 2. More tags
 * 3. Oldest created timestamp (valid > 0)
 * 4. Oldest updated timestamp, then note id for determinism
 */
function compareKeeperRank(a: NoteFingerprint, b: NoteFingerprint): number {
  if (a.isInboxLike !== b.isInboxLike) return a.isInboxLike ? 1 : -1;
  if (a.tagCount !== b.tagCount) return b.tagCount - a.tagCount;
  const ca = a.createdTime > 0 ? a.createdTime : Number.MAX_SAFE_INTEGER;
  const cb = b.createdTime > 0 ? b.createdTime : Number.MAX_SAFE_INTEGER;
  if (ca !== cb) return ca - cb;
  if (a.updatedTime !== b.updatedTime) return a.updatedTime - b.updatedTime;
  return a.noteId.localeCompare(b.noteId);
}

function attachmentsCompatible(a: NoteFingerprint, b: NoteFingerprint): boolean {
  if (a.attachments.length !== b.attachments.length) return false;
  if (a.attachments.length === 0) return true;
  for (let i = 0; i < a.attachments.length; i++) {
    if (a.attachments[i].mimeGroup !== b.attachments[i].mimeGroup) return false;
  }
  if (a.totalAttachmentBytes > 0 && b.totalAttachmentBytes > 0) {
    const minB = Math.min(a.totalAttachmentBytes, b.totalAttachmentBytes);
    const maxB = Math.max(a.totalAttachmentBytes, b.totalAttachmentBytes);
    if (minB / maxB < MIN_ATTACHMENT_SIZE_RATIO) return false;
  }
  return true;
}

function factsAgree(a: NoteFingerprint, b: NoteFingerprint): { ok: boolean; agreedOnFacts: boolean } {
  const maskA = a.monthMask ?? 0;
  const maskB = b.monthMask ?? 0;
  const monthsCountA = popcount16(maskA);
  const monthsCountB = popcount16(maskB);
  if (monthsCountA > 0 && monthsCountB > 0) {
    const inter = popcount16(maskA & maskB);
    const union = monthsCountA + monthsCountB - inter;
    if (union > 0 && inter / union < MIN_MONTH_JACCARD) return { ok: false, agreedOnFacts: false };
  } else if (Math.max(monthsCountA, monthsCountB) >= 2) {
    return { ok: false, agreedOnFacts: false };
  }

  const factsA = a.factHashes ?? EMPTY_UINT32;
  const factsB = b.factHashes ?? EMPTY_UINT32;
  if (factsA.length === 0 && factsB.length === 0) {
    return { ok: true, agreedOnFacts: false };
  }
  if (factsA.length === 0 || factsB.length === 0) {
    return { ok: Math.max(factsA.length, factsB.length) <= 1, agreedOnFacts: false };
  }
  const f = sortedUint32JaccardStats(factsA, factsB);
  if (f.jaccard < MIN_FACT_JACCARD) {
    return { ok: false, agreedOnFacts: false };
  }
  return { ok: true, agreedOnFacts: f.inter > 0 };
}

function buildIdenticalEvidence(fp: NoteFingerprint): string {
  const attCount = fp.attachments.length;
  const attPhrase =
    attCount === 1
      ? `same attachment${fp.totalAttachmentBytes > 0 ? ` (${formatBytesCompact(fp.totalAttachmentBytes)})` : ''}`
      : `same ${attCount} attachments${fp.totalAttachmentBytes > 0 ? ` (${formatBytesCompact(fp.totalAttachmentBytes)})` : ''}`;

  if (attCount > 0) {
    if (fp.hasBodyText && fp.hasOcrText) {
      return `Same text, OCR, and ${attPhrase}`;
    }
    if (fp.hasBodyText) {
      return `Same text and ${attPhrase}`;
    }
    if (fp.hasOcrText) {
      return `${attPhrase[0].toUpperCase()}${attPhrase.slice(1)} and identical OCR text`;
    }
    return `${attPhrase[0].toUpperCase()}${attPhrase.slice(1)}`;
  }
  return `Identical text (${fp.wordCount} ${fp.wordCount === 1 ? 'word' : 'words'})`;
}

function buildNearEvidence(keeper: NoteFingerprint, score: number, agreedOnFacts: boolean): string {
  const pct = Math.min(99, Math.max(1, Math.round(score * 100)));
  const parts: string[] = [`${pct}% same text`];
  if (agreedOnFacts) {
    parts.push('same dates/amounts');
  }
  if (keeper.attachments.length === 1) {
    parts.push(
      `similar attachment${keeper.totalAttachmentBytes > 0 ? ` (${formatBytesCompact(keeper.totalAttachmentBytes)})` : ''}`
    );
  } else if (keeper.attachments.length > 1) {
    parts.push(
      `similar ${keeper.attachments.length} attachments${keeper.totalAttachmentBytes > 0 ? ` (${formatBytesCompact(keeper.totalAttachmentBytes)})` : ''}`
    );
  }
  return parts.join(', ');
}

function extractPlainBody(note: RawJoplinItem, linkedResources: ResourceMetadata[]): string {
  const rawBody = note.body || '';
  if (!rawBody || isBlank(rawBody)) return '';
  let bodyWithoutAttLinks = rawBody;
  if (linkedResources.length > 0 && rawBody.includes(':/')) {
    if (linkedResources.length === 1) {
      const onlyId = linkedResources[0].id.toLowerCase();
      bodyWithoutAttLinks = stripResourceLinks(rawBody, (id) => id === onlyId);
    } else {
      const resourceIds = new Set<string>();
      for (let i = 0; i < linkedResources.length; i++) {
        resourceIds.add(linkedResources[i].id.toLowerCase());
      }
      bodyWithoutAttLinks = stripResourceLinks(rawBody, (id) => resourceIds.has(id));
    }
    if (isBlank(bodyWithoutAttLinks)) return '';
  }
  const markupLang = markupLanguageOf(note.properties);
  return markupLang === MARKUP_HTML
    ? stripHtml(bodyWithoutAttLinks, Number.MAX_SAFE_INTEGER)
    : stripMarkdown(bodyWithoutAttLinks, Number.MAX_SAFE_INTEGER);
}

/**
 * Helper to append normalized text chunks into a bounded prefix accumulator (capped at `MAX_NEAR_CHARS`).
 */
class PrefixAccumulator {
  private parts: string[] = [];
  private len = 0;

  public get full(): boolean {
    return this.len >= MAX_NEAR_CHARS;
  }

  public get length(): number {
    return this.len;
  }

  public append(text: string, separator: string): void {
    if (this.len >= MAX_NEAR_CHARS || !text) return;
    if (this.len > 0 && separator) {
      this.parts.push(separator);
      this.len += separator.length;
      if (this.len >= MAX_NEAR_CHARS) return;
    }
    const remain = MAX_NEAR_CHARS - this.len;
    if (text.length <= remain) {
      this.parts.push(text);
      this.len += text.length;
    } else {
      this.parts.push(text.slice(0, remain));
      this.len += remain;
    }
  }

  public build(): string {
    if (this.parts.length === 0) return '';
    return this.parts.length === 1 ? this.parts[0] : this.parts.join('');
  }
}

/**
 * Extracts only the bounded normalized prefix (up to `MAX_NEAR_CHARS`) of a note without touching
 * the rest of multi-megabyte OCR texts. Used lazily when verifying near-duplicate candidate pairs.
 */
function extractBoundedNearPrefix(input: DuplicateNoteInput, ocrOrder?: number[]): string {
  const acc = new PrefixAccumulator();
  const plainBody = extractPlainBody(input.note, input.linkedResources);
  if (plainBody) {
    let firstBodyChunk = true;
    streamNormalizedChunks(
      plainBody,
      (chunk) => {
        acc.append(chunk, firstBodyChunk ? '' : ' ');
        firstBodyChunk = false;
        if (acc.full) return false;
      },
      true
    );
  }

  if (!acc.full && input.linkedResources.length > 0) {
    const indices = ocrOrder ?? input.linkedResources.map((_, idx) => idx);
    for (let k = 0; k < indices.length && !acc.full; k++) {
      const res = input.linkedResources[indices[k]];
      if (!res?.ocrText || isBlank(res.ocrText)) continue;
      let firstOcrChunk = true;
      streamNormalizedChunks(res.ocrText, (chunk) => {
        acc.append(chunk, firstOcrChunk ? '\n' : ' ');
        firstOcrChunk = false;
        if (acc.full) return false;
      });
    }
  }

  return acc.build();
}

function streamPartLength(
  raw: string,
  hasher: Hash | null,
  prefixAcc: PrefixAccumulator | null,
  firstSeparator: string,
  alreadyCollapsed = false
): number {
  let length = 0;
  let firstChunk = true;

  streamNormalizedChunks(
    raw,
    (chunk) => {
      if (firstChunk) {
        if (hasher && firstSeparator) hasher.update(firstSeparator);
        if (prefixAcc) prefixAcc.append(chunk, firstSeparator);
        firstChunk = false;
      } else {
        if (hasher) hasher.update(' ');
        if (prefixAcc) prefixAcc.append(chunk, ' ');
        length += 1;
      }
      if (hasher) hasher.update(chunk);
      length += chunk.length;
    },
    alreadyCollapsed
  );

  return length;
}

function countExactNoteWords(input: DuplicateNoteInput): number {
  let total = 0;
  const plainBody = extractPlainBody(input.note, input.linkedResources);
  if (plainBody) {
    streamNormalizedChunks(plainBody, (chunk) => {
      total += countWordsInNormalized(chunk);
    });
  }
  for (const res of input.linkedResources) {
    if (!res.ocrText || isBlank(res.ocrText)) continue;
    streamNormalizedChunks(res.ocrText, (chunk) => {
      total += countWordsInNormalized(chunk);
    });
  }
  return total;
}

function buildFingerprint(
  input: DuplicateNoteInput,
  inputIndex: number,
  scratchWordHashes: Uint32Array,
  scratchShingles: Uint32Array
): NoteFingerprint {
  const { note, notebookTitle, notebookPath, tagCount, linkedResources } = input;

  let attachments: AttachmentSpec[] = EMPTY_ATTACHMENTS;
  let totalAttachmentBytes = 0;
  let hasSubstantialAttachment = false;
  const ocrResourceIndices: number[] = [];

  if (linkedResources.length > 0) {
    attachments = new Array<AttachmentSpec>(linkedResources.length);
    for (let i = 0; i < linkedResources.length; i++) {
      const res = linkedResources[i];
      const size = Number.isFinite(res.size) && res.size > 0 ? Math.round(res.size) : 0;
      const mime = (res.mime || 'application/octet-stream').toLowerCase().trim();
      attachments[i] = { mime, mimeGroup: mimeGroupOf(mime), size };
      totalAttachmentBytes += size;
      if (size > 0) hasSubstantialAttachment = true;
      if (res.ocrText && !isBlank(res.ocrText)) {
        ocrResourceIndices.push(i);
      }
    }
    if (attachments.length > 1) {
      attachments.sort((a, b) => a.mime.localeCompare(b.mime) || a.size - b.size);
    }
  }

  const attachmentSig =
    attachments.length === 0
      ? ''
      : attachments.length === 1
        ? `${attachments[0].mime}:${attachments[0].size}`
        : attachments.map((a) => `${a.mime}:${a.size}`).join('|');

  const plainBody = extractPlainBody(note, linkedResources);
  let hasBodyText = false;
  let hasOcrText = false;
  let combinedLength = 0;
  let combinedHash = '';
  let ocrOrder: number[] | undefined;

  const prefixAcc = new PrefixAccumulator();

  if (ocrResourceIndices.length <= 1) {
    // Common case (0 or 1 OCR resource): single streaming pass computes exact full-text SHA-256
    const hasher = plainBody || ocrResourceIndices.length === 1 ? createHash('sha256') : null;
    if (plainBody && hasher) {
      const len = streamPartLength(plainBody, hasher, prefixAcc, '', true);
      if (len > 0) {
        hasBodyText = true;
        combinedLength += len;
      }
    }
    if (ocrResourceIndices.length === 1 && hasher) {
      const rawOcr = linkedResources[ocrResourceIndices[0]].ocrText;
      const sep = hasBodyText ? '\n' : '';
      const len = streamPartLength(rawOcr, hasher, prefixAcc, sep);
      if (len > 0) {
        hasOcrText = true;
        if (hasBodyText) combinedLength += 1;
        combinedLength += len;
      }
    }
    if (hasher && combinedLength > 0) {
      combinedHash = hasher.digest('hex');
    }
  } else {
    // Rare case (>= 2 OCR resources): hash each resource in a streaming pass, sort canonically
    // by (normalized prefix, full sha256) so order is deterministic without holding full texts.
    let bodyHash = '';
    if (plainBody) {
      const bodyHasher = createHash('sha256');
      const len = streamPartLength(plainBody, bodyHasher, prefixAcc, '', true);
      if (len > 0) {
        hasBodyText = true;
        combinedLength += len;
        bodyHash = bodyHasher.digest('hex');
      }
    }

    const ocrEntries: Array<{
      resIndex: number;
      hash: string;
      length: number;
      prefix: string;
    }> = [];
    for (const resIndex of ocrResourceIndices) {
      const rawOcr = linkedResources[resIndex].ocrText;
      const partHasher = createHash('sha256');
      const partPrefix = new PrefixAccumulator();
      const len = streamPartLength(rawOcr, partHasher, partPrefix, '');
      if (len > 0) {
        ocrEntries.push({
          resIndex,
          hash: partHasher.digest('hex'),
          length: len,
          prefix: partPrefix.build(),
        });
      }
    }

    if (ocrEntries.length > 0) {
      hasOcrText = true;
      ocrEntries.sort((a, b) => (a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : a.hash.localeCompare(b.hash)));
      ocrOrder = ocrEntries.map((e) => e.resIndex);
      for (const entry of ocrEntries) {
        if (combinedLength > 0) combinedLength += 1;
        combinedLength += entry.length;
        prefixAcc.append(entry.prefix, '\n');
      }
    }

    if (combinedLength > 0) {
      const finalHasher = createHash('sha256');
      finalHasher.update('M:');
      if (bodyHash) finalHasher.update(bodyHash);
      for (const entry of ocrEntries) {
        finalHasher.update('\0');
        finalHasher.update(entry.hash);
      }
      combinedHash = finalHasher.digest('hex');
    }
  }

  // Scan the bounded prefix once for both word count and KMV shingles (avoids scanning full 2M-char tails in JS)
  let wordCount = 0;
  let shingles: Uint32Array | undefined;
  if (combinedLength > 0) {
    const nearPrefix = prefixAcc.build();
    const tokenCount = scanPrefixWordHashes(nearPrefix, scratchWordHashes, MAX_NEAR_WORDS);
    const scannedChars = Math.max(1, lastScanEndChar);
    if (combinedLength <= nearPrefix.length && scannedChars >= nearPrefix.length) {
      wordCount = tokenCount;
    } else if (tokenCount >= MIN_NEAR_WORDS) {
      wordCount = Math.max(tokenCount, Math.round(tokenCount * (combinedLength / scannedChars)));
    } else {
      wordCount = tokenCount;
    }

    if (tokenCount >= MIN_NEAR_WORDS) {
      const built = buildShingleSetFromWordHashes(scratchWordHashes, tokenCount, scratchShingles);
      if (built.length >= MIN_SHINGLES) {
        shingles = built;
      }
    }
  }

  return {
    inputIndex,
    noteId: note.id,
    title: note.title || '',
    createdTime: note.createdTime,
    updatedTime: note.updatedTime,
    tagCount,
    isInboxLike: isInboxLikeNotebook(notebookTitle, notebookPath),
    hasBodyText,
    hasOcrText,
    combinedLength,
    combinedHash,
    wordCount,
    attachments,
    attachmentSig,
    totalAttachmentBytes,
    hasSubstantialAttachment,
    ...(ocrOrder ? { ocrOrder } : {}),
    ...(shingles ? { shingles } : {}),
  };
}

interface NearEdge {
  a: number;
  b: number;
  score: number;
  agreedOnFacts: boolean;
}

/**
 * Detects content-based duplicate clusters (`identical` and `near`) across all provided active,
 * unencrypted notes. Never uses note title as match evidence, avoids transitive chaining, and
 * filters out dismissed note pairs.
 */
export function detectDuplicateClusters(
  inputs: DuplicateNoteInput[],
  dismissedPairs: ReadonlySet<string> = new Set()
): DetectedDuplicateCluster[] {
  const isDismissed = (idA: string, idB: string): boolean =>
    dismissedPairs.size > 0 && dismissedPairs.has(canonicalPairKey(idA, idB));

  // Reusable per-call scratch buffers (32 KB total) so we never allocate per-word string arrays
  const scratchWordHashes = new Uint32Array(MAX_NEAR_WORDS);
  const scratchShingles = new Uint32Array(MAX_NEAR_WORDS);

  const fingerprints: NoteFingerprint[] = new Array(inputs.length);
  for (let i = 0; i < inputs.length; i++) {
    fingerprints[i] = buildFingerprint(inputs[i], i, scratchWordHashes, scratchShingles);
  }

  const clusters: DetectedDuplicateCluster[] = [];
  const claimedIds = new Set<string>();

  // -------------------------------------------------------------------------
  // Tier 1: Identical duplicates (exact full-text hash + exact attachment signature)
  // -------------------------------------------------------------------------
  const identicalBuckets = new Map<string, NoteFingerprint[]>();
  for (const fp of fingerprints) {
    let key: string | null = null;
    if (fp.attachments.length > 0) {
      if (fp.combinedLength > 0 || fp.hasSubstantialAttachment) {
        key = `A:${fp.attachmentSig}#${fp.combinedHash}`;
      }
    } else if (fp.combinedLength >= MIN_IDENTICAL_TEXT_CHARS && fp.wordCount >= MIN_IDENTICAL_WORDS) {
      key = `T:${fp.combinedHash}`;
    }
    if (!key) continue;
    const bucket = identicalBuckets.get(key);
    if (bucket) bucket.push(fp);
    else identicalBuckets.set(key, [fp]);
  }

  for (const bucket of identicalBuckets.values()) {
    if (bucket.length < 2) continue;
    bucket.sort(compareKeeperRank);

    // Greedily form non-dismissed cliques starting from the best keeper
    const remaining = [...bucket];
    while (remaining.length >= 2) {
      const keeper = remaining.shift()!;
      const members: NoteFingerprint[] = [keeper];
      const nextRemaining: NoteFingerprint[] = [];
      for (const candidate of remaining) {
        if (members.every((m) => !isDismissed(m.noteId, candidate.noteId))) {
          members.push(candidate);
        } else {
          nextRemaining.push(candidate);
        }
      }
      if (members.length >= 2) {
        for (const m of members) {
          claimedIds.add(m.noteId);
          m.shingles = undefined;
        }
        if (keeper.attachments.length === 0 && keeper.combinedLength > MAX_NEAR_CHARS) {
          keeper.wordCount = countExactNoteWords(inputs[keeper.inputIndex]);
        }
        clusters.push({
          id: `identical-${keeper.noteId}`,
          tier: 'identical',
          score: 1,
          evidence: buildIdenticalEvidence(keeper),
          suggestedKeeperId: keeper.noteId,
          noteIds: members.map((m) => m.noteId),
        });
      }
      remaining.length = 0;
      remaining.push(...nextRemaining);
    }
  }
  identicalBuckets.clear();

  // -------------------------------------------------------------------------
  // Tier 2: Near duplicates (4-word shingle Bottom-K inverted index + fact & attachment checks)
  // -------------------------------------------------------------------------
  const nearCandidates: NoteFingerprint[] = [];
  for (const fp of fingerprints) {
    fp.combinedHash = '';
    if (claimedIds.has(fp.noteId)) continue;
    if (!fp.shingles || fp.shingles.length < MIN_SHINGLES) continue;
    nearCandidates.push(fp);
  }

  if (nearCandidates.length >= 2) {
    // Pass 1 & 2: build inverted postings for distinctive Bottom-K shingles (2 <= df <= MAX_SHINGLE_DF)
    // Pack (shingleHash, candidateIndex) into a flat Float64Array and sort in-place to avoid a giant df Map.
    let totalEntries = 0;
    for (let i = 0; i < nearCandidates.length; i++) {
      totalEntries += Math.min(BOTTOM_K_INDEX, nearCandidates[i].shingles!.length);
    }

    const postings = new Map<number, Uint32Array>();
    const DOC_SHIFT = 1_048_576; // 2^20; 2^32 * 2^20 = 2^52 < Number.MAX_SAFE_INTEGER (2^53 - 1)
    if (nearCandidates.length < DOC_SHIFT) {
      const packed = new Float64Array(totalEntries);
      let cursor = 0;
      for (let i = 0; i < nearCandidates.length; i++) {
        const shingles = nearCandidates[i].shingles!;
        const k = Math.min(BOTTOM_K_INDEX, shingles.length);
        for (let idx = 0; idx < k; idx++) {
          packed[cursor++] = shingles[idx] * DOC_SHIFT + i;
        }
      }
      packed.sort();

      let runStart = 0;
      while (runStart < packed.length) {
        const hash = Math.floor(packed[runStart] / DOC_SHIFT);
        let runEnd = runStart + 1;
        while (runEnd < packed.length && Math.floor(packed[runEnd] / DOC_SHIFT) === hash) {
          runEnd++;
        }
        const df = runEnd - runStart;
        if (df >= 2 && df <= MAX_SHINGLE_DF) {
          const list = new Uint32Array(df);
          for (let p = 0; p < df; p++) {
            list[p] = packed[runStart + p] - hash * DOC_SHIFT;
          }
          postings.set(hash, list);
        }
        runStart = runEnd;
      }
    } else {
      const dfCounts = new Map<number, number>();
      for (const fp of nearCandidates) {
        const shingles = fp.shingles!;
        const k = Math.min(BOTTOM_K_INDEX, shingles.length);
        for (let idx = 0; idx < k; idx++) {
          const h = shingles[idx];
          dfCounts.set(h, (dfCounts.get(h) ?? 0) + 1);
        }
      }
      const tempPostings = new Map<number, number[]>();
      for (let i = 0; i < nearCandidates.length; i++) {
        const shingles = nearCandidates[i].shingles!;
        const k = Math.min(BOTTOM_K_INDEX, shingles.length);
        for (let idx = 0; idx < k; idx++) {
          const h = shingles[idx];
          const df = dfCounts.get(h) ?? 0;
          if (df < 2 || df > MAX_SHINGLE_DF) continue;
          const list = tempPostings.get(h);
          if (list) list.push(i);
          else tempPostings.set(h, [i]);
        }
      }
      for (const [h, list] of tempPostings) {
        postings.set(h, Uint32Array.from(list));
      }
    }

    // Lazily populate compact word-hash set + factual signature ONLY for notes whose pair passes shingle Jaccard
    const ensureNearVerification = (fp: NoteFingerprint) => {
      if (fp.wordHashes !== undefined) return;
      const prefix = extractBoundedNearPrefix(inputs[fp.inputIndex], fp.ocrOrder);
      const tokenCount = scanPrefixWordHashes(prefix, scratchWordHashes, MAX_NEAR_WORDS);
      if (tokenCount > 0) {
        scratchWordHashes.subarray(0, tokenCount).sort();
        fp.wordHashes = dedupeSortedUint32(scratchWordHashes, tokenCount);
      } else {
        fp.wordHashes = EMPTY_UINT32;
      }
      const factual = extractFactualSignature(prefix);
      fp.factHashes = factual.factHashes;
      fp.monthMask = factual.monthMask;
    };

    // Pass 3: collect candidate pairs and verify exact shingle + word + fact + attachment criteria
    const edges: NearEdge[] = [];
    const overlapCounts = new Map<number, number>();

    for (let i = 0; i < nearCandidates.length; i++) {
      const fpA = nearCandidates[i];
      const shinglesA = fpA.shingles!;
      const kA = Math.min(BOTTOM_K_INDEX, shinglesA.length);
      overlapCounts.clear();

      for (let idx = 0; idx < kA; idx++) {
        const list = postings.get(shinglesA[idx]);
        if (!list) continue;
        // Postings are sorted ascending by candidate index; scan from the end to visit only j > i
        for (let p = list.length - 1; p >= 0; p--) {
          const j = list[p];
          if (j <= i) break;
          overlapCounts.set(j, (overlapCounts.get(j) ?? 0) + 1);
        }
      }

      for (const [j, sharedSketch] of overlapCounts) {
        const fpB = nearCandidates[j];
        const minK = Math.min(kA, Math.min(BOTTOM_K_INDEX, fpB.shingles!.length));
        const minRequiredSketch = Math.max(2, Math.min(4, Math.floor(minK * 0.15)));
        if (sharedSketch < minRequiredSketch) continue;
        if (isDismissed(fpA.noteId, fpB.noteId)) continue;

        const minWords = Math.min(fpA.wordCount, fpB.wordCount);
        const maxWords = Math.max(fpA.wordCount, fpB.wordCount);
        if (minWords / maxWords < MIN_LENGTH_RATIO) continue;

        if (!attachmentsCompatible(fpA, fpB)) continue;

        const shingleJaccard = sortedUint32Jaccard(shinglesA, fpB.shingles!);
        if (shingleJaccard < MIN_SHINGLE_JACCARD) continue;

        ensureNearVerification(fpA);
        ensureNearVerification(fpB);

        const wJaccard = sortedUint32Jaccard(fpA.wordHashes!, fpB.wordHashes!);
        if (wJaccard < MIN_WORD_JACCARD) continue;

        const factCheck = factsAgree(fpA, fpB);
        if (!factCheck.ok) continue;

        const displayScore = Math.min(0.99, Math.round(Math.max(wJaccard, shingleJaccard) * 100) / 100);
        edges.push({ a: i, b: j, score: displayScore, agreedOnFacts: factCheck.agreedOnFacts });
      }
    }

    // Pass 4: non-transitive clique clustering (no A~B~C chaining when A!~C)
    if (edges.length > 0) {
      const adj = new Map<number, Map<number, NearEdge>>();
      const addAdj = (u: number, v: number, edge: NearEdge) => {
        let m = adj.get(u);
        if (!m) {
          m = new Map();
          adj.set(u, m);
        }
        m.set(v, edge);
      };
      for (const edge of edges) {
        addAdj(edge.a, edge.b, edge);
        addAdj(edge.b, edge.a, edge);
      }

      edges.sort((x, y) => {
        if (y.score !== x.score) return y.score - x.score;
        return nearCandidates[x.a].noteId.localeCompare(nearCandidates[y.a].noteId) ||
          nearCandidates[x.b].noteId.localeCompare(nearCandidates[y.b].noteId);
      });

      const assigned = new Set<number>();
      for (const seed of edges) {
        if (assigned.has(seed.a) || assigned.has(seed.b)) continue;
        const memberIndices: number[] = [seed.a, seed.b];
        assigned.add(seed.a);
        assigned.add(seed.b);

        // Candidate neighbors of seed.a sorted by edge score descending
        const neighborsA = Array.from(adj.get(seed.a)?.entries() ?? [])
          .filter(([idx]) => !assigned.has(idx))
          .sort((x, y) => y[1].score - x[1].score);

        for (const [candIdx] of neighborsA) {
          // Require direct match to every existing member (prevents transitive chaining)
          const candNeighbors = adj.get(candIdx);
          if (!candNeighbors) continue;
          if (memberIndices.every((mIdx) => candNeighbors.has(mIdx))) {
            memberIndices.push(candIdx);
            assigned.add(candIdx);
          }
        }

        const memberFps = memberIndices.map((idx) => ({ idx, fp: nearCandidates[idx] }));
        memberFps.sort((x, y) => compareKeeperRank(x.fp, y.fp));
        const keeper = memberFps[0];
        const keeperEdges = adj.get(keeper.idx)!;
        const otherMembers = memberFps.slice(1).sort((x, y) => {
          const scoreX = keeperEdges.get(x.idx)?.score ?? 0;
          const scoreY = keeperEdges.get(y.idx)?.score ?? 0;
          return scoreY - scoreX || x.fp.title.localeCompare(y.fp.title) || x.fp.noteId.localeCompare(y.fp.noteId);
        });

        let scoreSum = 0;
        let allAgreedFacts = true;
        let anyAgreedFacts = false;
        for (const other of otherMembers) {
          const e = keeperEdges.get(other.idx)!;
          scoreSum += e.score;
          if (e.agreedOnFacts) anyAgreedFacts = true;
          else allAgreedFacts = false;
        }
        const clusterScore = Math.min(0.99, Math.round((scoreSum / otherMembers.length) * 100) / 100);
        const ordered = [keeper, ...otherMembers];

        clusters.push({
          id: `near-${keeper.fp.noteId}`,
          tier: 'near',
          score: clusterScore,
          evidence: buildNearEvidence(keeper.fp, clusterScore, anyAgreedFacts && allAgreedFacts),
          suggestedKeeperId: keeper.fp.noteId,
          noteIds: ordered.map((m) => m.fp.noteId),
        });
      }
    }
  }

  // Sort: identical first, then larger clusters, then higher score, then deterministic id
  clusters.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier === 'identical' ? -1 : 1;
    if (b.noteIds.length !== a.noteIds.length) return b.noteIds.length - a.noteIds.length;
    if (b.score !== a.score) return b.score - a.score;
    return a.id.localeCompare(b.id);
  });

  return clusters;
}
