// @vitest-environment node
import { expect, it } from 'vitest';
import { characterErrorRate, summarizeRuns, termRecall } from '../scripts/speech-metrics.ts';

it('ignores spacing and punctuation when measuring character errors', () => {
  expect(characterErrorRate('초코가 앉았습니다.', '초코가앉았습니다')).toBe(0);
  expect(characterErrorRate('가나다라', '가나다마')).toBe(0.25);
  expect(characterErrorRate('', '')).toBe(0);
  expect(characterErrorRate('', '가')).toBe(1);
});
it('counts a term as recalled when any spelling appears', () => {
  const terms = [['세 번', '3번'], ['초코'], ['짖었']];
  expect(termRecall(terms, '초코는 3번 지졌습니다')).toEqual({ found: 2, total: 3 });
  expect(termRecall([], '아무 말')).toEqual({ found: 0, total: 0 });
});
it('matches terms regardless of spacing', () => {
  expect(termRecall([['세 번']], '세번 짖었습니다')).toEqual({ found: 1, total: 1 });
});
it('summarizes mean error, pooled recall, and tail latency', () => {
  const summary = summarizeRuns([
    { cer: 0.1, found: 1, total: 2, realTimeFactor: 0.1 },
    { cer: 0.3, found: 2, total: 2, realTimeFactor: 0.2 },
    { cer: 0.2, found: 0, total: 0, realTimeFactor: 0.9 },
  ]);
  expect(summary).toEqual({ runs: 3, meanCer: 0.2, termRecall: 0.75, meanRealTimeFactor: 0.4, p95RealTimeFactor: 0.9 });
});
it('reports recall as null when no sample defines terms', () => {
  expect(summarizeRuns([{ cer: 0, found: 0, total: 0, realTimeFactor: 0.1 }]).termRecall).toBeNull();
});
