// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { correctTerms, termRecall } from './speech-terms.ts';

describe('correctTerms', () => {
  it.each([
    ['현관으로 뛰어가서 계속 찢어요', '현관으로 뛰어가서 계속 짖어요'],
    ['초인종이 울리면 다시 찢어요', '초인종이 울리면 다시 짖어요'],
    ['그러면 더 흥분해서 짓는 것 같아요', '그러면 더 흥분해서 짖는 것 같아요'],
    ['한 번 짓기 시작하면 얼마나 오래 짓나요?', '한 번 짖기 시작하면 얼마나 오래 짖나요?'],
    ['짚는 횟수가 어땠는지 봅시다', '짖는 횟수가 어땠는지 봅시다'],
    ['어제 많이 찢었어요', '어제 많이 짖었어요'],
    ['메트로 가는 연습을 할 겁니다', '매트로 가는 연습을 할 겁니다'],
    ['메트에 가면 바로 간식을 주세요', '매트에 가면 바로 간식을 주세요'],
    ['한에스를 채워 보세요', '하네스를 채워 보세요'],
    ['한혜수는 써 봤어요', '하네스는 써 봤어요'],
  ])('fixes what the model confuses in this domain: %s', (heard, meant) => {
    expect(correctTerms(heard)).toBe(meant);
  });
  it.each([
    '장난감을 찢어요',
    '이불을 찢었어요',
    '휴지 찢어요',
    '인형 찢는 걸 좋아해요',
    '바닥을 짚는 앞발을 보세요',
    '집을 짓는 공사 소리에 놀랐어요',
    '밥 짓는 냄새가 나면 와요',
    '메트로폴리탄 근처에 살아요',
    '한혜수 씨가 산책을 시켜요',
    '짖어요',
  ])('leaves words that mean something else: %s', text => {
    expect(correctTerms(text)).toBe(text);
  });
  it('only treats a name-like word as harness when the sentence is about gear', () => {
    expect(correctTerms('한혜수는 오늘 왔어요')).toBe('한혜수는 오늘 왔어요');
    expect(correctTerms('산책할 때 한혜수를 채워요')).toBe('산책할 때 하네스를 채워요');
  });
});

describe('termRecall', () => {
  it('counts how many mentions of each domain word survived', () => {
    const { found, total, missed } = termRecall('초인종에 짖어요. 또 짖어요. 매트로 가요.', '초인종에 찢어요. 또 짖어요. 메트로 가요.');
    expect({ found, total }).toEqual({ found: 2, total: 4 });
    expect(missed).toEqual({ 짖: 1, 매트: 1 });
  });
  it('does not credit extra mentions the reference never had', () => {
    expect(termRecall('간식을 주세요', '간식 간식 간식을 주세요')).toMatchObject({ found: 1, total: 1 });
  });
  it('reports nothing to count when the reference has no domain words', () => {
    expect(termRecall('오늘 날씨가 좋아요', '오늘 날씨가 좋아요')).toEqual({ found: 0, total: 0, missed: {} });
  });
});
