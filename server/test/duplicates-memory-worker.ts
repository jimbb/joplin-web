import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import v8 from 'node:v8';
import { detectDuplicateClusters, type DuplicateNoteInput } from '../src/services/duplicates.js';
import { JoplinItemType, type RawJoplinItem, type ResourceMetadata } from '../src/types/index.js';

/** Deterministic PRNG (Mulberry32) so the fixture is 100% reproducible. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const makeId = (key: string): string => createHash('md5').update(`mem-fixture:${key}`).digest('hex');

// 2,048 distinct realistic-length English-like words (~6-9 chars each)
const ROOTS = [
  'account', 'archive', 'audit', 'balance', 'benefit', 'billing', 'booking', 'budget',
  'capital', 'carrier', 'catalog', 'chapter', 'charter', 'circuit', 'climate', 'cluster',
  'command', 'comment', 'company', 'compass', 'compile', 'concept', 'confirm', 'connect',
  'console', 'consult', 'contact', 'content', 'context', 'contour', 'control', 'convert',
  'counsel', 'counter', 'country', 'courier', 'culture', 'current', 'cushion', 'customs',
  'default', 'deficit', 'deliver', 'density', 'deposit', 'desktop', 'develop', 'diagram',
  'digital', 'diploma', 'display', 'dispute', 'distant', 'diverse', 'divided', 'docking',
  'dolphin', 'drawing', 'dynamic', 'edition', 'element', 'embassy', 'emerald', 'emperor',
  'enclose', 'endorse', 'enforce', 'enquiry', 'episode', 'essence', 'evening', 'evident',
  'examine', 'example', 'excerpt', 'execute', 'exhibit', 'expense', 'explain', 'explore',
  'express', 'extract', 'factory', 'faculty', 'failure', 'fashion', 'feature', 'federal',
  'fiction', 'fifteen', 'finance', 'finding', 'fishing', 'fitness', 'fixture', 'flagged',
  'flannel', 'florist', 'focused', 'footage', 'foreign', 'forever', 'formula', 'fortune',
  'forward', 'founder', 'foundry', 'fragile', 'framing', 'freedom', 'freight', 'fulfill',
  'gallery', 'garment', 'gateway', 'general', 'generic', 'genesis', 'genuine', 'geology',
  'gesture', 'glacier', 'glasses', 'glimpse', 'gourmet', 'grammar', 'granite', 'graphic',
];
const SUFFIXES = ['', 'ed', 'er', 'es', 'ing', 'ion', 'ist', 'ity', 'ly', 'ment', 'ness', 'or', 's', 'al', 'ic', 'ive'];
const VOCAB: string[] = [];
for (const r of ROOTS) {
  for (const s of SUFFIXES) {
    VOCAB.push(`${r}${s}`);
  }
}

/**
 * Generates a unique flat string of roughly `targetChars` with realistic prose structure.
 * For very large targets (> 60k chars), builds a unique 55k-char head plus numbered pages
 * so each note allocates its own distinct flat string in V8 without spending seconds in generation.
 */
function buildUniqueText(noteIndex: number, targetChars: number, rng: () => number): string {
  const uniqueChunkTarget = Math.min(targetChars, 55_000);
  const parts: string[] = [`Document record DOC-${noteIndex}-${Math.floor(rng() * 900_000 + 100_000)}.`];
  let len = parts[0].length;
  let sentenceIdx = 0;

  while (len < uniqueChunkTarget) {
    const wordsInSentence = 14 + Math.floor(rng() * 12);
    const words: string[] = [];
    for (let w = 0; w < wordsInSentence; w++) {
      const idx = Math.floor(rng() * VOCAB.length);
      words.push(VOCAB[idx]);
    }
    // Inject a per-note token periodically so distinct notes never accidentally share long shingles
    if (sentenceIdx % 2 === 0) {
      words[Math.floor(words.length / 2)] = `n${noteIndex}s${sentenceIdx}`;
    }
    const sentence = `${words.join(' ')}.`;
    parts.push(sentence);
    len += sentence.length + 1;
    sentenceIdx++;
  }

  if (targetChars <= uniqueChunkTarget) {
    return parts.join(' ');
  }

  // Build remaining pages up to targetChars with distinct page headers & running totals
  const baseBlock = parts.join(' ');
  const pageSlice = baseBlock.slice(0, Math.min(baseBlock.length, 6_500));
  const pages: string[] = [baseBlock];
  let totalLen = baseBlock.length;
  let pageNum = 2;
  while (totalLen < targetChars) {
    const header = `\n--- Page ${pageNum} of Document DOC-${noteIndex} (ref ${noteIndex * 131 + pageNum}) ---\n`;
    const remain = targetChars - totalLen - header.length;
    if (remain <= 0) break;
    const chunk = remain >= pageSlice.length ? pageSlice : pageSlice.slice(0, remain);
    pages.push(header + chunk);
    totalLen += header.length + chunk.length;
    pageNum++;
  }
  return pages.join('');
}

/** Mutates ~1.5% of words (excluding numbers/dates) to simulate realistic OCR character noise. */
function addOcrNoise(text: string): string {
  // Replace a handful of occurrences spread across both the prefix and tail
  let mutated = text;
  const targets = [
    ['account', 'acc0unt'],
    ['balance', 'ba1ance'],
    ['billing', 'bi11ing'],
    ['company', 'c0mpany'],
    ['current', 'currenl'],
    ['deposit', 'dep0sit'],
    ['general', 'genera1'],
  ];
  for (const [from, to] of targets) {
    const first = mutated.indexOf(from);
    if (first !== -1) {
      mutated = mutated.slice(0, first) + to + mutated.slice(first + from.length);
    }
    const lateStart = Math.floor(mutated.length * 0.75);
    const late = mutated.indexOf(from, lateStart);
    if (late !== -1) {
      mutated = mutated.slice(0, late) + to + mutated.slice(late + from.length);
    }
  }
  return mutated;
}

function makeNoteInput(
  key: string,
  opts: {
    title: string;
    body?: string;
    notebookTitle: string;
    notebookPath?: string;
    tagCount?: number;
    createdTime: number;
    html?: boolean;
    resource?: {
      key: string;
      mime: string;
      size: number;
      ocrText: string;
      filename: string;
    };
  }
): DuplicateNoteInput {
  const id = makeId(key);
  const updatedTime = opts.createdTime + 1000;
  const linkedResources: ResourceMetadata[] = opts.resource
    ? [
        {
          id: makeId(`res-${opts.resource.key}`),
          title: opts.resource.filename,
          mime: opts.resource.mime,
          filename: opts.resource.filename,
          fileExtension: 'pdf',
          size: opts.resource.size,
          updatedTime,
          ocrText: opts.resource.ocrText,
          ocrStatus: 2,
        },
      ]
    : [];

  const body = opts.body ?? (linkedResources.length > 0 ? `[${linkedResources[0].filename}](:/${linkedResources[0].id})` : '');
  const note: RawJoplinItem = {
    id,
    type_: JoplinItemType.Note,
    title: opts.title,
    body,
    parentId: makeId(`nb-${opts.notebookTitle}`),
    createdTime: opts.createdTime,
    updatedTime,
    userCreatedTime: opts.createdTime,
    userUpdatedTime: updatedTime,
    deletedTime: 0,
    isTodo: false,
    todoDue: 0,
    todoCompleted: 0,
    properties: {
      markup_language: opts.html ? '2' : '1',
      encryption_applied: '0',
    },
  };

  return {
    note,
    notebookTitle: opts.notebookTitle,
    notebookPath: opts.notebookPath ?? opts.notebookTitle,
    tagCount: opts.tagCount ?? 0,
    linkedResources,
  };
}

function buildRealisticFixture(): {
  inputs: DuplicateNoteInput[];
  expectedIdenticalPairs: Array<[string, string]>;
  expectedNearPairs: Array<[string, string]>;
  totalTextBytes: number;
} {
  const rng = makeRng(20261125);
  const inputs: DuplicateNoteInput[] = [];
  const expectedIdenticalPairs: Array<[string, string]> = [];
  const expectedNearPairs: Array<[string, string]> = [];
  let totalTextBytes = 0;

  const topics = ['Finance', 'Travel', 'Engineering', 'Medical', 'Housing', 'Insurance', 'Tax', 'Receipts', 'Legal', 'Research'];
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];

  // 1. 200 monthly bank statements sharing heavy boilerplate (~4 KB each) — MUST NOT MATCH
  const boilerplateTail = [
    'Your deposits are protected by the Financial Services Compensation Scheme up to the statutory limit per eligible depositor.',
    'Important information about arranged overdrafts, unarranged overdrafts, direct debit guarantees, standing orders, Faster Payments, CHAPS transfers, and foreign currency card fees applies to this current account.',
    'Please check your monthly statement carefully and notify our customer support team immediately if you notice any unrecognised or disputed transactions.',
    'Interest rates are variable and calculated daily on cleared credit balances. Statements are issued electronically each calendar month.',
  ].join(' ');
  const repeatedBoilerplate = Array.from({ length: 5 }, (_, idx) => `Section ${idx + 1}: ${boilerplateTail}`).join('\n');

  for (let i = 0; i < 200; i++) {
    const year = 2010 + Math.floor(i / 12);
    const monthIdx = i % 12;
    const month = months[monthIdx];
    const mm = String(monthIdx + 1).padStart(2, '0');
    const ocr = [
      'NORTHERN TRUST RETAIL BANKING GROUP PLC — MONTHLY CURRENT ACCOUNT STATEMENT',
      'Authorised by the Prudential Regulation Authority and regulated by the Financial Conduct Authority.',
      'Account Holder: Demo Account Holder | Sort Code: 20-00-00 | Account Number: 12345678',
      `Statement Period: 01/${mm}/${year} to 28/${mm}/${year} (${month} ${year}) | Statement Ref: STMT-${year}-${mm}`,
      `03/${mm}/${year} Direct Debit EnergyCo £${(110 + i * 2.13).toFixed(2)}`,
      `11/${mm}/${year} Card Payment GrocerMarket £${(42 + (i % 31) * 4.55).toFixed(2)}`,
      `19/${mm}/${year} Faster Payment Transfer £${(200 + i * 7.89).toFixed(2)}`,
      `28/${mm}/${year} Monthly Salary Credit £${(4100 + (i % 17) * 55).toFixed(2)}`,
      `Opening Balance: £${(2500 + i * 33.41).toFixed(2)} | Closing Balance: £${(2890 + i * 41.17).toFixed(2)}`,
      repeatedBoilerplate,
    ].join('\n');
    totalTextBytes += ocr.length;
    inputs.push(
      makeNoteInput(`stmt-${i}`, {
        title: 'Bank Statement',
        notebookTitle: 'Banking',
        createdTime: 1_700_000_000_000 + i * 1000,
        resource: {
          key: `r-stmt-${i}`,
          mime: 'application/pdf',
          size: 180_000 + (i % 5) * 800,
          ocrText: ocr,
          filename: `statement_${year}_${mm}.pdf`,
        },
      })
    );
  }

  // 2. 5,000 OCR scans averaging ~15k chars (ranging 5k–25k chars)
  // Includes 10 planted identical pairs + 5 planted near pairs
  let idx = 200;
  for (let i = 0; i < 5_000; i++, idx++) {
    const targetChars = 5_000 + ((i * 397) % 20_001); // uniform 5k..25k -> avg ~15k
    const ocr = buildUniqueText(idx, targetChars, rng);
    totalTextBytes += ocr.length;
    const topic = topics[i % topics.length];
    inputs.push(
      makeNoteInput(`scan-${i}`, {
        title: `Scan ${i % 80}`,
        notebookTitle: i % 5 === 0 ? 'Pending to sort' : topic,
        createdTime: 1_700_000_000_000 + idx * 1000,
        resource: {
          key: `r-scan-${i}`,
          mime: 'application/pdf',
          size: 120_000 + (i % 400) * 1024,
          ocrText: ocr,
          filename: `scan_${i}.pdf`,
        },
      })
    );
  }

  // Plant 10 identical + 5 near pairs inside the 5,000 medium scans
  for (let k = 0; k < 10; k++) {
    const posA = 200 + k * 2;
    const posB = posA + 1;
    const baseOcr = inputs[posA].linkedResources[0].ocrText;
    const copy = makeNoteInput(`scan-ident-copy-${k}`, {
      title: 'Scannable Document',
      notebookTitle: 'Pending to sort',
      createdTime: inputs[posA].note.createdTime + 500_000,
      resource: {
        key: `r-scan-ident-copy-${k}`,
        mime: 'application/pdf',
        size: inputs[posA].linkedResources[0].size,
        ocrText: `${baseOcr}`, // distinct string value with same content
        filename: `rescan_ident_${k}.pdf`,
      },
    });
    inputs[posB] = copy;
    expectedIdenticalPairs.push([inputs[posA].note.id, copy.note.id]);
  }
  for (let k = 0; k < 5; k++) {
    const posA = 250 + k * 2;
    const posB = posA + 1;
    const noisy = addOcrNoise(inputs[posA].linkedResources[0].ocrText);
    const copy = makeNoteInput(`scan-near-copy-${k}`, {
      title: 'Scanned Copy',
      notebookTitle: 'Pending to sort',
      createdTime: inputs[posA].note.createdTime + 500_000,
      resource: {
        key: `r-scan-near-copy-${k}`,
        mime: 'application/pdf',
        size: inputs[posA].linkedResources[0].size + 2_400,
        ocrText: noisy,
        filename: `rescan_near_${k}.pdf`,
      },
    });
    inputs[posB] = copy;
    expectedNearPairs.push([inputs[posA].note.id, copy.note.id]);
  }

  // 3. 100 huge OCR scans (~600k chars each) — includes 2 identical pairs + 2 near pairs
  const hugeStart = inputs.length;
  for (let i = 0; i < 100; i++, idx++) {
    const ocr = buildUniqueText(idx, 600_000, rng);
    totalTextBytes += ocr.length;
    inputs.push(
      makeNoteInput(`huge600k-${i}`, {
        title: `Manual ${i}`,
        notebookTitle: topics[i % topics.length],
        createdTime: 1_700_000_000_000 + idx * 1000,
        resource: {
          key: `r-huge600k-${i}`,
          mime: 'application/pdf',
          size: 4_500_000 + i * 10_000,
          ocrText: ocr,
          filename: `manual_${i}.pdf`,
        },
      })
    );
  }
  for (let k = 0; k < 2; k++) {
    const posA = hugeStart + k * 2;
    const posB = posA + 1;
    const baseOcr = inputs[posA].linkedResources[0].ocrText;
    // Slight whitespace change so it's an independent string and exercises normalization
    const copyOcr = ` ${baseOcr}\n`;
    const copy = makeNoteInput(`huge600k-ident-${k}`, {
      title: 'Duplicate Manual',
      notebookTitle: 'Pending to sort',
      createdTime: inputs[posA].note.createdTime + 500_000,
      resource: {
        key: `r-huge600k-ident-${k}`,
        mime: 'application/pdf',
        size: inputs[posA].linkedResources[0].size,
        ocrText: copyOcr,
        filename: `dup_manual_${k}.pdf`,
      },
    });
    inputs[posB] = copy;
    expectedIdenticalPairs.push([inputs[posA].note.id, copy.note.id]);
  }
  for (let k = 0; k < 2; k++) {
    const posA = hugeStart + 10 + k * 2;
    const posB = posA + 1;
    const noisy = addOcrNoise(inputs[posA].linkedResources[0].ocrText);
    const copy = makeNoteInput(`huge600k-near-${k}`, {
      title: 'Rescanned Manual',
      notebookTitle: 'Pending to sort',
      createdTime: inputs[posA].note.createdTime + 500_000,
      resource: {
        key: `r-huge600k-near-${k}`,
        mime: 'application/pdf',
        size: inputs[posA].linkedResources[0].size + 45_000,
        ocrText: noisy,
        filename: `rescan_manual_${k}.pdf`,
      },
    });
    inputs[posB] = copy;
    expectedNearPairs.push([inputs[posA].note.id, copy.note.id]);
  }

  // 4. 30 massive OCR scans (~2M chars each) — includes 1 identical pair + 1 near pair
  const massiveStart = inputs.length;
  for (let i = 0; i < 30; i++, idx++) {
    const ocr = buildUniqueText(idx, 2_000_000, rng);
    totalTextBytes += ocr.length;
    inputs.push(
      makeNoteInput(`huge2m-${i}`, {
        title: `Archive Book ${i}`,
        notebookTitle: 'Research',
        createdTime: 1_700_000_000_000 + idx * 1000,
        resource: {
          key: `r-huge2m-${i}`,
          mime: 'application/pdf',
          size: 18_000_000 + i * 50_000,
          ocrText: ocr,
          filename: `book_${i}.pdf`,
        },
      })
    );
  }
  {
    const posA = massiveStart;
    const posB = massiveStart + 1;
    const copy = makeNoteInput('huge2m-ident-0', {
      title: 'Duplicate Book',
      notebookTitle: 'Pending to sort',
      createdTime: inputs[posA].note.createdTime + 500_000,
      resource: {
        key: 'r-huge2m-ident-0',
        mime: 'application/pdf',
        size: inputs[posA].linkedResources[0].size,
        ocrText: `${inputs[posA].linkedResources[0].ocrText}\n`,
        filename: 'book_copy.pdf',
      },
    });
    inputs[posB] = copy;
    expectedIdenticalPairs.push([inputs[posA].note.id, copy.note.id]);
  }
  {
    const posA = massiveStart + 2;
    const posB = massiveStart + 3;
    const noisy = addOcrNoise(inputs[posA].linkedResources[0].ocrText);
    const copy = makeNoteInput('huge2m-near-0', {
      title: 'Rescanned Book',
      notebookTitle: 'Pending to sort',
      createdTime: inputs[posA].note.createdTime + 500_000,
      resource: {
        key: 'r-huge2m-near-0',
        mime: 'application/pdf',
        size: inputs[posA].linkedResources[0].size + 120_000,
        ocrText: noisy,
        filename: 'book_rescan.pdf',
      },
    });
    inputs[posB] = copy;
    expectedNearPairs.push([inputs[posA].note.id, copy.note.id]);
  }

  // 5. 1,000 web-clip bodies of 20k–80k chars (mix of HTML and Markdown)
  const clipStart = inputs.length;
  for (let i = 0; i < 1_000; i++, idx++) {
    const targetChars = 20_000 + ((i * 599) % 60_001); // 20k..80k -> avg ~50k
    const prose = buildUniqueText(idx, targetChars - 500, rng);
    const isHtml = i % 2 === 0;
    const body = isHtml
      ? `<article><h1>Clipped Article ${i}</h1><p>${prose.replace(/\. /g, '.</p><p>')}</p></article>`
      : `# Clipped Article ${i}\n\n${prose.replace(/\. /g, '.\n\n')}`;
    totalTextBytes += body.length;
    inputs.push(
      makeNoteInput(`clip-${i}`, {
        title: `Web Clip ${i}`,
        notebookTitle: 'Web Clips',
        createdTime: 1_700_000_000_000 + idx * 1000,
        body,
        html: isHtml,
      })
    );
  }
  // Plant 2 identical + 2 near web-clip pairs
  for (let k = 0; k < 2; k++) {
    const posA = clipStart + k * 2;
    const posB = posA + 1;
    const copy = makeNoteInput(`clip-ident-${k}`, {
      title: `Saved Clip Copy ${k}`,
      notebookTitle: 'Inbox',
      createdTime: inputs[posA].note.createdTime + 500_000,
      body: `${inputs[posA].note.body}\n`,
      html: inputs[posA].note.properties.markup_language === '2',
    });
    inputs[posB] = copy;
    expectedIdenticalPairs.push([inputs[posA].note.id, copy.note.id]);
  }
  for (let k = 0; k < 2; k++) {
    const posA = clipStart + 10 + k * 2;
    const posB = posA + 1;
    const copy = makeNoteInput(`clip-near-${k}`, {
      title: `Edited Clip Copy ${k}`,
      notebookTitle: 'Inbox',
      createdTime: inputs[posA].note.createdTime + 500_000,
      body: addOcrNoise(inputs[posA].note.body),
      html: inputs[posA].note.properties.markup_language === '2',
    });
    inputs[posB] = copy;
    expectedNearPairs.push([inputs[posA].note.id, copy.note.id]);
  }

  // 6. Remaining 5,670 regular notes (~400–900 chars each) -> total 12,000 notes
  const textStart = inputs.length;
  const remaining = 12_000 - inputs.length;
  for (let i = 0; i < remaining; i++, idx++) {
    const targetChars = 400 + ((i * 73) % 501);
    const body = buildUniqueText(idx, targetChars, rng);
    totalTextBytes += body.length;
    inputs.push(
      makeNoteInput(`txt-${i}`, {
        title: `Note ${i % 120}`,
        notebookTitle: topics[i % topics.length],
        createdTime: 1_700_000_000_000 + idx * 1000,
        body,
      })
    );
  }
  for (let k = 0; k < 5; k++) {
    const posA = textStart + k * 2;
    const posB = posA + 1;
    const copy = makeNoteInput(`txt-ident-${k}`, {
      title: `Duplicate Note ${k}`,
      notebookTitle: 'Inbox',
      createdTime: inputs[posA].note.createdTime + 500_000,
      body: `${inputs[posA].note.body} `,
    });
    inputs[posB] = copy;
    expectedIdenticalPairs.push([inputs[posA].note.id, copy.note.id]);
  }
  for (let k = 0; k < 2; k++) {
    const posA = textStart + 20 + k * 2;
    const posB = posA + 1;
    const copy = makeNoteInput(`txt-near-${k}`, {
      title: `Near Note ${k}`,
      notebookTitle: 'Inbox',
      createdTime: inputs[posA].note.createdTime + 500_000,
      body: addOcrNoise(inputs[posA].note.body),
    });
    inputs[posB] = copy;
    expectedNearPairs.push([inputs[posA].note.id, copy.note.id]);
  }

  return { inputs, expectedIdenticalPairs, expectedNearPairs, totalTextBytes };
}

function forceGc(): void {
  assert.equal(typeof global.gc, 'function', 'worker must be launched with --expose-gc');
  global.gc!();
  global.gc!();
}

const tBuildStart = performance.now();
const { inputs, expectedIdenticalPairs, expectedNearPairs, totalTextBytes } = buildRealisticFixture();
const buildMs = performance.now() - tBuildStart;

forceGc();
const baselineMem = process.memoryUsage();
const baselineHeapStats = v8.getHeapStatistics();

const tDetectStart = performance.now();
const clusters = detectDuplicateClusters(inputs);
const detectMs = performance.now() - tDetectStart;

const afterMem = process.memoryUsage();
const afterHeapStats = v8.getHeapStatistics();
forceGc();
const postGcMem = process.memoryUsage();

const toMB = (bytes: number) => Math.round((bytes / (1024 * 1024)) * 10) / 10;

const identicalClusters = clusters.filter((c) => c.tier === 'identical');
const nearClusters = clusters.filter((c) => c.tier === 'near');

const clusterContainsPair = (list: typeof clusters, pair: [string, string]): boolean =>
  list.some((c) => c.noteIds.includes(pair[0]) && c.noteIds.includes(pair[1]));

const missingIdentical = expectedIdenticalPairs.filter((p) => !clusterContainsPair(identicalClusters, p)).length;
const missingNear = expectedNearPairs.filter((p) => !clusterContainsPair(nearClusters, p)).length;

const result = {
  noteCount: inputs.length,
  totalTextMB: toMB(totalTextBytes),
  buildMs: Math.round(buildMs),
  detectMs: Math.round(detectMs),
  baselineHeapUsedMB: toMB(baselineMem.heapUsed),
  afterHeapUsedMB: toMB(afterMem.heapUsed),
  heapUsedDeltaMB: toMB(afterMem.heapUsed - baselineMem.heapUsed),
  baselineArrayBuffersMB: toMB(baselineMem.arrayBuffers),
  afterArrayBuffersMB: toMB(afterMem.arrayBuffers),
  arrayBuffersDeltaMB: toMB(afterMem.arrayBuffers - baselineMem.arrayBuffers),
  combinedDeltaMB: toMB(
    afterMem.heapUsed + afterMem.arrayBuffers - (baselineMem.heapUsed + baselineMem.arrayBuffers)
  ),
  postGcHeapDeltaMB: toMB(postGcMem.heapUsed - baselineMem.heapUsed),
  baselineRssMB: toMB(baselineMem.rss),
  afterRssMB: toMB(afterMem.rss),
  rssDeltaMB: toMB(afterMem.rss - baselineMem.rss),
  heapLimitMB: toMB(afterHeapStats.heap_size_limit),
  baselinePeakMallocedMB: toMB(baselineHeapStats.peak_malloced_memory),
  afterPeakMallocedMB: toMB(afterHeapStats.peak_malloced_memory),
  identicalFound: identicalClusters.length,
  identicalExpected: expectedIdenticalPairs.length,
  nearFound: nearClusters.length,
  nearExpected: expectedNearPairs.length,
  missingIdentical,
  missingNear,
};

console.log(JSON.stringify(result));

assert.equal(missingIdentical, 0, `missing ${missingIdentical} planted identical pairs`);
assert.equal(missingNear, 0, `missing ${missingNear} planted near pairs`);
assert.equal(identicalClusters.length, expectedIdenticalPairs.length, 'unexpected extra identical clusters');
assert.equal(nearClusters.length, expectedNearPairs.length, 'unexpected extra near clusters');
