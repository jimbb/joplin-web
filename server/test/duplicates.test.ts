import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import {
  canonicalPairKey,
  countWordsInNormalized,
  detectDuplicateClusters,
  extractLeadingTitleDate,
  extractNormalizedDates,
  isInboxLikeNotebook,
  normalizeContentText,
  titleDatesConflict,
  tokenizeWords,
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

  test('does not match realistic monthly bank statements across 12 months, yet matches a noisy rescan of the same month', () => {
    // ~95% shared boilerplate including many static numbers (account no., sort code, phone numbers,
    // regulatory IDs, and a full static fee schedule) so prefix number Jaccard stays high.
    const staticHeader = [
      'HSBC UK BANK PLC — CONSOLIDATED MONTHLY CURRENT ACCOUNT STATEMENT',
      'Authorised by the Prudential Regulation Authority and regulated by the Financial Conduct Authority (Firm Reference Number 765112).',
      'Registered Office: 1 Centenary Square, Birmingham B1 1HQ. Company Number 09928412.',
      'Account Holder: Jimmy Kwok | Sort Code: 40-11-60 | Account Number: 81492037 | IBAN: GB29HBUK40116081492037 | BIC: HBUKGB4B',
      '24-hour Telephone Banking: 03457 404 404 | From abroad: +44 1226 261 010 | Lost or stolen cards: 0800 085 2401 | Textphone: 03457 125 563.',
    ].join('\n');

    const staticFeeAndLegalBoilerplate = [
      'STANDARD TARIFF & SCHEDULE OF CHARGES (EFFECTIVE FOR PERSONAL CURRENT ACCOUNTS)',
      'Monthly Account Maintenance Fee: £0.00 | Paper Statement Duplicate Copy: £5.00 | Stopped Cheque Fee: £10.00',
      'CHAPS Same-Day UK Transfer: £25.00 | International SWIFT Wire Transfer: £17.50 | Banker Draft Issuance: £15.00',
      'Foreign Currency Cash Withdrawal Minimum Fee: £3.00 | Non-Sterling Debit Card Fee Cap: £12.50',
      'Unarranged Overdraft Monthly Cap: £20.00 | Returned Direct Debit Notice Fee: £8.00 | Express Card Courier: £35.00',
      'Arranged Overdraft Buffer: £250.00 | Daily ATM Cash Withdrawal Limit: £500.00 | Faster Payment Single Limit: £25,000.00',
      'Representative EAR on Arranged Overdraft: 39.90% variable | Credit Interest Tier 1 Threshold: £1,000.00 | Tier 2 Threshold: £5,000.00.',
      'Your eligible deposits with HSBC UK Bank plc are protected up to a total of £85,000.00 by the Financial Services Compensation Scheme (FSCS), the UK deposit guarantee scheme.',
      'For joint accounts the statutory protection limit applies separately to each eligible account holder up to £170,000.00 combined.',
      'Direct Debit Guarantee: This guarantee is offered by all banks and building societies that accept instructions to pay Direct Debits. If there are any changes to the amount, date or frequency of your Direct Debit, the organisation will notify you at least 10 working days in advance.',
      'If an error is made in the payment of your Direct Debit by the organisation or your bank, you are entitled to a full and immediate refund of the amount paid from your branch. You can cancel a Direct Debit at any time by simply contacting your bank or building society.',
      'Please check all entries on your monthly statement carefully. If you notice any unrecognised card purchase, standing order, faster payment, or direct debit entry, contact our fraud and disputes team immediately quoting your 8-digit account number and sort code.',
      'Important information about overdrafts, foreign exchange reference rates, contactless limits (£100.00 per transaction), strong customer authentication, and complaint escalation to the Financial Ombudsman Service (0800 023 4567) applies to this account.',
      'Statements are produced electronically once per calendar month and retained in online banking for 7 years (84 monthly statements) for your tax and personal finance records.',
    ].join('\n');

    const monthDays = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    const buildMonthOcr = (monthIndex: number) => {
      const mm = String(monthIndex + 1).padStart(2, '0');
      const lastDay = String(monthDays[monthIndex]).padStart(2, '0');
      const openBal = (2400 + monthIndex * 183.45).toFixed(2);
      const debit1 = (118.2 + monthIndex * 6.35).toFixed(2);
      const debit2 = (63.4 + monthIndex * 4.15).toFixed(2);
      const closeBal = (2650 + monthIndex * 197.85).toFixed(2);
      return [
        staticHeader,
        `Statement Period: 01/${mm}/2024 to ${lastDay}/${mm}/2024 | Statement Date: ${lastDay}/${mm}/2024`,
        `Opening Balance Brought Forward: £${openBal}`,
        `05/${mm}/2024 Direct Debit Octopus Energy £${debit1}`,
        `18/${mm}/2024 Card Purchase Sainsburys Supermarket £${debit2}`,
        `28/${mm}/2024 Faster Payment Monthly Salary Credit £4,250.00`,
        `Closing Balance Carried Forward: £${closeBal}`,
        staticFeeAndLegalBoilerplate,
      ].join('\n');
    };

    // Use generic titles (no leading YYYY-MM) so content date/amount vetoes must do the work
    const twelveMonths = Array.from({ length: 12 }, (_, m) =>
      makeNote(`bank-2024-${m + 1}`, {
        title: 'HSBC Consolidated Statement',
        notebookTitle: 'Bank Statements',
        notebookPath: 'Finance / Bank Statements / HSBC',
        createdTime: 1_700_000_000_000 + m * 86_400_000 * 30,
        resources: [
          {
            key: `hsbc-2024-${m + 1}`,
            mime: 'application/pdf',
            size: 215_000 + (m % 4) * 1_500,
            ocrText: buildMonthOcr(m),
            filename: `statement_2024_${String(m + 1).padStart(2, '0')}.pdf`,
          },
        ],
      })
    );

    assert.equal(
      detectDuplicateClusters(twelveMonths).length,
      0,
      '12 monthly statements sharing 95% boilerplate and static numbers must yield no near cluster'
    );

    // Add an OCR-noisy rescan of November 2024 (index 10) with a different file size
    const novOcr = buildMonthOcr(10)
      .replace('Prudential Regulation Authority', 'Prudentia1 Regulation Authority')
      .replace('Financial Ombudsman Service', 'Financia1 Ombudsman Service')
      .replace('contactless limits', 'contact1ess limits');
    const novRescan = makeNote('bank-2024-11-rescan', {
      title: 'Scannable Document',
      notebookTitle: 'Pending to sort',
      notebookPath: 'Pending to sort',
      createdTime: 1_735_000_000_000,
      resources: [
        {
          key: 'hsbc-2024-11-rescan',
          mime: 'application/pdf',
          size: 238_000,
          ocrText: novOcr,
          filename: 'scan_nov_stmt.pdf',
        },
      ],
    });

    const withRescan = detectDuplicateClusters([...twelveMonths, novRescan]);
    assert.equal(withRescan.length, 1, 'rescan of November statement should match only November');
    assert.equal(withRescan[0].tier, 'near');
    assert.equal(withRescan[0].suggestedKeeperId, twelveMonths[10].note.id);
    assert.deepEqual(withRescan[0].noteIds, [twelveMonths[10].note.id, novRescan.note.id]);
    assert.match(withRescan[0].evidence, /% same text/);
    assert.match(withRescan[0].evidence, /same dates\/amounts/);
  });

  test('does not match template letters differing only in letter date and reference number', () => {
    const buildLetter = (dateText: string, refNo: string) =>
      [
        'BARCLAYCARD CUSTOMER SERVICES',
        'PO Box 5592, Northampton, NN4 1ZY | Helpline: 0800 151 0900 | Minicom: 0800 161 5300',
        `Date: ${dateText}`,
        `Application Reference: ${refNo}`,
        'Dear Customer,',
        'Thank you for submitting your recent Barclaycard Platinum Credit Card application online.',
        'We have received your supporting identity and income verification documents and our underwriting team is reviewing your application.',
        'Key Summary Box (Static Product Terms): Annual Card Fee £0.00 | Cash Advance Fee £3.00 minimum | Late Payment Fee £12.00 | Overlimit Fee £12.00 | Returned Payment Fee £12.00 | Representative Credit Limit £1,200.00 | Representative APR 24.90% variable.',
        'You do not need to take any further action right now. We normally complete our review within 5 working days and will write to confirm our decision and your starting credit limit.',
        'If you have any questions regarding your application, please quote your application reference number when contacting our UK customer service team between 08:00 and 20:00 Monday to Friday.',
        'Yours sincerely, Barclaycard New Accounts & Underwriting Team.',
      ].join('\n');

    const letter2020 = makeNote('cc-ack-2020', {
      title: 'Barclaycard Application Acknowledgement',
      notebookTitle: 'Credit Cards',
      createdTime: 1_606_608_000_000,
      resources: [
        {
          key: 'cc-2020',
          mime: 'application/pdf',
          size: 142_000,
          ocrText: buildLetter('29 November 2020', 'BC-2020-881203'),
        },
      ],
    });
    const letter2023a = makeNote('cc-ack-2023a', {
      title: 'Barclaycard Application Acknowledgement',
      notebookTitle: 'Credit Cards',
      createdTime: 1_673_654_400_000,
      resources: [
        {
          key: 'cc-2023a',
          mime: 'application/pdf',
          size: 144_200,
          ocrText: buildLetter('14 January 2023', 'BC-2023-442910'),
        },
      ],
    });
    const letter2023b = makeNote('cc-ack-2023b', {
      title: 'Barclaycard Application Acknowledgement',
      notebookTitle: 'Credit Cards',
      createdTime: 1_701_475_200_000,
      resources: [
        {
          key: 'cc-2023b',
          mime: 'application/pdf',
          size: 143_100,
          ocrText: buildLetter('02 December 2023', 'BC-2023-991042'),
        },
      ],
    });

    assert.equal(
      detectDuplicateClusters([letter2020, letter2023a, letter2023b]).length,
      0,
      'template letters from different dates must not be grouped as near duplicates'
    );

    // Rescan of the 2023-01-14 letter with minor OCR noise still matches that exact letter
    const letter2023aRescan = makeNote('cc-ack-2023a-rescan', {
      title: 'Scan 0041',
      notebookTitle: 'Pending to sort',
      createdTime: 1_673_740_800_000,
      resources: [
        {
          key: 'cc-2023a-rescan',
          mime: 'application/pdf',
          size: 151_000,
          ocrText: buildLetter('14 January 2023', 'BC-2023-442910').replace('underwriting', 'underwrit1ng'),
        },
      ],
    });

    const clusters = detectDuplicateClusters([letter2020, letter2023a, letter2023b, letter2023aRescan]);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].tier, 'near');
    assert.deepEqual(clusters[0].noteIds, [letter2023a.note.id, letter2023aRescan.note.id]);
    assert.match(clusters[0].evidence, /same dates\/amounts/);
  });

  test('extractNormalizedDates parses all supported date formats, handles DD/MM vs MM/DD consistently, and streams across chunk boundaries', () => {
    const singleDateSamples: Array<[string, string[]]> = [
      ['ISO hyphen 2024-11-30 end', ['2024-11-30']],
      ['ISO slash 2024/11/30 end', ['2024-11-30']],
      ['ISO dot 2024.11.30 end', ['2024-11-30']],
      ['CJK 2024年11月30日 end', ['2024-11-30']],
      ['Fullwidth CJK ２０２４年１１月３０日 end', ['2024-11-30']],
      ['DMY slash 30/11/2024 end', ['2024-11-30']],
      ['DMY hyphen 30-11-2024 end', ['2024-11-30']],
      ['MDY slash 11/30/2024 end', ['2024-11-30']],
      ['Short month DMY 30 Nov 2024 end', ['2024-11-30']],
      ['Long month comma DMY 30 November, 2024 end', ['2024-11-30']],
      ['Short month MDY Nov 30, 2024 end', ['2024-11-30']],
      ['Long month MDY November 30 2024 end', ['2024-11-30']],
      ['Ordinal month 30th Nov. 2024 and Sept 5th, 2024', ['2024-09-05', '2024-11-30']],
      ['Ambiguous numeric 05/06/2024 emits both valid readings', ['2024-05-06', '2024-06-05']],
      ['Symmetric numeric 06/06/2024 emits once', ['2024-06-06']],
      ['Leap day 29/02/2024 valid, non-leap 29/02/2023 and 31/04/2024 ignored', ['2024-02-29']],
    ];

    for (const [sample, expected] of singleDateSamples) {
      assert.deepEqual(
        extractNormalizedDates(sample),
        expected,
        `unexpected extracted dates for ${JSON.stringify(sample)}`
      );
    }

    // Multi-word date straddling the 16,384-char streaming chunk boundary must still be extracted
    const pad = 'boiler '.repeat(2340); // 16,380 chars — "30 November, 2024" straddles the 16,384 boundary
    const straddling = `${pad}30 November, 2024 and tail text`;
    assert.deepEqual(extractNormalizedDates(straddling), ['2024-11-30']);

    // Capped at 200 unique dates even when a huge text contains > 250 distinct dates
    const manyDates = Array.from({ length: 260 }, (_, idx) => {
      const year = 2000 + Math.floor(idx / 12);
      const month = String((idx % 12) + 1).padStart(2, '0');
      return `${year}-${month}-15`;
    }).join(' ');
    assert.equal(extractNormalizedDates(manyDates).length, 200);
  });

  test('amount veto rejects undated notes with >= 3 differing money amounts and streams past the 16 KB prefix', () => {
    const sharedTail = Array.from({ length: 40 }, (_, i) => `clause${i} provision terms schedule standard`).join(' ');
    const amtA = makeNote('amt-veto-a', {
      title: 'Account Summary',
      body: `Summary figures: opening £1,120.50, debit £45.80, transfer £310.25, closing £1,476.55. ${sharedTail}`,
    });
    const amtB = makeNote('amt-veto-b', {
      title: 'Account Summary',
      body: `Summary figures: opening £2,340.10, debit £89.40, transfer £612.75, closing £2,863.45. ${sharedTail}`,
    });
    assert.equal(detectDuplicateClusters([amtA, amtB]).length, 0, 'differing >= 3 amounts must veto near match');

    // Dates or amounts appearing ONLY past the 16 KB near-duplicate prefix must still veto
    const longPrefix = Array.from({ length: 1_500 }, (_, i) => `boilerplate${i % 250} paragraph`).join(' ');
    assert.ok(longPrefix.length > 20_000, 'prefix fixture should exceed 16 KB');

    const tailDateA = makeNote('tail-date-a', {
      title: 'Annual Filing',
      resources: [{ key: 'td-a', size: 220_000, ocrText: `${longPrefix} Signed and filed on 15 March 2023.` }],
    });
    const tailDateB = makeNote('tail-date-b', {
      title: 'Annual Filing',
      resources: [{ key: 'td-b', size: 222_000, ocrText: `${longPrefix} Signed and filed on 19 April 2024.` }],
    });
    assert.equal(
      detectDuplicateClusters([tailDateA, tailDateB]).length,
      0,
      'full-text date veto must catch differing dates past the 16 KB prefix'
    );

    const tailAmtA = makeNote('tail-amt-a', {
      title: 'Ledger Export',
      resources: [
        {
          key: 'ta-a',
          size: 220_000,
          ocrText: `${longPrefix} Totals: £110.25, £220.50, £330.75, £661.50.`,
        },
      ],
    });
    const tailAmtB = makeNote('tail-amt-b', {
      title: 'Ledger Export',
      resources: [
        {
          key: 'ta-b',
          size: 222_000,
          ocrText: `${longPrefix} Totals: £410.15, £520.40, £630.85, £1,561.40.`,
        },
      ],
    });
    assert.equal(
      detectDuplicateClusters([tailAmtA, tailAmtB]).length,
      0,
      'full-text amount veto must catch differing amounts past the 16 KB prefix'
    );
  });

  test('title-date veto blocks conflicting leading title dates while allowing compatible prefixes and non-date titles', () => {
    assert.equal(extractLeadingTitleDate('2023-02-04 Broker Statement'), '2023-02-04');
    assert.equal(extractLeadingTitleDate('2023-02 Broker Statement'), '2023-02');
    assert.equal(extractLeadingTitleDate('2023-02-31 Invalid Date'), '');
    assert.equal(extractLeadingTitleDate('Scan 2023-02-04'), '');

    assert.equal(titleDatesConflict('2023-02-04', '2023-02'), false);
    assert.equal(titleDatesConflict('2023-02', '2023-02-04'), false);
    assert.equal(titleDatesConflict('2023-02-04', '2023-02-04'), false);
    assert.equal(titleDatesConflict('2023-02-04', ''), false);
    assert.equal(titleDatesConflict('2022-10-11', '2022-11-10'), true);
    assert.equal(titleDatesConflict('2023-02', '2023-03'), true);
    assert.equal(titleDatesConflict('2023-02-04', '2023-02-05'), true);

    const bodyBase =
      'Brokerage portfolio confirmation covering equity holdings, custody disclosures, regulatory notices, dividend reinvestment elections, and account maintenance terms.';
    const bodyNoisy = bodyBase.replace('reinvestment', 're1nvestment');

    // Conflicting leading YYYY-MM-DD titles -> vetoed
    const conflictA = makeNote('td-conf-a', { title: '2022-10-11 Broker Statement', body: bodyBase, createdTime: 1000 });
    const conflictB = makeNote('td-conf-b', { title: '2022-11-10 Broker Statement', body: bodyNoisy, createdTime: 2000 });
    assert.equal(detectDuplicateClusters([conflictA, conflictB]).length, 0);

    // Compatible prefix (YYYY-MM-DD vs YYYY-MM) -> allowed
    const compatA = makeNote('td-compat-a', { title: '2023-02-04 Broker Statement', body: bodyBase, createdTime: 1000 });
    const compatB = makeNote('td-compat-b', { title: '2023-02 Broker Statement', body: bodyNoisy, createdTime: 2000 });
    const compatClusters = detectDuplicateClusters([compatA, compatB]);
    assert.equal(compatClusters.length, 1);
    assert.equal(compatClusters[0].tier, 'near');

    // Only one title starts with a date -> allowed
    const oneDateA = makeNote('td-one-a', { title: '2023-02-04 Broker Statement', body: bodyBase, createdTime: 1000 });
    const oneDateB = makeNote('td-one-b', { title: 'Scannable Document', body: bodyNoisy, createdTime: 2000 });
    assert.equal(detectDuplicateClusters([oneDateA, oneDateB]).length, 1);

    // Identical tier is unaffected by leading title dates (exact same content is still identical)
    const identA = makeNote('td-ident-a', { title: '2022-10-11 Copy', body: bodyBase, createdTime: 1000 });
    const identB = makeNote('td-ident-b', { title: '2022-11-10 Copy', body: bodyBase, createdTime: 2000 });
    const identClusters = detectDuplicateClusters([identA, identB]);
    assert.equal(identClusters.length, 1);
    assert.equal(identClusters[0].tier, 'identical');
  });

  test('near-duplicate evidence only says "same dates/amounts" when full-text dates and amounts actually agree', () => {
    // 1. Prose notes with integer numbers (ports/steps) but NO full dates or money amounts
    const proseA = makeNote('ev-prose-a', {
      title: 'Runbook A',
      body: 'Deployment runbook step 1 verify port 8080, step 2 drain worker queue, step 3 run schema migration, step 4 verify health endpoint responds cleanly.',
      createdTime: 1000,
    });
    const proseB = makeNote('ev-prose-b', {
      title: 'Runbook B',
      body: 'Deployment runbook step 1 verify port 8080, step 2 drain worker queue, step 3 run schema migration, step 4 verify health endpoint responds reliably.',
      createdTime: 2000,
    });
    const proseClusters = detectDuplicateClusters([proseA, proseB]);
    assert.equal(proseClusters.length, 1);
    assert.equal(proseClusters[0].tier, 'near');
    assert.match(proseClusters[0].evidence, /% same text/);
    assert.doesNotMatch(proseClusters[0].evidence, /same dates\/amounts/);

    // 2. Notes with matching date and 2 amounts where 1 amount differs (below 3-amount veto, so still near,
    //    but evidence must NOT claim "same dates/amounts")
    const partialShared = Array.from({ length: 30 }, (_, i) => `policyclause${i}`).join(' ');
    const partialA = makeNote('ev-partial-a', {
      title: 'Quote A',
      body: `Insurance quote issued 15 October 2024 with static codes 101 202 303 404 505 606 707 808 909. Base £100.00, fee £20.00. ${partialShared}`,
      createdTime: 1000,
    });
    const partialB = makeNote('ev-partial-b', {
      title: 'Quote B',
      body: `Insurance quote issued 15 October 2024 with static codes 101 202 303 404 505 606 707 808 909. Base £100.00, fee £25.00. ${partialShared}`,
      createdTime: 2000,
    });
    const partialClusters = detectDuplicateClusters([partialA, partialB]);
    assert.equal(partialClusters.length, 1);
    assert.equal(partialClusters[0].tier, 'near');
    assert.match(partialClusters[0].evidence, /% same text/);
    assert.doesNotMatch(partialClusters[0].evidence, /same dates\/amounts/);
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

  test('countWordsInNormalized matches tokenizeWords across ASCII, contractions, Latin, and CJK', () => {
    const samples = [
      '',
      '   ',
      'hello world',
      "don't stop believing in o'clock 2024's can't've",
      'foo\'\'bar -- baz!! £1,234.56 (test)',
      'café résumé naïve l’école über',
      '混合English與中文123測試',
      '日本語のテストとabc_def',
      'a\'b c’d \'leading\' trailing\'',
    ];
    for (const raw of samples) {
      const norm = normalizeContentText(raw);
      assert.equal(
        countWordsInNormalized(norm),
        tokenizeWords(norm).length,
        `word count mismatch for ${JSON.stringify(raw)}`
      );
    }
  });

  test('identical tier hashes the full text even past the near-duplicate prefix cap', () => {
    // 100k chars shared prefix (well beyond 40k near-prefix cap), differing only near the end
    const sharedHead = Array.from({ length: 12_000 }, (_, i) => `section${i % 300}word${i}`).join(' ');
    const tailA = ' final audit conclusion approved ref alpha 9001.';
    const tailB = ' final audit conclusion rejected ref beta 9002.';

    const a = makeNote('long-diff-a', {
      title: 'Long Doc A',
      createdTime: 1000,
      resources: [{ key: 'ld-a', size: 800_000, ocrText: sharedHead + tailA }],
    });
    const b = makeNote('long-diff-b', {
      title: 'Long Doc B',
      createdTime: 2000,
      resources: [{ key: 'ld-b', size: 800_000, ocrText: sharedHead + tailB }],
    });

    const clusters = detectDuplicateClusters([a, b]);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].tier, 'near', 'notes differing past the prefix must not be marked identical');
  });

  test('detects identical and near duplicates with multiple OCR attachments regardless of link order', () => {
    const ocr1 = 'First scanned page of insurance policy number POL-778899 valid from 10 May 2024 covering residential property.';
    const ocr2 = 'Second scanned page listing schedule of endorsements, excess £250.00, and emergency claims hotline.';

    const a = makeNote('multi-ocr-a', {
      title: 'Policy A',
      notebookTitle: 'Insurance',
      createdTime: 1000,
      resources: [
        { key: 'm-a1', size: 100_000, ocrText: ocr1 },
        { key: 'm-a2', size: 120_000, ocrText: ocr2 },
      ],
    });
    const b = makeNote('multi-ocr-b', {
      title: 'Policy B',
      notebookTitle: 'Inbox',
      createdTime: 2000,
      resources: [
        { key: 'm-b2', size: 120_000, ocrText: ocr2 },
        { key: 'm-b1', size: 100_000, ocrText: ocr1 },
      ],
    });

    const clusters = detectDuplicateClusters([a, b]);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].tier, 'identical');
    assert.equal(clusters[0].suggestedKeeperId, a.note.id);
  });

  test('stays under 120 MB delta and 3 s on a realistic 12k-note corpus inside --max-old-space-size=1024', () => {
    const workerPath = fileURLToPath(new URL('./duplicates-memory-worker.ts', import.meta.url));
    const tsxImport = import.meta.resolve('tsx');
    const run = spawnSync(
      process.execPath,
      ['--max-old-space-size=1024', '--expose-gc', '--import', tsxImport, workerPath],
      {
        encoding: 'utf8',
        timeout: 60_000,
      }
    );

    assert.equal(
      run.status,
      0,
      `memory worker failed (status=${run.status}, signal=${run.signal})\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`
    );

    const lastLine = run.stdout.trim().split('\n').pop() ?? '';
    const metrics = JSON.parse(lastLine) as {
      noteCount: number;
      totalTextMB: number;
      buildMs: number;
      detectMs: number;
      baselineHeapUsedMB: number;
      afterHeapUsedMB: number;
      heapUsedDeltaMB: number;
      arrayBuffersDeltaMB: number;
      combinedDeltaMB: number;
      postGcHeapDeltaMB: number;
      rssDeltaMB: number;
      identicalFound: number;
      identicalExpected: number;
      nearFound: number;
      nearExpected: number;
    };

    console.log(
      `[MemPerf] ${metrics.noteCount} notes (${metrics.totalTextMB} MB text): ` +
        `${metrics.detectMs} ms | baseline ${metrics.baselineHeapUsedMB} MB | ` +
        `heapDelta ${metrics.heapUsedDeltaMB} MB | abDelta ${metrics.arrayBuffersDeltaMB} MB | ` +
        `combinedDelta ${metrics.combinedDeltaMB} MB | postGcDelta ${metrics.postGcHeapDeltaMB} MB | ` +
        `found ${metrics.identicalFound}/${metrics.identicalExpected} identical, ` +
        `${metrics.nearFound}/${metrics.nearExpected} near`
    );

    assert.equal(metrics.identicalFound, metrics.identicalExpected);
    assert.equal(metrics.nearFound, metrics.nearExpected);
    assert.ok(
      metrics.heapUsedDeltaMB < 120,
      `expected heapUsed delta < 120 MB, got ${metrics.heapUsedDeltaMB} MB`
    );
    assert.ok(
      metrics.combinedDeltaMB < 120,
      `expected combined (heapUsed + arrayBuffers) delta < 120 MB, got ${metrics.combinedDeltaMB} MB`
    );
    assert.ok(
      metrics.detectMs < 3000,
      `expected detection duration < 3000 ms, took ${metrics.detectMs} ms`
    );
  });
});
