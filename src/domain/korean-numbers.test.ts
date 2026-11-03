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

describe('한 번 used as "once" rather than a count', () => {
  it('does not read it as a number when it means once something starts', () => {
    expect(extractNumbers('한 번 짖기 시작하면 오래 짖어요')).toEqual([]);
    expect(extractNumbers('한 번 흥분하면 멈추지 않아요')).toEqual([]);
    expect(extractNumbers('한 번 짖으면 계속 짖어요')).toEqual([]);
  });
  it('still reads a real count', () => {
    expect(extractNumbers('하루에 한 번 연습해요')).toEqual([1]);
    expect(extractNumbers('한 번에 삼 분씩 해요')).toEqual([1, 3]);
    expect(extractNumbers('한 번 짖었어요')).toEqual([1]);
    expect(extractNumbers('한 번 산책했어요')).toEqual([1]);
  });
});

describe('approximate counts', () => {
  it('reads both ends of a spoken range', () => {
    expect(extractNumbers('두세 번 짖어요')).toEqual([2, 3]);
    expect(extractNumbers('서너 번 그래요')).toEqual([3, 4]);
    expect(extractNumbers('네댓 번쯤')).toEqual([4, 5]);
    expect(extractNumbers('대여섯 번')).toEqual([5, 6]);
  });
  it('flags a range the source never said', () => {
    expect(numbersSupported('두세 번 짖는다', ['한 번 짖어요'])).toEqual([2, 3]);
    expect(numbersSupported('두세 번 짖는다', ['두세 번 짖어요'])).toEqual([]);
  });
});
describe('numbers tied to their units', () => {
  it('sees through swapped units even though the same digits appear', () => {
    expect(numbersSupported('3분씩 30번 연습', ['30분씩 3번 연습해 주세요'])).toEqual([3, 30]);
    expect(numbersSupported('삼 분씩 삼십 번', ['삼십 분씩 세 번'])).toEqual([3, 30]);
  });
  it('accepts the same quantity spelled differently', () => {
    expect(numbersSupported('세 번', ['3회'])).toEqual([]);
    expect(numbersSupported('오십 그램', ['50g 줘요'])).toEqual([]);
    expect(numbersSupported('30초', ['삼십 초 정도요'])).toEqual([]);
    expect(numbersSupported('3개월', ['석 달 전부터 세 달째', '3개월'])).toEqual([]);
  });
  it('lets a bare number in the source stand for any unit', () => {
    expect(numbersSupported('3번', ['그게 3이에요'])).toEqual([]);
  });
});

describe('numbers as people say them', () => {
  it('reads every spelling of a count', () => {
    expect(extractNumbers('세 차례')).toEqual([3]);
    expect(extractNumbers('한두 번')).toEqual([1, 2]);
    expect(extractNumbers('세네 번')).toEqual([3, 4]);
    expect(extractNumbers('네다섯 번')).toEqual([4, 5]);
    expect(extractNumbers('3,4번')).toEqual([3, 4]);
    expect(extractNumbers('1,000원')).toEqual([1000]);
    expect(extractNumbers('1~2회')).toEqual([1, 2]);
  });
  it('does not read words that only look like numbers', () => {
    for (const text of ['사회화 부족', '구분해 주세요', '이분법으로', '육회를 먹어요', '일회용 패드', '오일을 발라요', '일도 안 해요']) expect(extractNumbers(text), text).toEqual([]);
  });
  it('keeps the same quantity the same across spellings', () => {
    expect(numbersSupported('세 개월', ['3개월 됐어요'])).toEqual([]);
    expect(numbersSupported('3km', ['3킬로미터 걸어요'])).toEqual([]);
    expect(numbersSupported('주 1회', ['일주일에 한번 해요'])).toEqual([]);
    expect(numbersSupported('하루 1번', ['하루에 한번 해요'])).toEqual([]);
    expect(numbersSupported('1~2회', ['한두 번 해 주세요'])).toEqual([]);
  });
  it('notices an invented count in a spelling it used to skip', () => {
    expect(numbersSupported('다섯 차례', ['세 번 짖어요'])).toEqual([5]);
  });
  it('gives the start of a range the unit at its end', () => {
    expect(numbersSupported('30번', ['30~40분 걸려요'])).toEqual([30]);
    expect(numbersSupported('30분', ['30~40분 걸려요'])).toEqual([]);
  });
  it('still leaves a casual once alone', () => {
    expect(extractNumbers('한번 해 볼게요')).toEqual([]);
  });
});
