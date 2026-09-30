import { expect, it } from 'vitest';
import { approveDraft, createDraft, validateDraft } from './notes';
import { listNotes, saveNote } from './storage';
import * as notes from './notes';

it('preserves AI provenance through approval and storage, while reading legacy demo records', () => {
  localStorage.clear();
  const draft = createDraft('오늘 앉아를 관찰했습니다.', 'trainer_summary_text');
  Object.assign(draft, { mode: 'openai', generation: { requestId: 'r1', model: 'test', promptVersion: 'notes@1', latencyMs: 42, fallbackUsed: false } });
  expect(validateDraft(draft)).toEqual([]);
  const note = approveDraft(draft, { petName: '초코', trainerName: '훈련사', sessionDate: '2026-09-30' }, true);
  saveNote(note);
  expect(listNotes()[0].mode).toBe('openai');
  expect(listNotes()[0].draft.generation?.requestId).toBe('r1');
  const legacy = approveDraft(createDraft('관찰했습니다.', 'trainer_summary_text'), note.metadata, true);
  saveNote(legacy);
  expect(listNotes().map(entry => entry.mode)).toEqual(['demo', 'openai']);
});

it('rejects falsely unedited paraphrases and oversized edited fields', () => {
  const draft = createDraft('앉아를 관찰했습니다.', 'trainer_summary_text');
  draft.items[0].text = '완전히 다른 사실';
  expect(validateDraft(draft).length).toBeGreaterThan(0);
  draft.items[0].edited = true;
  draft.items[0].text = '가'.repeat(2001);
  expect(validateDraft(draft).length).toBeGreaterThan(0);
});

it('creates bounded manual review from every valid long input', () => {
  expect(typeof notes.createManualDraft).toBe('function');
  for (const text of ['관찰했습니다. '.repeat(101), '가'.repeat(2000) + ' '.repeat(2000) + '나']) {
    const draft = notes.createManualDraft(text, 'trainer_summary_text');
    expect(validateDraft(draft)).toEqual([]);
    expect(draft.items.every(item => item.category === 'follow_up' && text.includes(item.sourceQuote))).toBe(true);
  }
});
