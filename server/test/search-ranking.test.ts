import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { buildDemoItems, demoId } from '../demo/seed.js';
import { JoplinItemType } from '../src/types/index.js';
import { putMockItem, startTestApp, type TestApp } from './helpers.js';

/**
 * Search ranking: where a term matched (title, body, attachment OCR), whole words over parts of
 * longer words, then how often a note mentions the terms for its length, then the newest.
 * Every note uses made-up words so the demo seed never matches.
 */

const HOUR = 60 * 60 * 1000;
const NOW = Date.now();
const id = (key: string) => demoId(`rank-${key}`);

let app: TestApp;

before(async () => {
  const items = buildDemoItems(NOW);
  const put = (item: Parameters<typeof putMockItem>[1]) =>
    putMockItem({ items, recordChange: () => undefined } as unknown as Parameters<typeof putMockItem>[0], item);
  const note = (key: string, title: string, body: string, hoursAgo: number) =>
    put({
      type_: JoplinItemType.Note,
      id: id(key),
      title,
      body,
      parentId: demoId('nb-work'),
      createdTime: NOW - hoursAgo * HOUR,
      updatedTime: NOW - hoursAgo * HOUR,
      properties: { deleted_time: '0', encryption_applied: '0', is_todo: '0' },
    });
  const scan = (key: string, ocrText: string, hoursAgo: number) => {
    put({
      type_: JoplinItemType.Resource,
      id: id(`res-${key}`),
      title: `${key}.pdf`,
      createdTime: NOW - hoursAgo * HOUR,
      updatedTime: NOW - hoursAgo * HOUR,
      properties: { mime: 'application/pdf', filename: `${key}.pdf`, size: '256', encryption_applied: '0', ocr_status: '2', ocr_text: ocrText },
    });
    note(key, `2024_0${hoursAgo}_01.pdf`, `[${key}.pdf](:/${id(`res-${key}`)})`, hoursAgo);
  };

  // A whole word in the title beats the same letters inside a longer title word, even when newer
  note('word-old', 'Qorvex invoice', 'Paid in full.', 9);
  note('word-new', 'Qorvexia invoice', 'Paid in full.', 1);
  // Part of a title word still beats a whole word in the body
  note('title-part', 'Bluquillx archive', 'Nothing here.', 8);
  note('body-word', 'Unrelated', 'The bluquill was delivered.', 1);
  // Among scans, the statement that mentions the word most comes first, even when older
  scan('many', 'Zentrova Bank statement\nZentrova account 123\nZentrova balance\nZentrova interest\nZentrova fees', 7);
  scan('once', 'Payment by card\nIssuer: Zentrova\nAmount 12.00 for groceries and more items here', 2);
  // The same single mention counts for more in a short note than in a long one
  note('short', 'Memo', 'Call Varnhold about the lease.', 6);
  note('long', 'Minutes', `Call Varnhold about the lease. ${'Agenda item discussed at length. '.repeat(150)}`, 3);
  // Notes that match the same way fall back to the newest first
  note('same-old', 'Plimsoll checklist', 'Plimsoll checklist', 5);
  note('same-new', 'Plimsoll checklist', 'Plimsoll checklist', 4);

  app = await startTestApp({ items });
  await app.login();
});

after(async () => {
  await app.close();
});

const ranking = async (q: string) =>
  ((await app.api(`/api/search?q=${encodeURIComponent(q)}`)).data as Array<{ id: string }>).map((n) => n.id);

describe('search ranking', () => {
  test('ranks a whole word above the same letters inside a longer word', async () => {
    assert.deepEqual(await ranking('qorvex'), [id('word-old'), id('word-new')]);
  });

  test('keeps title matches above body matches, even when only part of a title word matches', async () => {
    assert.deepEqual(await ranking('bluquill'), [id('title-part'), id('body-word')]);
  });

  test('orders scans matched in their OCR text by how often they mention the word', async () => {
    assert.deepEqual(await ranking('zentrova'), [id('many'), id('once')]);
  });

  test('favours the shorter note when both mention the word equally often', async () => {
    assert.deepEqual(await ranking('varnhold'), [id('short'), id('long')]);
  });

  test('falls back to the newest first for notes that match the same way', async () => {
    assert.deepEqual(await ranking('plimsoll checklist'), [id('same-new'), id('same-old')]);
  });
});
