import { describe, expect, it } from 'vitest';
import { extractNumbers, numbersSupported } from './korean-numbers';

describe('extractNumbers', () => {
  it.each([
    ['3번 짖었습니다', [3]],
    ['세 번 짖었습니다', [3]],
    ['두번 했어요', [2]],
    ['아침 여덟 시', [8]],
    ['열두 시에', [12]],
    ['스무 번', [20]],
    ['스물다섯 번', [25]],
    ['오십 그램', [50]],
    ['삼십 초 정도', [30]],
    ['이십 분쯤', [20]],
    ['백이십 미터', [120]],
    ['십오 초', [15]],
    ['삼 분씩', [3]],
    ['일 미터', [1]],
    ['1.5미터', [1.5]],
    ['50g', [50]],
    ['1,200원', [1200]],
    ['한 번, 이십 분', [1, 20]],
  ])('%s', (text, expected) => {
    expect(extractNumbers(text)).toEqual(expected);
  });
  it.each(['한번 틀어 볼게요', '일단 멈추세요', '이번 주에', '오늘 저녁', '두 걸음'])('%s has no misread sino number', text => {
    const found = extractNumbers(text);
    if (text === '두 걸음') expect(found).toEqual([2]);
    else expect(found).toEqual([]);
  });
  it('does not read ordinary words as numbers', () => {
    expect(extractNumbers('보호자가 사료를 삼키고 구석으로 일어나 이동했습니다')).toEqual([]);
  });
});

describe('numbersSupported', () => {
  it('accepts a different spelling of the same number', () => {
    expect(numbersSupported('3번 짖음', ['세 번 짖었어요'])).toEqual([]);
    expect(numbersSupported('오십 그램', ['사료 50g'])).toEqual([]);
  });
  it('returns numbers no source supports', () => {
    expect(numbersSupported('5번 짖음', ['세 번 짖었어요'])).toEqual([5]);
  });
  it('checks across several sources', () => {
    expect(numbersSupported('2번, 3분', ['두 번', '삼 분'])).toEqual([]);
  });
});
