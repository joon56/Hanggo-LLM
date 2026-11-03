// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { CoachingNote, CoachingTask } from '../src/domain/coaching-note.ts';
import { aggregateScores, scoreDelivered, type GoldenDialogue } from './note-metrics.ts';

const dialogue: GoldenDialogue = {
  id: 'test', segments: [{ id: 's01', speaker: 'guardian', startMs: 0, endMs: 1000, text: '초인종에 세 번 짖어요' }, { id: 's02', speaker: 'trainer', startMs: 1000, endMs: 2000, text: '보호자님이 매트 연습을 해 주세요' }],
  expectedFacts: [{ id: 'trigger', any: [['초인종']] }, { id: 'count', any: [['세 번', '3번']] }],
  expectedTasks: [{ id: 'mat', any: [['매트']], who: ['보호자'], frequency: null, until: null }],
  unknown: [], expectedSafetyFlags: ['구토'], expectedMethodReview: false, forbiddenClaims: ['치료', '남편이'],
  attributions: [{ section: 'guardianReports', any: [['초인종']] }],
};
const evidence = [{ kind: 'segment' as const, id: 's01', quote: '초인종에 세 번 짖어요', startMs: 0, endMs: 1000, speaker: 'guardian' as const }];
const claim = (text: string) => ({ id: text, text, evidence });
const task = (change: Partial<CoachingTask> = {}): CoachingTask => ({ id: 't', text: '매트 연습', who: '보호자', frequency: null, until: null, successCriteria: null, evidence, ...change });
const note = (change: Partial<CoachingNote> = {}): CoachingNote => ({ version: 2, summary: [], concerns: [], behaviors: [], guardianReports: [claim('초인종에 세 번 짖는다')], trainerObservations: [], aiObservations: [], guidance: [], tasks: [task()], followUps: [], safetyFlags: ['구토'], methodReview: false, uncitedSegmentIds: [], createdAt: 'now', warnings: [], ...change });

describe('scoreDelivered', () => {
  it('gives a faithful note full marks', () => {
    expect(scoreDelivered(dialogue, note())).toMatchObject({ factRecall: 1, taskRecall: 1, taskFieldRecall: 1, inventedTasks: 0, unsupportedNumbers: 0, forbiddenHits: [], safetyRecall: 1, methodReviewMatch: true, attributionRecall: 1, emptied: false });
  });
  it('counts a missed fact', () => {
    expect(scoreDelivered(dialogue, note({ guardianReports: [claim('초인종에 짖는다')] })).factRecall).toBe(0.5);
  });
  it('credits what a guardian said when it sits under a behavior, which still shows who said it', () => {
    const entry = (speaker: 'guardian' | 'trainer') => ({ id: 'b', title: '짖음', context: [{ ...claim('초인종에 세 번 짖는다'), evidence: [{ ...evidence[0], speaker }] }], behavior: [], response: [], unknown: [] });
    expect(scoreDelivered(dialogue, note({ guardianReports: [], behaviors: [entry('guardian')] })).attributionRecall).toBe(1);
    expect(scoreDelivered(dialogue, note({ guardianReports: [], behaviors: [entry('trainer')] })).attributionRecall).toBe(0);
  });
  it('wants a field the dialogue never states to stay empty', () => {
    expect(scoreDelivered(dialogue, note({ tasks: [task({ frequency: '하루 세 번' })] })).taskFieldRecall).toBeCloseTo(2 / 3);
  });
  it('matches one task to one expectation, so a merged task cannot answer two', () => {
    const two: GoldenDialogue = { ...dialogue, expectedTasks: [{ id: 'a', any: [['매트']], who: ['보호자'], frequency: null, until: null }, { id: 'b', any: [['매트']], who: ['남편'], frequency: null, until: null }] };
    expect(scoreDelivered(two, note()).taskRecall).toBe(0.5);
  });
  it('counts a task nobody assigned', () => {
    expect(scoreDelivered({ ...dialogue, expectedTasks: [] }, note()).inventedTasks).toBe(1);
  });
  it('finds a forbidden phrase anywhere, including inside task fields', () => {
    expect(scoreDelivered(dialogue, note({ tasks: [task({ who: '남편이' })] })).forbiddenHits).toEqual(['남편이']);
  });
  it('checks who a fact was attributed to', () => {
    expect(scoreDelivered(dialogue, note({ guardianReports: [], guidance: [claim('초인종에 세 번 짖는다')] })).attributionRecall).toBe(0);
  });
  it('counts numbers the evidence does not hold', () => {
    expect(scoreDelivered(dialogue, note({ guardianReports: [claim('초인종에 다섯 번 짖는다')] })).unsupportedNumbers).toBe(1);
  });
  it('reports safety flags it did not expect', () => {
    expect(scoreDelivered(dialogue, note({ safetyFlags: ['구토', '설사'] })).extraSafetyFlags).toEqual(['설사']);
  });
  it('marks a blank fallback form', () => {
    expect(scoreDelivered(dialogue, note({ fallbackUsed: true })).emptied).toBe(true);
  });
});

describe('aggregateScores', () => {
  it('sums the counts that must stay at zero and averages recall over the dialogues that have it', () => {
    const faithful = scoreDelivered(dialogue, note());
    const noTasks = scoreDelivered({ ...dialogue, expectedTasks: [], attributions: undefined }, note({ tasks: [] }));
    const sloppy = scoreDelivered(dialogue, note({ guardianReports: [claim('초인종에 다섯 번 짖는다')], tasks: [] }));
    const summary = aggregateScores([faithful, noTasks, sloppy]);
    expect(summary).toMatchObject({ dialogues: 3, unsupportedNumbers: 1, inventedTasks: 0, forbiddenHits: 0, emptied: 0 });
    expect(summary.factRecall).toBeCloseTo((1 + 1 + 0.5) / 3);
    expect(summary.taskRecall).toBeCloseTo((1 + 0) / 2);
  });
});
