import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readConfig } from '../server/config.ts';
import { createApiServices } from '../server/api-services.ts';
import { API_PRICES_CHECKED, estimateCostUsd } from '../server/api-pricing.ts';
import type { ApiError, ApiUsage } from '../server/api-types.ts';
import { generateConsultationNote } from '../server/consultation-notes.ts';
import type { ConsultationSession } from '../src/domain/consultation.ts';
import { evaluateFixture, featureFiles, smokeCases } from './evaluation.ts';

const args = process.argv.slice(2); let model = ''; let all = false; let long = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--all') all = true;
  else if (args[i] === '--long') long = true;
  else if (args[i] === '--model' && args[i + 1] && !args[i + 1].startsWith('--')) model = args[++i];
  else if (args[i] === '--help') { console.info('npm run llm:eval:api -- --model <gemini-3.8-flash|claude-sonnet-5-5|claude-haiku-5-5> [--all] [--long]\n기본 16개 사례 / --all 82개 / --long 가상 60분 전사 1건. 외부 API를 호출해 비용이 듭니다. 가상 자료만 사용합니다.'); process.exit(0); }
  else throw new Error(`지원하지 않는 인자: ${args[i]}`);
}
if (!model) throw new Error('--model을 지정하세요.');
// One model serves every feature so each result is attributable to it.
const config = readConfig({ ...process.env, AI_PROVIDER: 'api', API_TEXT_MODEL: model, API_SHORT_MODEL: model });
let usage: ApiUsage[] = [], errors: ApiError[] = [];
const services = createApiServices(config, { onUsage: entry => usage.push(entry), onError: entry => errors.push(entry) });
const apiErrors = () => errors.map(({ error, status, message }) => ({ error, status, message }));
const money = (cost: number | null, digits: number) => cost === null ? '가격 미등록' : '$' + cost.toFixed(digits);
const totals = () => {
  const inputTokens = usage.reduce((n, u) => n + u.inputTokens, 0), outputTokens = usage.reduce((n, u) => n + u.outputTokens, 0);
  return { calls: usage.length, inputTokens, outputTokens, costUsd: estimateCostUsd(model, inputTokens, outputTokens) };
};
type Report = { feature: string; passed?: boolean; inputTokens: number; outputTokens: number; costUsd: number | null; latencyMs: number } & Record<string, unknown>;
const reports: Report[] = [];
const output = `test-output/api-${model}-${long ? 'long' : all ? 'all' : 'smoke'}-${config.apiEffort}.json`;
const save = async () => {
  await mkdir('test-output', { recursive: true });
  await writeFile(output, JSON.stringify({ model, effort: config.apiEffort, pricesChecked: API_PRICES_CHECKED, createdAt: new Date().toISOString(), automaticChecksOnly: true, reports }, null, 2));
};
if (long) {
  const notes = JSON.parse(await readFile(new URL('../fixtures/session-notes.json', import.meta.url), 'utf8')) as { text: string }[];
  // About 19,000 characters: the measured size of a 60-minute Korean consultation transcript.
  const texts = Array.from({ length: 21 }, () => notes.map(note => note.text)).flat();
  const session = { id: 'long', metadata: { petName: '시연초코', trainerName: '시연 훈련사', sessionDate: '2026-11-11' }, createdAt: new Date().toISOString(), state: 'ready', durationMs: texts.length * 5000,
    segments: texts.map((text, sequence) => ({ id: `s${sequence}`, sequence, startMs: sequence * 5000, endMs: (sequence + 1) * 5000, text, originalText: text, state: 'complete' })), bookmarks: [], recordingChunkCount: 0, errors: [] } as unknown as ConsultationSession;
  const started = Date.now(); let error = '', fallbackUsed: boolean | null = null;
  try { fallbackUsed = (await generateConsultationNote(session, services.generate)).fallbackUsed ?? null; } catch (cause) { error = cause instanceof Error ? cause.message : '요청 실패'; }
  const latencyMs = Date.now() - started;
  reports.push({ feature: 'long-transcript', characters: texts.join('\n').length, latencyMs, fallbackUsed, error, apiErrors: apiErrors(), ...totals() });
  await save();
  console.info(`${model} 긴 전사: ${(latencyMs / 1000).toFixed(1)}s ${JSON.stringify(totals())}${error ? ` 오류: ${error}` : ''}`);
} else {
  for (const file of featureFiles) {
    const fixtures = JSON.parse(await readFile(new URL(`../fixtures/${file}.json`, import.meta.url), 'utf8'));
    const cases = all ? fixtures : fixtures.filter((f: { id: string }) => smokeCases[file].includes(f.id));
    if (!all && cases.length !== smokeCases[file].length) throw new Error(`평가 자료가 누락되었습니다: ${file}`);
    for (const fixture of cases) {
      usage = []; errors = []; const started = Date.now();
      const { failures, result } = await evaluateFixture(file, fixture, services);
      const latencyMs = Date.now() - started, cost = totals();
      reports.push({ feature: file, id: fixture.id, passed: !failures.length, failures, apiErrors: apiErrors(), latencyMs, ...cost, result });
      console.info(`${file}/${fixture.id}: ${failures.length ? 'FAIL' : 'PASS'} ${(latencyMs / 1000).toFixed(1)}s ${money(cost.costUsd, 4)} ${failures.join(' / ')}${failures.length && errors.length ? ` [${errors[0].status ? `${errors[0].status} ` : ''}${errors[0].error}: ${errors[0].message}]` : ''}`);
      await save();
    }
  }
  const sum = (key: 'inputTokens' | 'outputTokens') => reports.reduce((n, r) => n + r[key], 0);
  const cost = reports.reduce((n, r) => n + (r.costUsd ?? 0), 0), anyUnpriced = reports.some(r => r.costUsd === null);
  console.info(`${model}: ${reports.filter(r => r.passed).length}/${reports.length} 자동 조건 통과 · 입력 ${sum('inputTokens')} · 출력 ${sum('outputTokens')} 토큰 · 약 ${anyUnpriced ? '가격 미등록' : money(cost, 3)} (가격 ${API_PRICES_CHECKED} 기준)`);
  if (reports.some(r => !r.passed)) process.exitCode = 1;
}
