import assert from 'node:assert/strict';
import test from 'node:test';

process.env.JOPLIN_SERVER_URL ??= 'http://127.0.0.1:1';

const { ScanStatusService } = await import('../src/services/scan-status.js');

const id = '0123456789abcdef0123456789abcdef';
const timestamp = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

test('normalizes active queue, stalled stages, ids, and recent retention', async () => {
  const jobs = Array.from({ length: 12 }, (_, index) => ({
    id: `done-${index}`,
    name: `done-${index}.pdf`,
    size: 10,
    stage: 'done',
    receivedAt: timestamp(index + 2),
    updatedAt: timestamp(index + 1),
    doneAt: timestamp(index + 1),
    noteId: index === 0 ? id : 'bad-id',
  }));
  const service = new ScanStatusService({
    ocrServiceUrl: 'http://bridge.test',
    scanStatusEmails: ['owner@example.com'],
    source: async () => ({
      ok: true,
      cycle: { phase: 'ocr', running: false, ocrTotal: 3, ocrDone: 1 },
      jobs: [
        {
          id: 'queued-1', name: 'one.pdf', size: 1, stage: 'queued', receivedAt: timestamp(20), updatedAt: timestamp(19),
        },
        {
          id: 'queued-2', name: 'two.pdf', size: 2, stage: 'queued', receivedAt: timestamp(10), updatedAt: timestamp(9),
        },
        {
          id: 'ocr-1', name: 'three.pdf', size: 3, stage: 'ocr', receivedAt: timestamp(30), updatedAt: timestamp(29), noteId: id,
        },
        { id: 'bad stage', name: 'drop', stage: 'unknown', receivedAt: timestamp(1) },
        ...jobs,
      ],
    }),
  });

  const result = await service.getStatus('OWNER@example.com');
  assert.equal(result.enabled, true);
  assert.equal(result.available, true);
  assert.equal(result.active, 3);
  assert.deepEqual(result.jobs?.map((job) => job.id), ['ocr-1', 'queued-1', 'queued-2']);
  assert.equal(result.jobs?.[0].stalled, true);
  assert.equal(result.jobs?.[1].queuePosition, 1);
  assert.equal(result.jobs?.[2].queuePosition, 2);
  assert.equal(result.jobs?.[0].noteId, id);
  assert.equal(result.recent?.length, 10);
  assert.equal(result.recent?.[0].noteId, id);
});

test('returns disabled, fake, and unavailable states', async () => {
  const disabled = new ScanStatusService({ ocrServiceUrl: 'http://bridge.test', scanStatusEmails: ['owner@example.com'] });
  assert.deepEqual(await disabled.getStatus('other@example.com'), { enabled: false });

  const fake = new ScanStatusService({ scanStatusFake: true, now: () => Date.parse('2026-11-26T00:45:02Z') });
  const fakeResult = await fake.getStatus('any@example.com');
  assert.equal(fakeResult.enabled, true);
  assert.equal(fakeResult.jobs?.find((job) => job.stage === 'ocr')?.page, 2);
  assert.equal(fakeResult.recent?.length, 3);

  const unavailable = new ScanStatusService({
    ocrServiceUrl: 'http://bridge.test',
    scanStatusEmails: ['owner@example.com'],
    source: async () => { throw new Error('bridge down'); },
  });
  const unavailableResult = await unavailable.getStatus('owner@example.com');
  assert.equal(unavailableResult.available, false);
  assert.deepEqual(unavailableResult.jobs, []);
});
