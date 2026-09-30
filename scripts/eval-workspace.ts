import { readFile, mkdir, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { readConfig } from '../server/config.ts';
import { createOpenAIServices } from '../server/openai.ts';
import { OwnerInputSchema } from '../server/owner-service.ts';
import { BriefInputSchema } from '../server/brief-service.ts';
import { ShelterInputSchema } from '../server/shelter-service.ts';
import { validateAudioDuration } from '../server/audio.ts';
import { computeBrief } from '../src/domain/brief.ts';
import { createManualShelterDraft, validateShelterDraft } from '../src/domain/shelter.ts';
import { validateOwnerDraft } from '../src/domain/owner-log.ts';
import type { BriefDraft, OwnerDraft, ShelterDraft } from '../src/domain/workspace-types.ts';

const args = process.argv.slice(2), live = args.includes('--live');
const options = new Map<string, string>();
for (let i = 0; i < args.length; i++) {
  if (['--live', '--help'].includes(args[i])) continue;
  if (!['--feature', '--case', '--audio-dir'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`알 수 없거나 값이 없는 인자: ${args[i]}`);
  options.set(args[i], args[++i]);
}
if (args.includes('--help')) {
  console.info('npm run llm:eval:workspace -- [--feature owner|brief|shelter|all] [--case ID] [--live] [--audio-dir PATH]');
  console.info('기본: 입력 자료와 수동 계산 검증. --live: .env 키로 OpenAI 직접 호출·비용 발생. --audio-dir는 owner의 ID.wav/webm/mp4/mp3를 받아쓴 후 테스트합니다.');
  process.exit(0);
}
const feature = options.get('--feature') || 'all';
if (!['owner', 'brief', 'shelter', 'all'].includes(feature)) throw new Error('지원하지 않는 기능입니다.');
const audioDir = options.get('--audio-dir');
if (audioDir && (!live || feature !== 'owner')) throw new Error('음성 테스트는 --feature owner --live가 필요합니다.');
const config = readConfig();
if (live && (!config.apiKey || !config.aiEnabled)) throw new Error('.env에 OPENAI_API_KEY와 AI_ENABLED=true를 설정하세요.');
const services = live ? createOpenAIServices(config) : null;
const files = audioDir ? await readdir(audioDir) : [];
const reports: Record<string, unknown>[] = [];
const specs = [
  { feature: 'owner', file: 'owner-logs', schema: OwnerInputSchema, min: 25 },
  { feature: 'brief', file: 'briefs', schema: BriefInputSchema, min: 10 },
  { feature: 'shelter', file: 'shelter-profiles', schema: ShelterInputSchema, min: 10 },
] as const;
for (const spec of specs.filter(s => feature === 'all' || s.feature === feature)) {
  const fixtures = JSON.parse(await readFile(new URL(`../fixtures/${spec.file}.json`, import.meta.url), 'utf8')) as { id: string; input: unknown; expect?: Record<string, unknown>; expected?: Record<string, unknown> }[];
  if (fixtures.length < spec.min || new Set(fixtures.map(f => f.id)).size !== fixtures.length) throw new Error(`${spec.file}: 사례 수 또는 ID 오류`);
  for (const fixture of fixtures.filter(f => !options.has('--case') || f.id === options.get('--case'))) {
    const failures: string[] = [];
    const expected = fixture.expect || fixture.expected || {};
    const check = (value: unknown, target: unknown, label: string) => { if (target !== undefined && JSON.stringify(value) !== JSON.stringify(target)) failures.push(label); };
    let result: Awaited<ReturnType<NonNullable<typeof services>['generateOwner']>> | Awaited<ReturnType<NonNullable<typeof services>['generateBrief']>> | Awaited<ReturnType<NonNullable<typeof services>['generateShelter']>> | undefined;
    try {
      if (spec.feature === 'owner') {
        const input = OwnerInputSchema.parse(fixture.input);
        if (audioDir && services) {
          const names = files.filter(name => name.startsWith(`${fixture.id}.`) && /\.(wav|webm|mp4|mp3)$/i.test(name));
          if (names.length !== 1) throw new Error('사례 ID와 같은 이름의 음성 파일이 정확히 하나 필요합니다.');
          const buffer = await readFile(path.join(audioDir, names[0]));
          if (buffer.length > 10 * 1024 * 1024) throw new Error('음성은 10MB 이하만 가능합니다.');
          try { await validateAudioDuration(buffer, config.ffprobePath); input.text = await services.transcribe(buffer, names[0], input.pets.map(p => p.name).join(', ')); input.sourceKind = 'nl_log_voice'; }
          finally { buffer.fill(0); }
        }
        if (services) {
          result = await services.generateOwner(input); const d = result.draft as OwnerDraft;
          failures.push(...validateOwnerDraft({ ...d, events: d.events.map(e => ({ ...e, petId: e.petId ?? input.pets[0].id })) }));
          for (const key of ['type', 'durationMin', 'petId', 'occurredAt'] as const) check(d.events[0]?.[key], expected[key], key);
          for (const flag of expected.safetyFlags as string[] ?? []) if (!d.safetyFlags.includes(flag)) failures.push(`안전 신호 누락: ${flag}`);
        }
      } else if (spec.feature === 'brief') {
        const input = BriefInputSchema.parse(fixture.input);
        result = services ? await services.generateBrief(input) : undefined;
        const d = (result?.draft ?? computeBrief(input)) as BriefDraft;
        check(d.period.daysWithRecords, expected.days, '기록 일수');
        check(d.facts.find(f => f.id === 'count:walk')?.value, expected.walk, '산책 횟수');
        check(d.facts.find(f => f.id === 'count:walk')?.previousValue, expected.previousWalk, '직전 산책 횟수');
        check(d.dataGaps.some(g => g.includes('기록 부족')), expected.insufficient, '부족 표시');
        if (expected.timeGap && !d.dataGaps.some(g => g.includes('시각'))) failures.push('불명확한 시각 안내 누락');
        if (expected.safetyFlag && !d.safetyFlags.includes(String(expected.safetyFlag))) failures.push('안전 신호 누락');
        if ([...d.summary, ...d.changes, ...d.questionsForOwner, ...d.previousTasks, ...d.cautions].some(line => !line.refs.length || line.refs.some(ref => !d.facts.some(f => f.id === ref)))) failures.push('존재하지 않는 근거');
      } else {
        const input = ShelterInputSchema.parse(fixture.input);
        result = services ? await services.generateShelter(input) : undefined;
        const d = (result?.draft ?? createManualShelterDraft(input)) as ShelterDraft;
        failures.push(...validateShelterDraft(d));
        for (const key of ['people', 'dogs', 'cats'] as const) check(d.sociability[key], expected[key], key);
        check(d.cautions.length, expected.cautions, '주의사항 수');
        if (expected.safetyFlag && !d.safetyFlags.includes(String(expected.safetyFlag))) failures.push('안전 신호 누락');
        if (expected.introExclude && d.adopterIntro.text.includes(String(expected.introExclude))) failures.push('소개에 금지된 추론');
      }
      if (result?.fallbackUsed) failures.push('AI 결과 검증 실패: 수동 대체');
    } catch (error) { failures.push(error instanceof Error ? error.message : '실행 실패'); }
    reports.push({ feature: spec.feature, caseId: fixture.id, passed: !failures.length, failures, ...(result ? { requestId: result.requestId, model: result.model, latencyMs: result.latencyMs, draft: result.draft } : {}) });
    console.info(`${spec.feature}/${fixture.id}: ${failures.length ? 'FAIL' : 'PASS'} ${failures.join(' / ')}`);
  }
}
if (!reports.length) throw new Error('해당 사례가 없습니다.');
if (live) {
  await mkdir('test-output', { recursive: true });
  const file = `test-output/workspace-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await writeFile(file, JSON.stringify({ live, audio: !!audioDir, reports }, null, 2));
  console.info(`상세 결과: ${file}. 원문 누락·의미·실제 사용성은 직접 검토하세요.`);
} else console.info('OpenAI 호출은 실행하지 않았습니다. owner는 입력 스키마, brief/shelter는 수동 계산도 검증했습니다.');
console.info(`통과 ${reports.filter(r => r.passed).length}/${reports.length}`);
if (reports.some(r => !r.passed)) process.exitCode = 1;
