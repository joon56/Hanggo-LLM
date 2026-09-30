import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readConfig } from '../server/config.ts';
import { createOllamaServices } from '../server/ollama.ts';
import { evaluateDraft, Fixture } from './evaluation.ts';
import { validateOwnerDraft } from '../src/domain/owner-log.ts';
import { validateShelterDraft } from '../src/domain/shelter.ts';
import { OwnerInputSchema } from '../server/owner-service.ts';
import { BriefInputSchema } from '../server/brief-service.ts';
import { ShelterInputSchema } from '../server/shelter-service.ts';

const args = process.argv.slice(2); let model: string | undefined; let all = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--all') all = true;
  else if (args[i] === '--model' && args[i + 1] && !args[i + 1].startsWith('--')) model = args[++i];
  else if (args[i] === '--help') { console.info('npm run llm:eval:local -- [--model qwen3.5:9b] [--all]\n기본 16개 사례 / --all 82개. 실제 로컬 모델 호출, 외부 API 사용 없음.'); process.exit(0); }
  else throw new Error(`지원하지 않는 인자: ${args[i]}`);
}
const config = readConfig({ ...process.env, ...(model ? { OLLAMA_MODEL: model } : {}) });
const services = createOllamaServices(config);
// Pick a fixed, visible subset; never choose cases based on a model's outputs.
const smokeCases: Record<string, string[]> = {
  'session-notes': ['N06', 'N09', 'N11', 'N15', 'N23', 'N29'],
  'owner-logs': ['bark-delivery', 'walk', 'ambiguous-pet', 'multi-events'],
  briefs: ['empty', 'increase'],
  'shelter-profiles': ['one-memo', 'contradiction', 'all-cautions', 'sensitive-context'],
};
const reports: Record<string, unknown>[] = [];
for (const file of ['session-notes', 'owner-logs', 'briefs', 'shelter-profiles']) {
  const fixtures = JSON.parse(await readFile(new URL(`../fixtures/${file}.json`, import.meta.url), 'utf8'));
  const cases = all ? fixtures : fixtures.filter((f: { id: string }) => smokeCases[file].includes(f.id));
  if (!all && cases.length !== smokeCases[file].length) throw new Error(`평가 자료가 누락되었습니다: ${file}`);
  for (const fixture of cases) {
    const failures: string[] = []; const started = Date.now();
    let result: unknown;
    try {
      if (file === 'session-notes') {
        const f = Fixture.parse(fixture), r = await services.generate(f.text, 'trainer_summary_text'); result = r;
        failures.push(...evaluateDraft(r.draft, f.expect, r.fallbackUsed));
        if (r.draft.safetyFlags.some(flag => !f.expect.safetyFlags.includes(flag))) failures.push('기대하지 않은 안전 신호');
        if (r.draft.methodReview !== f.expect.methodReview) failures.push('방법 검토 신호 불일치');
      } else if (file === 'owner-logs') {
        const r = await services.generateOwner(OwnerInputSchema.parse(fixture.input)); result = r;
        failures.push(...validateOwnerDraft({ ...r.draft, events: r.draft.events.map(e => ({ ...e, petId: e.petId ?? r.draft.pets[0].id })) }));
        const expected = fixture.expected ?? fixture.expect ?? {};
        for (const key of ['type', 'durationMin', 'petId', 'occurredAt'] as const) if (key in expected && r.draft.events[0]?.[key] !== expected[key]) failures.push(`사건 ${key} 불일치`);
        for (const flag of expected.safetyFlags ?? []) if (!r.draft.safetyFlags.includes(flag)) failures.push(`안전 신호 누락: ${flag}`);
        if (expected.safetyFlags && r.draft.safetyFlags.some(flag => !expected.safetyFlags.includes(flag))) failures.push('기대하지 않은 안전 신호');
        if (r.fallbackUsed) failures.push('수동 대체');
      } else if (file === 'briefs') {
        const r = await services.generateBrief(BriefInputSchema.parse(fixture.input)); result = r;
        if (r.fallbackUsed) failures.push('코드 집계로 대체');
        const expected = fixture.expect ?? {};
        if ('days' in expected && r.draft.period.daysWithRecords !== expected.days) failures.push('기록 일수 불일치');
        if ('walk' in expected && r.draft.facts.find(f => f.id === 'count:walk')?.value !== expected.walk) failures.push('산책 횟수 불일치');
        if ([...r.draft.summary, ...r.draft.changes, ...r.draft.questionsForOwner].some(line => !line.refs.length || line.refs.some(id => !r.draft.facts.some(f => f.id === id)))) failures.push('잘못된 사실 근거');
      } else {
        const r = await services.generateShelter(ShelterInputSchema.parse(fixture.input)); result = r;
        failures.push(...validateShelterDraft(r.draft));
        const expected = fixture.expect ?? {};
        for (const key of ['people', 'dogs', 'cats'] as const) if (key in expected && r.draft.sociability[key] !== expected[key]) failures.push(`사회성 ${key} 불일치`);
        if ('cautions' in expected && r.draft.cautions.length !== expected.cautions) failures.push('주의 관찰 수 불일치');
        if (expected.safetyFlag && !r.draft.safetyFlags.includes(expected.safetyFlag)) failures.push('안전 신호 누락');
        if (expected.introExclude && r.draft.adopterIntro.text.includes(expected.introExclude)) failures.push('금지된 소개 추론');
        if (r.fallbackUsed) failures.push('원문 규칙으로 대체');
      }
    } catch (error) { failures.push(error instanceof Error ? error.message : '요청 실패'); }
    const latencyMs = Date.now() - started;
    reports.push({ feature: file, id: fixture.id, passed: !failures.length, failures, latencyMs, result });
    console.info(`${file}/${fixture.id}: ${failures.length ? 'FAIL' : 'PASS'} ${(latencyMs / 1000).toFixed(1)}s ${failures.join(' / ')}`);
    // Persist after every case so interrupted long evaluations remain reviewable.
    await mkdir('test-output', { recursive: true });
    await writeFile(`test-output/local-${config.textModel.replace(/[^a-zA-Z0-9._-]/g, '_')}-${all ? 'all' : 'smoke'}.json`, JSON.stringify({ model: config.textModel, contextSize: config.ollamaContextSize, createdAt: new Date().toISOString(), automaticChecksOnly: true, reports }, null, 2));
  }
}
console.info(`${config.textModel}: ${reports.filter(r => r.passed).length}/${reports.length} 자동 조건 통과. 원문 누락·의미는 별도 검토가 필요합니다.`);
if (reports.some(r => !r.passed)) process.exitCode = 1;
