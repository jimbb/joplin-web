import { createHash } from 'node:crypto';
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
/** Maximum unique shingles stored per note (KMV smallest-hash sketch when exceeded) */
const MAX_SHINGLES_PER_NOTE = 1500;
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

const CJK_CHAR_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const WORD_SEGMENT_RE = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;
const NUMBER_RE = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;
const MAY_DATE_RE = /\b(?:may\s+\d{1,4}|\d{1,2}(?:st|nd|rd|th)?\s+may)\b/g;
const QUARTER_RE = /\bq[1-4]\b/g;

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
  noteId: string;
  title: string;
  createdTime: number;
  updatedTime: number;
  tagCount: number;
  isInboxLike: boolean;
  bodyTextNorm: string;
  ocrTextNorm: string;
  combinedNorm: string;
  combinedHash: string;
  wordCount: number;
  attachments: AttachmentSpec[];
  attachmentSig: string;
  totalAttachmentBytes: number;
  hasSubstantialAttachment: boolean;
  /** Lazily populated for near-duplicate candidates */
  words?: string[];
  shingles?: Uint32Array;
  facts?: Set<string>;
  months?: Set<string>;
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

/**
 * Removes Joplin attachment links (`![...](:/id)`, `[...](:/id)`, `<img src=":/id">`, `<a href=":/id">`)
 * targeting known resources so attachment filenames do not distort text comparison.
 */
function stripResourceLinks(body: string, resourceIds: Set<string>): string {
  if (!body || !body.includes(':/') || resourceIds.size === 0) return body;
  let cleaned = body.replace(
    /!\[[^\]]*\]\(\s*:\/([0-9a-fA-F]{32})(?:\s+"[^"]*")?\s*\)/g,
    (match, id: string) => (resourceIds.has(id.toLowerCase()) ? ' ' : match)
  );
  cleaned = cleaned.replace(
    /\[[^\]]*\]\(\s*:\/([0-9a-fA-F]{32})(?:#[^\s()"'<>]*)?(?:\s+"[^"]*")?\s*\)/g,
    (match, id: string) => (resourceIds.has(id.toLowerCase()) ? ' ' : match)
  );
  cleaned = cleaned.replace(
    /<img\b[^>]*\bsrc=["']:\/([0-9a-fA-F]{32})["'][^>]*>/gi,
    (match, id: string) => (resourceIds.has(id.toLowerCase()) ? ' ' : match)
  );
  cleaned = cleaned.replace(
    /<a\b[^>]*\bhref=["']:\/([0-9a-fA-F]{32})(?:#[^"']*)?["'][^>]*>[\s\S]*?<\/a>/gi,
    (match, id: string) => (resourceIds.has(id.toLowerCase()) ? ' ' : match)
  );
  return cleaned;
}

/** Normalizes text for content comparison: NFKC, lowercase, collapsed single spaces. */
export function normalizeContentText(raw: string): string {
  if (!raw) return '';
  return raw.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Tokenizes normalized text into words (splitting CJK runs into characters so n-grams work without spaces). */
export function tokenizeWords(normalized: string): string[] {
  if (!normalized) return [];
  const words: string[] = [];
  const matches = normalized.match(WORD_SEGMENT_RE);
  if (!matches) return words;
  for (const seg of matches) {
    if (CJK_CHAR_RE.test(seg)) {
      // Split mixed or pure CJK runs so each CJK character becomes its own token
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

  const wordMatches = normalized.match(/[a-z]{3,9}/g);
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

/** 32-bit FNV-1a hash with avalanche finalizer for deterministic, well-distributed shingle hashes. */
function hashShingle(words: string[], start: number, width: number): number {
  let h = 2166136261;
  for (let k = 0; k < width; k++) {
    if (k > 0) {
      h ^= 0x1f;
      h = Math.imul(h, 16777619);
    }
    const w = words[start + k];
    for (let i = 0; i < w.length; i++) {
      h ^= w.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  }
  // Murmur3-style avalanche mix so Bottom-K selection is uniform across the hash space
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Builds a sorted, deduplicated `Uint32Array` of 4-word shingle hashes.
 * When a note has more than `MAX_SHINGLES_PER_NOTE` unique shingles, retains the smallest
 * `MAX_SHINGLES_PER_NOTE` hashes (a K-Minimum Values sketch across the full document).
 */
function buildShingleSet(words: string[]): Uint32Array {
  const count = words.length - SHINGLE_WIDTH + 1;
  if (count <= 0) return new Uint32Array(0);
  const raw = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    raw[i] = hashShingle(words, i, SHINGLE_WIDTH);
  }
  raw.sort();
  // Deduplicate in-place
  let uniqueLen = 0;
  for (let i = 0; i < raw.length; i++) {
    if (i === 0 || raw[i] !== raw[i - 1]) {
      raw[uniqueLen++] = raw[i];
    }
  }
  const finalLen = Math.min(uniqueLen, MAX_SHINGLES_PER_NOTE);
  return raw.slice(0, finalLen);
}

/** Two-pointer Jaccard similarity over two sorted unique `Uint32Array` sets. */
function sortedUint32Jaccard(a: Uint32Array, b: Uint32Array): number {
  const lenA = a.length;
  const lenB = b.length;
  if (lenA === 0 || lenB === 0) return 0;
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
  return union > 0 ? inter / union : 0;
}

function setJaccard(a: Set<string>, b: Set<string>): { inter: number; union: number; jaccard: number } {
  if (a.size === 0 && b.size === 0) return { inter: 0, union: 0, jaccard: 1 };
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const v of small) {
    if (big.has(v)) inter++;
  }
  const union = a.size + b.size - inter;
  return { inter, union, jaccard: union > 0 ? inter / union : 0 };
}

function wordBagJaccard(wordsA: string[], wordsB: string[]): number {
  const setA = new Set(wordsA);
  const setB = new Set(wordsB);
  return setJaccard(setA, setB).jaccard;
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
  const monthsA = a.months!;
  const monthsB = b.months!;
  if (monthsA.size > 0 && monthsB.size > 0) {
    const m = setJaccard(monthsA, monthsB);
    if (m.jaccard < MIN_MONTH_JACCARD) return { ok: false, agreedOnFacts: false };
  } else if (Math.max(monthsA.size, monthsB.size) >= 2) {
    return { ok: false, agreedOnFacts: false };
  }

  const factsA = a.facts!;
  const factsB = b.facts!;
  if (factsA.size === 0 && factsB.size === 0) {
    return { ok: true, agreedOnFacts: false };
  }
  if (factsA.size === 0 || factsB.size === 0) {
    return { ok: Math.max(factsA.size, factsB.size) <= 1, agreedOnFacts: false };
  }
  const f = setJaccard(factsA, factsB);
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
    if (fp.bodyTextNorm && fp.ocrTextNorm) {
      return `Same text, OCR, and ${attPhrase}`;
    }
    if (fp.bodyTextNorm) {
      return `Same text and ${attPhrase}`;
    }
    if (fp.ocrTextNorm) {
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

function buildFingerprint(input: DuplicateNoteInput): NoteFingerprint {
  const { note, notebookTitle, notebookPath, tagCount, linkedResources } = input;
  const resourceIds = new Set(linkedResources.map((r) => r.id.toLowerCase()));
  const bodyWithoutAttLinks = stripResourceLinks(note.body || '', resourceIds);
  const markupLang = markupLanguageOf(note.properties);
  const plainBody =
    markupLang === MARKUP_HTML
      ? stripHtml(bodyWithoutAttLinks, Number.MAX_SAFE_INTEGER)
      : stripMarkdown(bodyWithoutAttLinks, Number.MAX_SAFE_INTEGER);
  const bodyTextNorm = normalizeContentText(plainBody);

  const ocrParts: string[] = [];
  const attachments: AttachmentSpec[] = [];
  let totalAttachmentBytes = 0;
  let hasSubstantialAttachment = false;

  for (const res of linkedResources) {
    const size = Number.isFinite(res.size) && res.size > 0 ? Math.round(res.size) : 0;
    const mime = (res.mime || 'application/octet-stream').toLowerCase().trim();
    attachments.push({ mime, mimeGroup: mimeGroupOf(mime), size });
    totalAttachmentBytes += size;
    if (size > 0) hasSubstantialAttachment = true;
    if (res.ocrText && res.ocrText.trim()) {
      const normOcr = normalizeContentText(res.ocrText);
      if (normOcr) ocrParts.push(normOcr);
    }
  }

  attachments.sort((a, b) => a.mime.localeCompare(b.mime) || a.size - b.size);
  ocrParts.sort();
  const ocrTextNorm = ocrParts.join('\n');
  const combinedNorm = bodyTextNorm && ocrTextNorm ? `${bodyTextNorm}\n${ocrTextNorm}` : bodyTextNorm || ocrTextNorm;
  const combinedHash = combinedNorm
    ? createHash('sha256').update(combinedNorm).digest('hex')
    : '';
  const attachmentSig = attachments.map((a) => `${a.mime}:${a.size}`).join('|');

  // Lightweight word count estimate for identical evidence (full tokenization deferred to near candidates or small text check)
  let wordCount = 0;
  if (combinedNorm) {
    const words = tokenizeWords(combinedNorm);
    wordCount = words.length;
    const fp: NoteFingerprint = {
      noteId: note.id,
      title: note.title || '',
      createdTime: note.createdTime,
      updatedTime: note.updatedTime,
      tagCount,
      isInboxLike: isInboxLikeNotebook(notebookTitle, notebookPath),
      bodyTextNorm,
      ocrTextNorm,
      combinedNorm,
      combinedHash,
      wordCount,
      attachments,
      attachmentSig,
      totalAttachmentBytes,
      hasSubstantialAttachment,
      words,
    };
    return fp;
  }

  return {
    noteId: note.id,
    title: note.title || '',
    createdTime: note.createdTime,
    updatedTime: note.updatedTime,
    tagCount,
    isInboxLike: isInboxLikeNotebook(notebookTitle, notebookPath),
    bodyTextNorm,
    ocrTextNorm,
    combinedNorm,
    combinedHash,
    wordCount: 0,
    attachments,
    attachmentSig,
    totalAttachmentBytes,
    hasSubstantialAttachment,
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

  const fingerprints: NoteFingerprint[] = inputs.map(buildFingerprint);
  const clusters: DetectedDuplicateCluster[] = [];
  const claimedIds = new Set<string>();

  // -------------------------------------------------------------------------
  // Tier 1: Identical duplicates (exact text hash + exact attachment signature)
  // -------------------------------------------------------------------------
  const identicalBuckets = new Map<string, NoteFingerprint[]>();
  for (const fp of fingerprints) {
    let key: string | null = null;
    if (fp.attachments.length > 0) {
      if (fp.combinedNorm.length > 0 || fp.hasSubstantialAttachment) {
        key = `A:${fp.attachmentSig}#${fp.combinedHash}`;
      }
    } else if (fp.combinedNorm.length >= MIN_IDENTICAL_TEXT_CHARS && fp.wordCount >= MIN_IDENTICAL_WORDS) {
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
        for (const m of members) claimedIds.add(m.noteId);
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

  // -------------------------------------------------------------------------
  // Tier 2: Near duplicates (4-word shingle Bottom-K inverted index + fact & attachment checks)
  // -------------------------------------------------------------------------
  const nearCandidates: NoteFingerprint[] = [];
  for (const fp of fingerprints) {
    if (claimedIds.has(fp.noteId)) continue;
    if (!fp.words || fp.words.length < MIN_NEAR_WORDS) continue;
    const shingles = buildShingleSet(fp.words);
    if (shingles.length < MIN_SHINGLES) continue;
    fp.shingles = shingles;
    nearCandidates.push(fp);
  }

  if (nearCandidates.length >= 2) {
    // Pass 1: count document frequencies for Bottom-K shingles
    const dfCounts = new Map<number, number>();
    for (const fp of nearCandidates) {
      const shingles = fp.shingles!;
      const k = Math.min(BOTTOM_K_INDEX, shingles.length);
      for (let idx = 0; idx < k; idx++) {
        const h = shingles[idx];
        dfCounts.set(h, (dfCounts.get(h) ?? 0) + 1);
      }
    }

    // Pass 2: build inverted postings only for distinctive shingles (2 <= df <= MAX_SHINGLE_DF)
    const postings = new Map<number, number[]>();
    for (let i = 0; i < nearCandidates.length; i++) {
      const shingles = nearCandidates[i].shingles!;
      const k = Math.min(BOTTOM_K_INDEX, shingles.length);
      for (let idx = 0; idx < k; idx++) {
        const h = shingles[idx];
        const df = dfCounts.get(h) ?? 0;
        if (df < 2 || df > MAX_SHINGLE_DF) continue;
        const list = postings.get(h);
        if (list) list.push(i);
        else postings.set(h, [i]);
      }
    }

    const ensureFacts = (fp: NoteFingerprint) => {
      if (!fp.facts) {
        const extracted = extractFactualTokens(fp.combinedNorm);
        fp.facts = extracted.facts;
        fp.months = extracted.months;
      }
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
        for (let p = 0; p < list.length; p++) {
          const j = list[p];
          if (j <= i) continue;
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

        const wJaccard = wordBagJaccard(fpA.words!, fpB.words!);
        if (wJaccard < MIN_WORD_JACCARD) continue;

        ensureFacts(fpA);
        ensureFacts(fpB);
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
