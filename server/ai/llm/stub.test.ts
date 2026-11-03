// @vitest-environment node
import { expect, it } from 'vitest';
import { assembleNote, buildNoteSource, type RawNote } from '../../../src/domain/coaching-note.ts';
import type { Segment } from '../../../src/domain/coaching.ts';
import { buildNoteRequest, buildSummaryRequest, RawNoteSchema, RawSummarySchema } from '../../coaching/note-prompt.ts';
import { createStubLlm } from './stub.ts';

const segment = (id: string, speaker: Segment['speaker'], startMs: number, text: string): Segment => ({ id, speaker, startMs, endMs: startMs + 1000, text, originalText: text, state: 'complete' });
const segments = [segment('a', 'guardian', 0, '[시험 전사] 보호자 마이크 신호입니다'), segment('b', 'trainer', 2000, '[시험 전사] 훈련사 마이크 신호입니다')];
const source = buildNoteSource({ segments, moments: [] }, { petName: '초코', guardianName: '가상 보호자', trainerName: '가상 훈련사' });

it('answers with a note the real checks accept, so automated runs exercise the real path', async () => {
  const { json, finished } = await createStubLlm().structured({ ...buildNoteRequest('초코', source.lines) });
  expect(finished).toBe(true);
  const { note, violations } = assembleNote(RawNoteSchema.parse(json) as RawNote, source, 'now');
  expect(violations).toEqual([]);
  expect(note.guardianReports[0].evidence[0].id).toBe('a');
  expect(note.guidance[0].evidence[0].id).toBe('b');
  expect(note.tasks[0].evidence[0].id).toBe('b');
  expect(note.uncitedSegmentIds).toEqual([]);
});
it('answers the summary request from the statements it was given', async () => {
  const { json } = await createStubLlm().structured({ ...buildSummaryRequest('초코', [{ text: '보호자 문장', aliases: ['s01'] }, { text: '훈련사 문장', aliases: ['s02', 's03'] }]) });
  expect(RawSummarySchema.parse(json).summary).toEqual([{ text: '보호자 문장', evidence: ['s01'] }, { text: '훈련사 문장', evidence: ['s02'] }]);
});
it('marks its scene observations as test output', async () => {
  const { json } = await createStubLlm().structured({ jsonSchema: {}, system: '', user: '', images: [Buffer.from([1]), Buffer.from([2])] });
  expect(json).toEqual({ observations: ['[시험 관찰] 사진 2장을 받았습니다.'] });
});
