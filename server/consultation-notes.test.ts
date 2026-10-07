// @vitest-environment node
import { expect, it } from 'vitest';
import { createDraft, createManualDraft } from '../src/domain/notes.ts';
import type { ConsultationSession } from '../src/domain/consultation.ts';
import { validateConsultationNote } from '../src/domain/consultation.ts';
import { generateConsultationNote } from './consultation-notes.ts';

function session(texts: string[]): ConsultationSession {
  return { id: 'test', metadata: { petName: 'Choco', trainerName: 'Kim', sessionDate: '2026-10-07' }, createdAt: new Date().toISOString(), state: 'ready', durationMs: texts.length * 5000, segments: texts.map((text, sequence) => ({ id: `s${sequence}`, sequence, startMs: sequence * 5000, endMs: (sequence + 1) * 5000, text, originalText: text, state: 'complete' })), bookmarks: [{ id: 'b0', atMs: 2000, text: 'Manual exact observation' }], recordingChunkCount: 0, errors: [] };
}

it('processes every transcript character within bounded groups and preserves source evidence', async () => {
  const current = session(['a'.repeat(10000), 'final transcript']); const inputs: string[] = [];
  const note = await generateConsultationNote(current, async text => { inputs.push(text); return { draft: createManualDraft(text, 'trainer_summary_voice') }; });
  expect(inputs.every(text => text.length <= 2000)).toBe(true);
  expect(inputs.join('').replace(/\s/g, '')).toBe(current.segments.map(segment => segment.text).join('').replace(/\s/g, ''));
  expect(note.coveredSegmentIds).toEqual(['s0', 's1']);
  expect(note.items.find(item => item.section === 'moments')?.text).toBe('Manual exact observation');
  expect(note.items.find(item => item.section === 'observation')?.evidence[0].kind).toBe('bookmark');
  expect(note.missingSections).toContain('task');
  expect(validateConsultationNote(note, current)).toEqual([]);
});

it('rejects invented quotes, missing coverage, unsupported numbers and forged approval', async () => {
  const current = session(['Exact source']); const note = await generateConsultationNote(current, async text => ({ draft: createDraft(text, 'trainer_summary_voice') }));
  note.items[0].evidence[0].quote = 'Invented';
  expect(validateConsultationNote(note, current)).toContain('EVIDENCE');
  note.items[0].evidence[0].quote = 'Exact source'; note.items[0].text = 'Practice 123 times';
  expect(validateConsultationNote(note, current)).toContain('UNSUPPORTED_TEXT');
  note.coveredSegmentIds = [];
  expect(validateConsultationNote(note, current)).toContain('COVERAGE');
});

it('rejects malformed note items without throwing', () => {
  expect(validateConsultationNote({ items: [null], missingSections: [], coveredSegmentIds: [], createdAt: new Date().toISOString() }, session(['source']))).toContain('INPUT');
});

it('packs short segments into at most 24 source quotes per call and preserves quotes omitted by model', async () => {
  const current = session(Array.from({ length: 80 }, (_, index) => `Source ${index} reported exactly.`)); const inputs: string[] = [];
  const note = await generateConsultationNote(current, async text => { inputs.push(text); const draft = createDraft(text, 'trainer_summary_voice'); draft.items = draft.items.slice(0, 1); return { draft }; });
  expect(inputs).toHaveLength(4);
  expect(inputs.every(text => text.length <= 2000 && text.split('\n').length <= 24)).toBe(true);
  expect(note.fallbackUsed).toBe(true); expect(note.warnings?.length).toBeGreaterThan(0);
  expect(note.coveredSegmentIds).toHaveLength(80);
  for (const segment of current.segments) expect(note.items.some(item => item.text === segment.text && item.evidence[0].id === segment.id)).toBe(true);
  expect(validateConsultationNote(note, current)).toEqual([]);
});

it('preserves 500 repeated utterances without multiplying duplicate model quotes', async () => {
  const current = session(Array.from({ length: 500 }, () => 'Yes.')); let calls = 0;
  const note = await generateConsultationNote(current, async text => { calls++; return { draft: createDraft(text, 'trainer_summary_voice') }; });
  const transcriptItems = note.items.filter(item => item.evidence[0].kind === 'segment');
  expect(calls).toBe(21); expect(transcriptItems).toHaveLength(500);
  expect(new Set(transcriptItems.map(item => item.evidence[0].id)).size).toBe(500);
  expect(note.coveredSegmentIds).toHaveLength(500); expect(validateConsultationNote(note, current)).toEqual([]);
});
