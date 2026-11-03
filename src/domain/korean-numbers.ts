// Sino and native numerals only count before a unit word, otherwise 일단, 이번, 한번 would read as numbers.
const NATIVE_ONES: Record<string, number> = { 한: 1, 하나: 1, 두: 2, 둘: 2, 세: 3, 셋: 3, 네: 4, 넷: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9 };
const NATIVE_TENS: Record<string, number> = { 열: 10, 스무: 20, 스물: 20, 서른: 30, 마흔: 40, 쉰: 50 };
const SINO_DIGITS: Record<string, number> = { 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 칠: 7, 팔: 8, 구: 9 };
const SINO_UNITS: Record<string, number> = { 십: 10, 백: 100, 천: 1000 };
const NATIVE_COUNTERS = '번|회|시간|시|개|명|마리|걸음|살|달|주|군데|곳|가지|바퀴';
const SINO_COUNTERS = '초|분|그램|킬로그램|킬로|미터|센티미터|센티|밀리|도|퍼센트|프로|회|번|일|주|개월|년|시간|원';

const native = new RegExp(`(?<![가-힣])(?:(열|스무|스물|서른|마흔|쉰)\\s?)?(한|하나|두|둘|세|셋|네|넷|다섯|여섯|일곱|여덟|아홉)?\\s?(?:${NATIVE_COUNTERS})(?![가-힣]*[다요까])?`, 'g');
const sino = new RegExp(`(?<![가-힣])([일이삼사오육칠팔구십백천]+)\\s?(?=${SINO_COUNTERS})`, 'g');
const digits = /\d[\d,]*(?:\.\d+)?/g;
// 한번 and 두어 번 style idioms mean "once, casually" rather than a count.
const idiom = /(?<![가-힣])(한번|한 번쯤|한 번(?=\s[가-힣]+(?:으면|하면|기\s*시작)))(?![가-힣]*\d)/g;
const ordinaryWords = /(?<![가-힣])(일단|이번|이미|오늘|오전|구석|사료|삼키|일어나|이동|일부|이후|이상|이때|일찍|오래|구체)/g;

function readSino(word: string): number | null {
  let total = 0; let current = 0;
  for (const character of word) {
    if (character in SINO_DIGITS) {
      if (current) return null;
      current = SINO_DIGITS[character];
    } else if (character in SINO_UNITS) {
      total += (current || 1) * SINO_UNITS[character]; current = 0;
    } else return null;
  }
  return total + current;
}

const RANGES: Record<string, number[]> = { 두세: [2, 3], 서너: [3, 4], 네댓: [4, 5], 너댓: [4, 5], 대여섯: [5, 6], 예닐곱: [6, 7], 일고여덟: [7, 8], 여덟아홉: [8, 9] };
const range = new RegExp(`(?<![가-힣])(${Object.keys(RANGES).join('|')})\\s?(?:${NATIVE_COUNTERS})`, 'g');
const UNIT_AFTER = /^\s?(번|회|차례|초|분|시간|시|개월|달|주|일|년|살|개|명|마리|걸음|바퀴|군데|곳|가지|그램|킬로그램|킬로|미터|센티미터|센티|밀리|도|퍼센트|프로|원|kg|g|km|m|cm|%)/i;
const UNIT_FAMILY: Record<string, string> = { 번: 'times', 회: 'times', 차례: 'times', 그램: 'g', g: 'g', 킬로그램: 'kg', 킬로: 'kg', kg: 'kg', 미터: 'm', m: 'm', 센티미터: 'cm', 센티: 'cm', cm: 'cm', 퍼센트: '%', 프로: '%', '%': '%', 달: 'month', 개월: 'month' };
type Quantity = { value: number; unit: string };

function readQuantities(text: string): Quantity[] {
  const source = text.replace(idiom, match => ' '.repeat(match.length)).replace(ordinaryWords, match => ' '.repeat(match.length));
  const found: (Quantity & { at: number })[] = [];
  const unitAt = (end: number) => { const word = UNIT_AFTER.exec(source.slice(end))?.[1]?.toLowerCase() ?? ''; return UNIT_FAMILY[word] ?? word; };
  for (const match of source.matchAll(range)) for (const value of RANGES[match[1]]) found.push({ at: match.index, value, unit: unitAt(match.index + match[1].length) });
  const covered = found.map(item => item.at);
  for (const match of source.matchAll(digits)) found.push({ at: match.index, value: Number(match[0].replace(/,/g, '')), unit: unitAt(match.index + match[0].length) });
  for (const match of source.matchAll(native)) {
    if (covered.includes(match.index)) continue;
    const tens = match[1] ? NATIVE_TENS[match[1]] : 0;
    const ones = match[2] ? NATIVE_ONES[match[2]] : 0;
    if (tens + ones > 0) { const counter = /(번|회|시간|시|개|명|마리|걸음|살|달|주|군데|곳|가지|바퀴)\s*$/.exec(match[0])?.[1] ?? ''; found.push({ at: match.index, value: tens + ones, unit: UNIT_FAMILY[counter] ?? counter }); }
  }
  for (const match of source.matchAll(sino)) {
    const value = readSino(match[1]);
    if (value !== null) found.push({ at: match.index, value, unit: unitAt(match.index + match[1].length) });
  }
  return found.sort((a, b) => a.at - b.at).map(({ value, unit }) => ({ value, unit }));
}

/** Returns every count written in digits or Korean numerals, in order of appearance. */
export function extractNumbers(text: string): number[] {
  return readQuantities(text).map(item => item.value);
}

/**
 * Numbers in `text` that appear in none of `sources`. Spelling differences such as 세 번 and 3번 do not matter,
 * but the unit does when both sides state one, so 30분씩 3번 cannot be rewritten as 3분씩 30번.
 */
export function numbersSupported(text: string, sources: string[]): number[] {
  const known = sources.flatMap(readQuantities);
  return readQuantities(text).filter(({ value, unit }) => !known.some(item => item.value === value && (!unit || !item.unit || unit === item.unit))).map(item => item.value);
}
