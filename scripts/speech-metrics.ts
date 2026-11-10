const characters = (value: string) => Array.from(value.normalize('NFKC').replace(/[\p{P}\p{Z}\s]/gu, ''));
const round = (value: number) => Math.round(value * 10000) / 10000;

/** Removes punctuation and spacing. Number spelling variants such as 여덟 시 and 8시 still count as errors. */
export function characterErrorRate(reference: string, actual: string) {
  const a = characters(reference), b = characters(actual);
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return a.length ? row[b.length] / a.length : (b.length ? 1 : 0);
}

/** Each term lists accepted spellings, so a correct digit form is not penalized the way CER penalizes it. */
export function termRecall(terms: string[][], text: string) {
  const compact = characters(text).join('');
  const found = terms.filter(spellings => spellings.some(term => compact.includes(characters(term).join('')))).length;
  return { found, total: terms.length };
}

const SCRIPTS = ['Han', 'Hiragana', 'Katakana', 'Latin'];
const scriptsIn = (value: string) => SCRIPTS.filter(script => new RegExp(`\\p{Script=${script}}`, 'u').test(value));

/** Writing the speaker did not use, such as 嗯 for "음" or Yeah for "예". */
export function foreignScript(reference: string, actual: string) {
  const expected = scriptsIn(reference);
  return scriptsIn(actual).some(script => !expected.includes(script));
}

export function summarizeRuns(runs: { cer: number; found: number; total: number; realTimeFactor: number; foreign?: boolean }[]) {
  const mean = (values: number[]) => round(values.reduce((sum, value) => sum + value, 0) / values.length);
  const factors = runs.map(run => run.realTimeFactor).sort((a, b) => a - b);
  const total = runs.reduce((sum, run) => sum + run.total, 0);
  return { runs: runs.length, meanCer: mean(runs.map(run => run.cer)),
    termRecall: total ? round(runs.reduce((sum, run) => sum + run.found, 0) / total) : null,
    foreignRuns: runs.filter(run => run.foreign).length, meanRealTimeFactor: mean(factors), p95RealTimeFactor: round(factors[Math.ceil(factors.length * 0.95) - 1]) };
}
