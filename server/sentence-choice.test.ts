// @vitest-environment node
import { expect, it } from 'vitest';
import { numberSentences, quoteRange, unitText } from './sentence-choice.ts';
import { memoSentences } from '../src/domain/shelter.ts';

it('numbers sentences with exact source offsets', () => {
  const source = '초코가 3.5분 짖었어요. 매트로 이동했어요!\n멈췄어요';
  const units = numberSentences(source);
  expect(units.map(unit => unit.text)).toEqual(['초코가 3.5분 짖었어요.', '매트로 이동했어요!', '멈췄어요']);
  expect(units.map(unit => unit.id)).toEqual(['S1', 'S2', 'S3']);
  for (const unit of units) expect(source.slice(unit.start, unit.end)).toBe(unit.text);
});
it('keeps repeated sentences as separate units at their own positions', () => {
  expect(numberSentences('짖었어요. 짖었어요.').map(unit => [unit.start, unit.end])).toEqual([[0, 5], [6, 11]]);
});
it('splits sentences longer than 2000 characters at a space without losing text', () => {
  const units = numberSentences(`${'가'.repeat(1500)} ${'나'.repeat(1500)}`);
  expect(units.map(unit => unit.text)).toEqual(['가'.repeat(1500), '나'.repeat(1500)]);
  expect(units[1].start).toBe(1501);
});
it('returns a contiguous source range only for ordered known IDs', () => {
  const source = '첫째. 둘째. 셋째.';
  const units = numberSentences(source);
  expect(quoteRange(source, units, 'S1', 'S2')).toBe('첫째. 둘째.');
  expect(quoteRange(source, units, 'S2', 'S1')).toBeNull();
  expect(quoteRange(source, units, 'S1', 'S9')).toBeNull();
  expect(unitText(units, 'S3')).toBe('셋째.');
  expect(unitText(units, 'S4')).toBeNull();
});
it('numbers memo sentences with the shelter splitter and a memo prefix', () => {
  expect(numberSentences('사람을 좋아함. 다른 개를 피함.', memoSentences, 'M1-S').map(unit => unit.id)).toEqual(['M1-S1', 'M1-S2']);
});
