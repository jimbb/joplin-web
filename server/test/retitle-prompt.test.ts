import assert from 'node:assert/strict';
import { test } from 'node:test';

test('retitle and uniqueness prompts carry the notebook path that names the card', async () => {
  // Config validates the server URL on import; the prompt builders never call it
  process.env.JOPLIN_SERVER_URL ??= 'http://127.0.0.1:9';
  const { buildRetitleUserPrompt, buildUniquenessUserPrompt, buildTitleRule } = await import('../src/services/organizer.js');
  const prompt = buildRetitleUserPrompt({
    currentTitle: '2026-05 OMYCard 3215',
    notebookPath: 'Bank Statements / Jimmy / OMYCard / Card 3215',
    createdDate: '2026-05-01',
    bodyText: '',
    attachmentFilenames: ['statement.pdf'],
    ocrText: 'Card ending 3207 ... Card ending 3215 ... Card ending 6423',
  });
  assert.match(prompt, /^Notebook: Bank Statements \/ Jimmy \/ OMYCard \/ Card 3215$/m);
  assert.doesNotMatch(buildRetitleUserPrompt({ currentTitle: 'x', createdDate: 'd', bodyText: '', attachmentFilenames: [], ocrText: '' }), /Notebook:/);

  const uniqueness = buildUniquenessUserPrompt({
    collidingTitle: '2026-05-12 PrimeCredit – Credit Card Statement',
    targetNotes: [
      { noteId: 'a'.repeat(32), createdDate: '2026-05-01', currentTitle: '2026-05 OMYCard 3215', notebookPath: 'OMYCard / Card 3215', currentSuggestion: 's', excerpt: 'e' },
    ],
  });
  assert.match(uniqueness, /^notebook: OMYCard \/ Card 3215$/m);
  assert.match(buildTitleRule('standard'), /named in the current title or notebook path/);
});
