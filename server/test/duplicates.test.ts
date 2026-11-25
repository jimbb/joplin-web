import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import {
  canonicalPairKey,
  detectDuplicateClusters,
  isInboxLikeNotebook,
  type DuplicateNoteInput,
} from '../src/services/duplicates.js';
import { JoplinItemType, type RawJoplinItem, type ResourceMetadata } from '../src/types/index.js';

const makeId = (key: string): string => createHash('md5').update(`dup-test:${key}`).digest('hex');

function makeNote(
  key: string,
  opts: {
    title?: string;
    body?: string;
    notebookTitle?: string;
    notebookPath?: string;
    tagCount?: number;
    createdTime?: number;
    updatedTime?: number;
    html?: boolean;
    resources?: Array<{
      key: string;
      mime?: string;
      size?: number;
      ocrText?: string;
      filename?: string;
    }>;
  } = {}
): DuplicateNoteInput {
  const id = makeId(key);
  const createdTime = opts.createdTime ?? 1_700_000_000_000;
  const updatedTime = opts.updatedTime ?? createdTime + 1000;
  const linkedResources: ResourceMetadata[] = (opts.resources ?? []).map((r) => ({
    id: makeId(`res-${r.key}`),
    title: r.filename ?? `${r.key}.pdf`,
    mime: r.mime ?? 'application/pdf',
    filename: r.filename ?? `${r.key}.pdf`,
    fileExtension: (r.filename ?? 'pdf').split('.').pop() || 'pdf',
    size: r.size ?? 100_000,
    updatedTime,
    ocrText: r.ocrText ?? '',
    ...(r.ocrText ? { ocrStatus: 2 } : {}),
  }));

  let body = opts.body ?? '';
  if (!opts.body && linkedResources.length > 0) {
    body = linkedResources.map((r) => `[${r.filename}](:/${r.id})`).join('\n');
  }

  const note: RawJoplinItem = {
    id,
    type_: JoplinItemType.Note,
    title: opts.title ?? `Note ${key}`,
    body,
    parentId: makeId(`nb-${opts.notebookTitle ?? 'General'}`),
    createdTime,
    updatedTime,
    userCreatedTime: createdTime,
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
    notebookTitle: opts.notebookTitle ?? 'General',
    notebookPath: opts.notebookPath ?? opts.notebookTitle ?? 'General',
    tagCount: opts.tagCount ?? 0,
    linkedResources,
  };
}

describe('content-based duplicate detection', () => {
  test('detects identical scanned PDFs even when titles and filenames differ', () => {
    const ocr = [
      'ACME CLOUD SERVICES INC.',
      'INVOICE #INV-2024-0311',
      'Date: March 11, 2024',
      'Bill To: Studio North Design',
      'Description: Dedicated Backup Storage (2 TB) - Yearly Renewal',
      'Total Paid: $420.00',
    ].join('\n');

    const a = makeNote('scan-filed', {
      title: '2024-03-11 Acme Cloud Invoice',
      notebookTitle: 'Receipts',
      notebookPath: 'Finance / Receipts',
      tagCount: 2,
      createdTime: 1000,
      resources: [{ key: 'pdf-1', mime: 'application/pdf', size: 245_120, ocrText: ocr, filename: 'acme_2024.pdf' }],
    });
    const b = makeNote('scan-inbox', {
      title: 'Scannable Document',
      notebookTitle: 'Pending to sort',
      notebookPath: 'Pending to sort',
      tagCount: 0,
      createdTime: 2000,
      resources: [{ key: 'pdf-2', mime: 'application/pdf', size: 245_120, ocrText: ocr, filename: 'scan_0094.pdf' }],
    });

    const clusters = detectDuplicateClusters([a, b]);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].tier, 'identical');
    assert.equal(clusters[0].score, 1);
    assert.equal(clusters[0].suggestedKeeperId, a.note.id);
    assert.deepEqual(clusters[0].noteIds, [a.note.id, b.note.id]);
    assert.match(clusters[0].evidence, /same attachment/i);
    assert.match(clusters[0].evidence, /OCR/i);
  });

  test('detects identical attachment-only notes when neither has OCR', () => {
    const a = makeNote('img-1', {
      title: 'IMG_1001.JPG',
      notebookTitle: 'Photos',
      createdTime: 1000,
      resources: [{ key: 'jpg-a', mime: 'image/jpeg', size: 1_450_000, filename: 'IMG_1001.JPG' }],
    });
    const b = makeNote('img-2', {
      title: 'Photo copy',
      notebookTitle: 'Inbox',
      createdTime: 2000,
      resources: [{ key: 'jpg-b', mime: 'image/jpeg', size: 1_450_000, filename: 'copy.jpg' }],
    });

    const clusters = detectDuplicateClusters([a, b]);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].tier, 'identical');
    assert.equal(clusters[0].suggestedKeeperId, a.note.id);
    assert.match(clusters[0].evidence, /1\.4 MB/i);
  });

  test('never matches different scans or notes solely because they share a title', () => {
    const scans = [1, 2, 3, 4].map((n) =>
      makeNote(`hmrc-${n}`, {
        title: '2023-10-26 HMRC – Tax return',
        notebookTitle: 'Tax',
        resources: [
          {
            key: `hmrc-pdf-${n}`,
            mime: 'application/pdf',
            size: 120_000 + n * 17_500,
            ocrText: `HM Revenue and Customs Self Assessment Section ${n}. Reference UTR 9000${n}88${n}. Page content specific to schedule ${n} with amount £${n * 1234}.56.`,
          },
        ],
      })
    );

    const genericA = makeNote('generic-a', {
      title: 'Note',
      body: 'Buy oat milk, sourdough bread, ripe avocados, and roasted coffee beans from the market.',
    });
    const genericB = makeNote('generic-b', {
      title: 'Note',
      body: 'Check passport renewal appointment slots at the consulate and print the application form.',
    });

    const clusters = detectDuplicateClusters([...scans, genericA, genericB]);
    assert.equal(clusters.length, 0);
  });

  test('does not match monthly bank statements sharing boilerplate but differing in dates and amounts', () => {
    const makeStatement = (key: string, month: string, dateRange: string, txns: string[], balance: string, size: number) =>
      makeNote(key, {
        title: `Bank Statement ${month} 2024`,
        notebookTitle: 'Banking',
        resources: [
          {
            key: `stmt-${key}`,
            mime: 'application/pdf',
            size,
            ocrText: [
              'NORTHERN TRUST RETAIL BANK PLC',
              'Authorised by the Prudential Regulation Authority and regulated by the Financial Conduct Authority.',
              'Account Holder: Jimmy Kwok | Sort Code: 20-00-00 | Account Number: 12345678',
              'Registered Office: 1 Churchill Place, London E14 5HP. Customer helpline 0800 123 456.',
              `Monthly Current Account Statement — Period: ${dateRange} (${month} 2024)`,
              'Your deposits are protected by the Financial Services Compensation Scheme up to the statutory limit.',
              'Important information about overdrafts, direct debits, standing orders, and foreign card fees applies to this account.',
              ...txns,
              `Closing Balance on statement date: £${balance}`,
              'Please check your statement carefully and report any unrecognised transactions immediately.',
            ].join('\n'),
          },
        ],
      });

    const jan = makeStatement(
      'stmt-jan',
      'January',
      '01/01/2024 to 31/01/2024',
      ['04/01/2024 Direct Debit EnergyCo £142.50', '12/01/2024 Card Purchase Sainsburys £64.20', '28/01/2024 Salary Credit £4,250.00'],
      '3,812.40',
      182_000
    );
    const feb = makeStatement(
      'stmt-feb',
      'February',
      '01/02/2024 to 29/02/2024',
      ['05/02/2024 Direct Debit EnergyCo £158.90', '14/02/2024 Card Purchase Waitrose £81.15', '28/02/2024 Salary Credit £4,250.00'],
      '4,109.75',
      184_500
    );
    const marSameAmount = makeStatement(
      'stmt-mar',
      'March',
      '01/03/2024 to 31/03/2024',
      ['05/03/2024 Direct Debit EnergyCo £158.90', '14/03/2024 Card Purchase Waitrose £81.15', '28/03/2024 Salary Credit £4,250.00'],
      '4,109.75',
      184_500
    );

    const clusters = detectDuplicateClusters([jan, feb, marSameAmount]);
    assert.equal(clusters.length, 0);
  });

  test('detects near-duplicate OCR scans with OCR noise when dates, amounts, and size agree', () => {
    const cleanOcr = [
      'THAMES WATER UTILITIES LIMITED',
      'Annual Water and Sewerage Account Statement',
      'Customer Reference: 884120934',
      'Billing Period: 01 April 2024 to 31 March 2025',
      'Property Address: 42 Maple Gardens, Kingston upon Thames, KT1 2AB',
      'Metered water supply charges for the period calculated on actual reading.',
      'Direct debit instalment plan remains active on the first working day of each month.',
      'Total Annual Charge: £486.20',
      'Monthly Direct Debit Payment: £40.52',
      'Thank you for managing your account online and keeping paper usage low.',
    ].join('\n');

    const noisyOcr = [
      'THAMES WATER UTILITIES LlMITED',
      'Annual Water and Sewerage Account Statement',
      'Customer Reference: 884120934',
      'Billing Period: 01 April 2024 to 31 March 2025',
      'Property Address: 42 Maple Gardens, Kingston upon Thames, KT1 2AB',
      'Metered water supply charges for the period calculaled on actual reading.',
      'Direct debit instalment plan remains active on the first working day of each month.',
      'Total Annual Charge: £486.20',
      'Monthly Direct Debit Payment: £40.52',
      'Thank you for manag1ng your account online and keeping paper usage low.',
    ].join('\n');

    const a = makeNote('water-filed', {
      title: '2024-04-01 Thames Water Annual Bill',
      notebookTitle: 'Utilities',
      notebookPath: 'Home / Utilities',
      tagCount: 1,
      createdTime: 5000,
      resources: [{ key: 'water-a', mime: 'application/pdf', size: 312_000, ocrText: cleanOcr }],
    });
    const b = makeNote('water-rescan', {
      title: 'Scan 2024-04-02',
      notebookTitle: 'Pending to sort',
      notebookPath: 'Pending to sort',
      tagCount: 0,
      createdTime: 6000,
      resources: [{ key: 'water-b', mime: 'application/pdf', size: 325_000, ocrText: noisyOcr }],
    });

    const clusters = detectDuplicateClusters([a, b]);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].tier, 'near');
    assert.ok(clusters[0].score >= 0.85 && clusters[0].score < 1, `expected near score, got ${clusters[0].score}`);
    assert.equal(clusters[0].suggestedKeeperId, a.note.id);
    assert.match(clusters[0].evidence, /% same text/);
    assert.match(clusters[0].evidence, /same dates\/amounts/);
  });

  test('prevents transitive A~B~C chaining when A and C differ', () => {
    // Build 3 notes where A shares 80% with B, B shares 80% with C, but A and C share only ~60% (below threshold)
    const common = Array.from({ length: 24 }, (_, i) => `sharedword${i}`).join(' ');
    const onlyA = Array.from({ length: 6 }, (_, i) => `alphaonly${i}`).join(' ');
    const onlyC = Array.from({ length: 6 }, (_, i) => `gammaonly${i}`).join(' ');

    // A = onlyA (6) + common (24) = 30 words
    // B = onlyA (3) + common (24) + onlyC (3) = 30 words -> close to both A and C
    // C = common (24) + onlyC (6) = 30 words -> further from A
    // Add distinct prefix/suffix blocks so A~B and B~C pass shingle threshold while A!~C fails
    const wordsA = [...onlyA.split(' '), ...common.split(' ')];
    const wordsB = [...onlyA.split(' ').slice(0, 3), ...common.split(' '), ...onlyC.split(' ').slice(0, 3)];
    const wordsC = [...common.split(' '), ...onlyC.split(' ')];

    // Verify A~B matches on its own and B~C matches on its own, while A~C does NOT match
    const noteA = makeNote('chain-a', { title: 'A', body: wordsA.join(' '), createdTime: 1000 });
    const noteB = makeNote('chain-b', { title: 'B', body: wordsB.join(' '), createdTime: 2000 });
    const noteC = makeNote('chain-c', { title: 'C', body: wordsC.join(' '), createdTime: 3000 });

    const ab = detectDuplicateClusters([noteA, noteB]);
    const bc = detectDuplicateClusters([noteB, noteC]);
    const ac = detectDuplicateClusters([noteA, noteC]);
    assert.equal(ab.length, 1, 'A and B should match');
    assert.equal(bc.length, 1, 'B and C should match');
    assert.equal(ac.length, 0, 'A and C must NOT match directly');

    const all = detectDuplicateClusters([noteA, noteB, noteC]);
    for (const cluster of all) {
      assert.ok(
        !(cluster.noteIds.includes(noteA.note.id) && cluster.noteIds.includes(noteC.note.id)),
        'A and C must never be transitively chained into the same cluster'
      );
      assert.equal(cluster.noteIds.length, 2);
    }
  });

  test('filters out dismissed pairs for both identical and near duplicates', () => {
    const body = 'Quarterly engineering retrospective covering architecture decisions, incident response drills, and latency budgets.';
    const a = makeNote('dis-a', { body, createdTime: 1000 });
    const b = makeNote('dis-b', { body, createdTime: 2000 });
    const c = makeNote('dis-c', {
      body: 'Quarterly engineering retrospective covering architecture decisions, incident response drills, and latency targets.',
      createdTime: 3000,
    });

    assert.equal(detectDuplicateClusters([a, b]).length, 1);
    const dismissed = new Set([canonicalPairKey(a.note.id, b.note.id)]);
    assert.equal(detectDuplicateClusters([a, b], dismissed).length, 0);

    // Near pair dismissal
    assert.equal(detectDuplicateClusters([a, c]).length, 1);
    const dismissedNear = new Set([canonicalPairKey(a.note.id, c.note.id)]);
    assert.equal(detectDuplicateClusters([a, c], dismissedNear).length, 0);
  });

  test('picks suggested keeper by non-inbox notebook, then more tags, then oldest created', () => {
    const body = 'Shared meeting notes documenting deployment steps, rollback checklist, and on-call escalation contacts.';
    const inboxOlderMoreTags = makeNote('k-inbox', {
      body,
      notebookTitle: 'Pending to sort',
      tagCount: 5,
      createdTime: 100,
    });
    const filedFewTagsOlder = makeNote('k-filed-1', {
      body,
      notebookTitle: 'Engineering',
      tagCount: 1,
      createdTime: 200,
    });
    const filedMoreTagsNewer = makeNote('k-filed-2', {
      body,
      notebookTitle: 'Engineering',
      tagCount: 3,
      createdTime: 500,
    });
    const filedMoreTagsOldest = makeNote('k-filed-3', {
      body,
      notebookTitle: 'Engineering',
      tagCount: 3,
      createdTime: 300,
    });

    const clusters = detectDuplicateClusters([
      inboxOlderMoreTags,
      filedFewTagsOlder,
      filedMoreTagsNewer,
      filedMoreTagsOldest,
    ]);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].suggestedKeeperId, filedMoreTagsOldest.note.id);
    assert.equal(clusters[0].noteIds[0], filedMoreTagsOldest.note.id);
    assert.equal(isInboxLikeNotebook('Pending to sort', 'Pending to sort'), true);
    assert.equal(isInboxLikeNotebook('Sub', 'Inbox / Sub'), true);
    assert.equal(isInboxLikeNotebook('Engineering', 'Work / Engineering'), false);
  });

  test('ignores tiny text-only notes with no attachments', () => {
    const a = makeNote('tiny-1', { body: 'ok' });
    const b = makeNote('tiny-2', { body: 'ok' });
    assert.equal(detectDuplicateClusters([a, b]).length, 0);
  });

  test('scales to 10,000 notes (~5,000 OCR attachments) well under 2 seconds', () => {
    const TOTAL = 10_000;
    const inputs: DuplicateNoteInput[] = [];
    const topics = ['finance', 'travel', 'engineering', 'medical', 'housing', 'insurance', 'tax', 'receipts', 'legal', 'education'];

    // Deterministic synthetic 10k-note corpus:
    // - 5,000 OCR'd scans (including 200 monthly boilerplate bank statements that must NOT match)
    // - 5,000 regular notes
    // - 15 injected identical clusters + 10 injected near-duplicate clusters
    for (let i = 0; i < TOTAL; i++) {
      const topic = topics[i % topics.length];
      if (i < 200) {
        // Monthly statements sharing heavy boilerplate but distinct dates & amounts
        const year = 2015 + Math.floor(i / 12);
        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        const month = monthNames[i % 12];
        const ocr = [
          'GLOBAL RETAIL BANKING GROUP PLC STATEMENT OF ACCOUNT',
          'Regulated by the Financial Conduct Authority. Account Holder: Demo User. Sort Code 20-00-00.',
          `Statement Period: ${month} ${year} Reference STMT-${year}-${String((i % 12) + 1).padStart(2, '0')}`,
          `Opening balance £${(1000 + i * 37.25).toFixed(2)} Transaction payment £${(45 + i * 3.17).toFixed(2)} Closing balance £${(1400 + i * 29.83).toFixed(2)}`,
          'Direct debit guarantee and customer service information enclosed on reverse.',
        ].join('\n');
        inputs.push(
          makeNote(`stmt-${i}`, {
            title: 'Bank Statement',
            notebookTitle: 'Banking',
            createdTime: 1_700_000_000_000 + i * 1000,
            resources: [{ key: `r-stmt-${i}`, size: 150_000 + (i % 7) * 500, ocrText: ocr }],
          })
        );
      } else if (i < 5000) {
        // Unique OCR'd scanned document
        const ocr = `Document ${i} category ${topic} ref code DOC-${i}-X${(i * 17) % 997}. Detailed record describing item alpha${i} beta${i * 3} gamma${i * 7} delta${i * 11} epsilon${i * 13} zeta${i * 19} eta${i * 23} theta${i * 29} amount £${(10 + (i % 500) * 1.37).toFixed(2)}.`;
        inputs.push(
          makeNote(`ocr-${i}`, {
            title: `Scan ${i % 50}`,
            notebookTitle: i % 4 === 0 ? 'Pending to sort' : topic,
            createdTime: 1_700_000_000_000 + i * 1000,
            resources: [{ key: `r-ocr-${i}`, size: 90_000 + (i % 400) * 1024, ocrText: ocr }],
          })
        );
      } else {
        // Unique text note
        const body = `Project note ${i} in ${topic}: summary of milestone m${i} covering component c${i * 5} module mod${i * 7} endpoint ep${i * 11} benchmark bm${i * 13} review rev${i * 17} checklist item chk${i * 19} and follow-up action act${i * 23}.`;
        inputs.push(
          makeNote(`txt-${i}`, {
            title: `Note ${i % 100}`,
            notebookTitle: topic,
            createdTime: 1_700_000_000_000 + i * 1000,
            body,
          })
        );
      }
    }

    // Inject 15 identical pairs (scans + text) and 10 near pairs (OCR noise)
    for (let k = 0; k < 15; k++) {
      const baseOcr = `Official receipt number REC-${90000 + k} issued on 14 October 2024 for maintenance package pkg${k} serial sr${k}99 total £${(120 + k * 15).toFixed(2)} paid in full.`;
      inputs[250 + k * 2] = makeNote(`ident-a-${k}`, {
        title: `Filed Receipt ${k}`,
        notebookTitle: 'Receipts',
        tagCount: 2,
        createdTime: 1000 + k,
        resources: [{ key: `r-ident-a-${k}`, size: 210_000 + k * 100, ocrText: baseOcr }],
      });
      inputs[250 + k * 2 + 1] = makeNote(`ident-b-${k}`, {
        title: 'Scannable Document',
        notebookTitle: 'Pending to sort',
        createdTime: 2000 + k,
        resources: [{ key: `r-ident-b-${k}`, size: 210_000 + k * 100, ocrText: baseOcr }],
      });
    }

    for (let k = 0; k < 10; k++) {
      const words = Array.from({ length: 45 }, (_, w) => `contract${k}clause${w}`).join(' ');
      const ocrA = `Service Agreement ref AGR-${5000 + k} dated 19 November 2024 value £${(850 + k * 10).toFixed(2)}. ${words}`;
      const ocrB = `Service Agreement ref AGR-${5000 + k} dated 19 November 2024 value £${(850 + k * 10).toFixed(2)}. ${words.replace(`contract${k}clause10`, `contract${k}c1ause10`).replace(`contract${k}clause30`, `contract${k}c1ause30`)}`;
      inputs[600 + k * 2] = makeNote(`near-a-${k}`, {
        title: `Contract ${k}`,
        notebookTitle: 'Legal',
        tagCount: 1,
        createdTime: 1000 + k,
        resources: [{ key: `r-near-a-${k}`, size: 300_000 + k * 500, ocrText: ocrA }],
      });
      inputs[600 + k * 2 + 1] = makeNote(`near-b-${k}`, {
        title: 'Scanned Contract',
        notebookTitle: 'Pending to sort',
        createdTime: 2000 + k,
        resources: [{ key: `r-near-b-${k}`, size: 305_000 + k * 500, ocrText: ocrB }],
      });
    }

    const start = performance.now();
    const clusters = detectDuplicateClusters(inputs);
    const elapsedMs = performance.now() - start;

    const identicalCount = clusters.filter((c) => c.tier === 'identical').length;
    const nearCount = clusters.filter((c) => c.tier === 'near').length;
    console.log(`[Perf] 10,000 notes (5k OCR): ${elapsedMs.toFixed(1)} ms (${identicalCount} identical, ${nearCount} near)`);

    assert.equal(identicalCount, 15, 'should detect all 15 injected identical scan pairs');
    assert.equal(nearCount, 10, 'should detect all 10 injected near OCR pairs (and zero statement false positives)');
    assert.ok(elapsedMs < 2000, `expected < 2000 ms on 10k notes, took ${elapsedMs.toFixed(1)} ms`);
  });
});
