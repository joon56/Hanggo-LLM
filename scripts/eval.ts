import { readFile, mkdir, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { Fixture, evaluateDraft } from './evaluation.ts';
import type { Draft } from '../src/domain/notes.ts';

const args = process.argv.slice(2);
const live = args.includes('--live');
const value = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const known = new Set(['--live', '--case', '--audio-dir', '--base-url', '--help']);
for (let i = 0; i < args.length; i++) {
  if (!known.has(args[i])) throw new Error(`알 수 없는 인자: ${args[i]}`);
  if (['--case', '--audio-dir', '--base-url'].includes(args[i])) {
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`값이 필요합니다: ${args[i]}`);
    i++;
  }
}
if (args.includes('--help')) {
  console.info('npm run llm:eval [-- --live] [--case N01] [--audio-dir test-audio] [--base-url http://127.0.0.1:3001]');
  console.info('기본: 30개 테스트 자료 검증만 수행. --live: 설정한 AI 호출(OpenAI는 비용 발생, Ollama는 로컬 처리). 음성 파일 N01.wav/webm/mp4/mp3와 같은 이름을 사용하세요.');
  process.exit(0);
}
const fixtures = z.array(Fixture).parse(JSON.parse(await readFile(new URL('../fixtures/session-notes.json', import.meta.url), 'utf8')));
if (fixtures.length !== 30 || new Set(fixtures.map(item => item.id)).size !== 30) throw new Error('서로 다른 30개 테스트 사례가 필요합니다.');
const cases = value('--case') ? fixtures.filter(item => item.id === value('--case')) : fixtures;
if (!cases.length) throw new Error('해당 테스트 사례가 없습니다.');
if (!live) { console.info(`자료 검증 완료: ${fixtures.length}개 사례. 실제 AI 호출·품질 검증은 실행하지 않았습니다.`); process.exit(0); }
const base = value('--base-url') || 'http://127.0.0.1:3001';
const baseUrl = new URL(base);
if (baseUrl.protocol !== 'https:' && !(baseUrl.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(baseUrl.hostname))) throw new Error('원격 테스트는 HTTPS 주소를 사용하세요.');
const origin = process.env.PUBLIC_ORIGIN || 'http://127.0.0.1:5173';
let cookie = '';
async function call(endpoint: string, init: RequestInit = {}) {
  const response = await fetch(new URL(endpoint, baseUrl), { ...init, redirect: 'error', signal: AbortSignal.timeout(600_000),
    headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...init.headers } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return { body, response };
}
const { body: session } = await call('/api/session');
if (!session.aiEnabled || !session.configured) throw new Error('서버의 AI 공급사 설정과 AI_ENABLED=true를 확인하고 서버를 다시 시작하세요.');
if (session.requirePassword) {
  if (!process.env.APP_ACCESS_PASSWORD) throw new Error('평가 환경에 APP_ACCESS_PASSWORD가 필요합니다.');
  const login = await call('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: process.env.APP_ACCESS_PASSWORD }) });
  cookie = login.response.headers.getSetCookie().map(item => item.split(';')[0]).join('; ');
}
const audioDir = value('--audio-dir');
const audioFiles = audioDir ? await readdir(audioDir) : [];
const reports: Record<string, unknown>[] = [];
for (const fixture of cases) {
  let transcript: string | undefined;
  let sttMs: number | undefined;
  let sttTermsMissing: string[] = [];
  const started = Date.now();
  try {
    if (audioDir) {
      const names = audioFiles.filter(name => name.startsWith(`${fixture.id}.`) && /\.(webm|mp4|wav|mp3)$/i.test(name));
      if (names.length !== 1) throw new Error(`${fixture.id} 음성 파일이 정확히 하나 필요합니다.`);
      const file = await readFile(path.join(audioDir, names[0]));
      const form = new FormData(); form.set('audio', new Blob([file]), names[0]);
      // Actual duration is measured and enforced by the server; the field is a nominal capture bound.
      form.set('duration', '60'); form.set('petName', '초코, 보리, 두부'); form.set('consent', 'true');
      const result = await call('/api/transcribe', { method: 'POST', body: form });
      transcript = result.body.text; sttMs = result.body.latencyMs;
      sttTermsMissing = fixture.keyTerms.filter(term => !transcript!.replace(/\s/g, '').includes(term.replace(/\s/g, '')));
      await new Promise(resolve => setTimeout(resolve, 2200));
    }
    const { body } = await call('/api/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: transcript || fixture.text, sourceKind: transcript ? 'trainer_summary_voice' : 'trainer_summary_text', consent: true }) });
    const failures = evaluateDraft(body.draft as Draft, fixture.expect, body.fallbackUsed);
    if (sttTermsMissing.length) failures.push(`받아쓰기 핵심어 확인 필요: ${sttTermsMissing.join(', ')}`);
    reports.push({ caseId: fixture.id, passed: failures.length === 0, failures, requestId: body.requestId, model: body.model,
      promptVersion: body.draft.generation?.promptVersion, latencyMs: body.latencyMs, totalMs: Date.now() - started, sttMs, sttTermsMissing, transcript, draft: body.draft });
    console.info(`${fixture.id}: ${failures.length ? 'FAIL' : 'PASS'} ${failures.join(' / ')}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : '실행 실패';
    reports.push({ caseId: fixture.id, passed: false, failures: [message], transcript });
    console.info(`${fixture.id}: FAIL ${message}`);
  }
  if (fixture !== cases.at(-1)) await new Promise(resolve => setTimeout(resolve, 2200));
}
await mkdir('test-output', { recursive: true });
const output = path.join('test-output', `evaluation-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
await writeFile(output, JSON.stringify({ kind: audioDir ? 'audio-and-text' : 'text', createdAt: new Date().toISOString(), reports }, null, 2), 'utf8');
console.info(`통과 ${reports.filter(item => item.passed).length}/${reports.length}. 상세: ${output}`);
console.info('통과는 자동 기대 조건 기준입니다. 원문 누락·의미·실제 사용성은 사람 검토가 필요합니다.');
if (reports.some(item => !item.passed)) process.exitCode = 1;
