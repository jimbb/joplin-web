import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildOcrSnippet,
  buildRawOcrSnippet,
  compileSearchTerm,
  extractLinkedResourceIds,
  isEmptySearchQuery,
  matchesDateFilters,
  matchesNamePattern,
  normalizeOcrText,
  parseSearchQuery,
} from '../src/services/search-query.js';

/**
 * Offline tests for the search query parser.
 */

describe('parseSearchQuery', () => {
  test('splits words and lower-cases them', () => {
    const q = parseSearchQuery('  Shopping   LIST ');
    assert.deepEqual(q.terms, ['shopping', 'list']);
    assert.deepEqual(q.excludedTerms, []);
  });

  test('keeps quoted phrases together and normalises their whitespace', () => {
    assert.deepEqual(parseSearchQuery('"shopping  list" milk').terms, ['shopping list', 'milk']);
  });

  test('an unclosed quote runs to the end of the query', () => {
    assert.deepEqual(parseSearchQuery('milk "shopping list').terms, ['milk', 'shopping list']);
  });

  test('negated words and phrases', () => {
    const q = parseSearchQuery('milk -bread -"sour dough"');
    assert.deepEqual(q.terms, ['milk']);
    assert.deepEqual(q.excludedTerms, ['bread', 'sour dough']);
  });

  test('a lone dash and empty quotes are ignored; hyphenated words stay words', () => {
    assert.deepEqual(parseSearchQuery('a - b ""').terms, ['a', 'b']);
    assert.deepEqual(parseSearchQuery('e-mail').terms, ['e-mail']);
  });

  test('tag and notebook filters, with quoted values and case-insensitive names', () => {
    const q = parseSearchQuery('TAG:Work tag:"Two  Words" Notebook:"Reading List" -notebook:Archive -tag:old');
    assert.deepEqual(q.tags, ['work', 'two words']);
    assert.deepEqual(q.excludedTags, ['old']);
    assert.deepEqual(q.notebooks, ['reading list']);
    assert.deepEqual(q.excludedNotebooks, ['archive']);
    assert.deepEqual(q.terms, []);
  });

  test('type and iscompleted filters', () => {
    assert.equal(parseSearchQuery('type:todo').type, 'todo');
    assert.equal(parseSearchQuery('type:NOTE').type, 'note');
    assert.equal(parseSearchQuery('iscompleted:1').completed, true);
    assert.equal(parseSearchQuery('iscompleted:0').completed, false);
  });

  test('invalid filter values and unknown filters are plain words', () => {
    const q = parseSearchQuery('type:x iscompleted:yes foo:bar https://example.com tag:');
    assert.equal(q.type, undefined);
    assert.equal(q.completed, undefined);
    assert.deepEqual(q.terms, ['type:x', 'iscompleted:yes', 'foo:bar', 'https://example.com', 'tag:']);
  });

  test('a query of only filters is not empty; whitespace is', () => {
    assert.equal(isEmptySearchQuery(parseSearchQuery('tag:work')), false);
    assert.equal(isEmptySearchQuery(parseSearchQuery('iscompleted:0')), false);
    assert.equal(isEmptySearchQuery(parseSearchQuery('   ')), true);
    assert.equal(isEmptySearchQuery(parseSearchQuery('"" -')), true);
  });
});

describe('matchesNamePattern', () => {
  test('matches whole names case-insensitively', () => {
    assert.equal(matchesNamePattern('Reading List', 'reading list'), true);
    assert.equal(matchesNamePattern('Reading List', 'reading'), false);
  });

  test('supports * wildcards and escapes regex characters', () => {
    assert.equal(matchesNamePattern('Project Alpha', 'project*'), true);
    assert.equal(matchesNamePattern('a.b', 'a.b'), true);
    assert.equal(matchesNamePattern('axb', 'a.b'), false);
    assert.equal(matchesNamePattern('C++ (notes)', 'c++*'), true);
    assert.equal(matchesNamePattern('afoobbarc', 'a***b*c'), true);
    assert.equal(matchesNamePattern('abc', '*abc*'), true);
    assert.equal(matchesNamePattern('ab', 'abc*'), false);
  });

  test('handles repeated wildcards and long segments on mismatched titles in linear time (no ReDoS)', () => {
    const startedAt = performance.now();
    assert.equal(matchesNamePattern(`${'a'.repeat(500)}c`, `${'a*'.repeat(60)}b`), false);
    assert.equal(matchesNamePattern(`${'a'.repeat(40_000)}c`, `*${'a'.repeat(20_000)}b`), false);
    assert.equal(matchesNamePattern(`${'a'.repeat(40_000)}c`, `*${'a'.repeat(20_000)}b*`), false);
    const parsed = parseSearchQuery('a '.repeat(20_000));
    assert.equal(parsed.terms.length, 20_000);
    const elapsedMs = performance.now() - startedAt;
    assert.ok(elapsedMs < 300, `Expected linear wildcard/query matching, took ${elapsedMs.toFixed(1)}ms`);
  });
});

describe('extractLinkedResourceIds', () => {
  const idA = '0123456789abcdef0123456789abcdef';
  const idB = 'fedcba9876543210fedcba9876543210';

  test('extracts unique ids in link order from Markdown and HTML', () => {
    const body = [
      `See [scan](:/${idA.toUpperCase()} "Scan") and <img src=":/${idB}" alt="Receipt">.`,
      `Repeated [again](:/${idA}#page=2) and <a href=':/${idB}'>link</a>.`,
    ].join('\n');
    assert.deepEqual(extractLinkedResourceIds(body), [idA, idB]);
  });

  test('ignores malformed ids, longer hex strings and regular URLs', () => {
    const body = `https://example.com/${idA} :/${idA}f :/short [x](:/${idB})`;
    assert.deepEqual(extractLinkedResourceIds(body), [idB]);
    assert.deepEqual(extractLinkedResourceIds('Plain note without resource links'), []);
  });
});

describe('OCR normalization and snippets', () => {
  test('collapses wrapped lines into single spaces', () => {
    assert.equal(normalizeOcrText('  ACME\r\n  Hardware\n\n  Total:   $42.00 \n'), 'ACME Hardware Total: $42.00');
  });

  test('cuts a clean snippet around the earliest match and snaps word boundaries', () => {
    const text = `${'prefixword '.repeat(12)}Dedicated Backup Storage Renewal ${'suffixword '.repeat(12)}`;
    const snippet = buildOcrSnippet(normalizeOcrText(text), ['renewal', 'backup']);
    assert.ok(snippet);
    assert.ok(snippet.startsWith('...'));
    assert.ok(snippet.endsWith('...'));
    assert.ok(snippet.includes('Backup Storage Renewal'));
    assert.equal(buildOcrSnippet('Nothing here', ['invoice']), null);
  });

  test('tag:none, has:attachment, has:ocr, sourceurl, created and updated filters', () => {
    const fixedNow = Date.UTC(2026, 4, 15, 12, 0, 0);
    const q = parseSearchQuery(
      'tag:none has:attachment -has:ocr sourceurl:github.com -sourceurl:gist.github.com created:>=2026-01-01 updated:today',
      fixedNow
    );
    assert.equal(q.tagNone, true);
    assert.equal(q.hasAttachment, true);
    assert.equal(q.hasOcr, false);
    assert.deepEqual(q.sourceUrls, ['github.com']);
    assert.deepEqual(q.excludedSourceUrls, ['gist.github.com']);
    assert.equal(q.createdFilters.length, 1);
    assert.equal(q.updatedFilters.length, 1);
    assert.equal(isEmptySearchQuery(q), false);

    assert.equal(matchesDateFilters(Date.UTC(2026, 4, 15, 9, 0, 0), q.updatedFilters), true);
    assert.equal(matchesDateFilters(Date.UTC(2026, 4, 14, 9, 0, 0), q.updatedFilters), false);
    assert.equal(matchesDateFilters(Date.UTC(2026, 2, 1, 0, 0, 0), q.createdFilters), true);
    assert.equal(matchesDateFilters(Date.UTC(2025, 11, 31, 23, 59, 59), q.createdFilters), false);
  });

  test('negated tag:none and week/month date specs', () => {
    const fixedNow = Date.UTC(2026, 4, 15, 12, 0, 0);
    const q = parseSearchQuery('-tag:none created:week-1 -updated:2026-04', fixedNow);
    assert.equal(q.tagNone, false);
    assert.equal(q.createdFilters.length, 1);
    assert.equal(q.updatedFilters.length, 1);
    assert.equal(q.updatedFilters[0].negated, true);
    assert.equal(matchesDateFilters(Date.UTC(2026, 4, 10, 0, 0, 0), q.createdFilters), true);
    assert.equal(matchesDateFilters(Date.UTC(2026, 3, 15, 0, 0, 0), q.updatedFilters), false);
    assert.equal(matchesDateFilters(Date.UTC(2026, 4, 15, 0, 0, 0), q.updatedFilters), true);
  });
});

describe('compileSearchTerm', () => {
  test('matches ASCII, Unicode and regex metacharacters case-insensitively', () => {
    const plain = compileSearchTerm('c++ ($42.00)');
    assert.equal(plain.text.test('Total for C++ ($42.00) today'), true);
    assert.equal(plain.text.test('Total for Cxx ($42a00) today'), false);
    assert.equal(plain.text.test('C++\n($42.00)'), false, 'literal text matcher keeps spaces literal');
    assert.equal(plain.ocr.test('C++\r\n\t ($42.00)'), true, 'OCR matcher collapses whitespace runs');

    const unicode = compileSearchTerm('café 結單');
    assert.equal(unicode.text.test('CAFÉ 結單'), true);
    assert.equal(unicode.ocr.test('CAFÉ\n  結單'), true);

    const single = compileSearchTerm('invoice');
    assert.equal(single.text, single.ocr);
    assert.equal(single.text.test('INVOICE'), true);
  });
});

describe('buildRawOcrSnippet', () => {
  test('matches buildOcrSnippet(normalizeOcrText(ocr), terms) across whitespace and boundary edge cases', () => {
    const cases: Array<{ name: string; raw: string; terms: string[] }> = [
      {
        name: 'leading and trailing whitespace with match at start',
        raw: '   \r\n\t  Invoice #1042 for Harborview Hardware\t\n  ',
        terms: ['invoice'],
      },
      {
        name: 'match at position 0 of long text',
        raw: `Statement ${'word '.repeat(30)}tail`,
        terms: ['statement'],
      },
      {
        name: 'match at very end of long text with trailing CRLF',
        raw: `${'prefix '.repeat(25)}Final Balance\r\n  \t `,
        terms: ['balance'],
      },
      {
        name: 'phrase wrapped across CRLF, tabs and blank lines',
        raw: `${'alpha beta '.repeat(12)}Account\r\n\t\n   Balance\n\n$1,234.56 ${'gamma delta '.repeat(12)}`,
        terms: ['account balance'],
      },
      {
        name: 'earliest term wins and first term wins ties',
        raw: `${'intro '.repeat(15)}Account Balance Summary ${'outro '.repeat(15)}`,
        terms: ['account', 'account balance', 'summary'],
      },
      {
        name: 'exact 60-char and 61-char boundaries before and after match',
        raw: `${'a'.repeat(60)}KEY${'b'.repeat(60)}`,
        terms: ['key'],
      },
      {
        name: '61-char boundaries without spaces (no word snap possible)',
        raw: `${'a'.repeat(61)}KEY${'b'.repeat(61)}`,
        terms: ['key'],
      },
      {
        name: 'space right at -61 and +60 boundary does not snap inward',
        raw: `head ${'a'.repeat(60)}KEY${'b'.repeat(60)} tail`,
        terms: ['key'],
      },
      {
        name: 'space immediately adjacent to match snaps to word boundary',
        raw: `${'x'.repeat(80)} KEY ${'y'.repeat(80)}`,
        terms: ['key'],
      },
      {
        name: 'huge whitespace runs before and after match',
        raw: `earlier words ${' \r\n\t'.repeat(1200)}Target Phrase${' \n\t'.repeat(1200)} later words`,
        terms: ['target phrase'],
      },
      {
        name: 'CJK and regex metacharacters with NBSP',
        raw: `${'備註 '.repeat(30)}月結單\u00A0$42.00 (HKD)${' 項目'.repeat(30)}`,
        terms: ['月結單 $42.00 (hkd)'],
      },
      {
        name: 'no match returns null',
        raw: '   ACME\r\nHardware   ',
        terms: ['missing'],
      },
      {
        name: 'empty text or empty terms returns null',
        raw: '',
        terms: ['invoice'],
      },
    ];

    for (const c of cases) {
      const expected = buildOcrSnippet(normalizeOcrText(c.raw), c.terms);
      const actual = buildRawOcrSnippet(
        c.raw,
        c.terms.map((t) => compileSearchTerm(t))
      );
      assert.equal(actual, expected, `mismatch in case: ${c.name}`);
    }
  });
});
