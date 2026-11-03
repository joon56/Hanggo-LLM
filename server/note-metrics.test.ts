// @vitest-environment node
import { expect, it } from 'vitest';
import { collectNoteText, scoreNote, type GoldenDialogue } from '../scripts/note-metrics.ts';

const dialogue: GoldenDialogue = {
  id: 'd', segments: [{ id: 's01', speaker: 'guardian', startMs: 0, endMs: 1, text: '초인종이 울리면 하루에 세 번 짖어요.' }, { id: 's02', speaker: 'trainer', startMs: 1, endMs: 2, text: '하루 두 번 매트 연습을 하세요.' }],
  expectedFacts: [{ id: 'trigger', any: [['초인종']] }, { id: 'frequency', any: [['세 번', '3번']] }, { id: 'missing', any: [['산책']] }],
  expectedTasks: [{ id: 'mat', any: [['매트']], who: ['보호자'], frequency: ['두 번', '2번'], until: ['다음 상담'] }],
  unknown: [], expectedSafetyFlags: ['절뚝거림'], expectedMethodReview: true, forbiddenClaims: ['진단', '분리불안'],
};
const claim = (text: string, evidence = ['s01']) => ({ text, evidence });
const note = {
  summary: [claim('초인종이 울리면 3번 짖음')], concerns: [], guardianReports: [], trainerObservations: [], guidance: [claim('매트 연습 안내', ['s02'])], followUps: [],
  behaviors: [{ title: '짖음', context: [claim('초인종')], behavior: [], response: [], unknown: [] }],
  tasks: [{ text: '매트 연습', who: '보호자', frequency: '2번', until: null, successCriteria: null, evidence: ['s02'] }], safetyFlags: [], methodReview: true,
};

it('gathers text from every section, including nested behaviors and tasks', () => {
  expect(collectNoteText(note)).toEqual(expect.arrayContaining(['초인종이 울리면 3번 짖음', '매트 연습 안내', '초인종', '짖음', '매트 연습']));
});
it('measures fact recall across all sections', () => {
  expect(scoreNote(dialogue, note).factRecall).toBeCloseTo(2 / 3);
});
it('scores tasks with field coverage', () => {
  expect(scoreNote(dialogue, note)).toMatchObject({ taskRecall: 1, taskFieldRecall: 2 / 3, inventedTasks: 0 });
});
it('counts tasks when none were agreed as invented', () => {
  expect(scoreNote({ ...dialogue, expectedTasks: [] }, note)).toMatchObject({ taskRecall: null, inventedTasks: 1 });
});
it('flags numbers absent from the cited evidence, allowing Korean numeral spellings', () => {
  const ok = { ...note, summary: [claim('세 번 짖음')] };
  expect(scoreNote(dialogue, ok).unsupportedNumbers).toEqual([]);
  const bad = { ...note, summary: [claim('5번 짖음')] };
  expect(scoreNote(dialogue, bad).unsupportedNumbers).toEqual(['5']);
});
it('finds forbidden claims', () => {
  expect(scoreNote(dialogue, { ...note, concerns: [claim('분리불안으로 진단')] }).forbiddenHits).toEqual(['진단', '분리불안']);
});
it('reports safety recall and method review match', () => {
  expect(scoreNote(dialogue, note)).toMatchObject({ safetyRecall: 0, methodReviewMatch: true });
  expect(scoreNote(dialogue, { ...note, safetyFlags: ['절뚝거림'], methodReview: false })).toMatchObject({ safetyRecall: 1, methodReviewMatch: false });
});
it('scores a missing or malformed note as total failure', () => {
  expect(scoreNote(dialogue, null)).toMatchObject({ valid: false, factRecall: 0 });
  expect(scoreNote(dialogue, 'oops')).toMatchObject({ valid: false, factRecall: 0 });
});
