import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig, type Config } from '../server/config.ts';
import { getLocalStatus } from '../server/local-status.ts';

/** Read-only by default. Warmup generates one synthetic draft without storing it. */
export async function checkBeta(config: Config, warmup = false): Promise<string[]> {
  const ui = new URL(config.publicOrigin);
  if (ui.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(ui.hostname) || config.production)
    throw new Error('이 PC의 HTTP 개발 화면에서 실행해 주세요. PUBLIC_ORIGIN을 확인하세요.');
  const api = `http://${config.host === '::1' ? '[::1]' : config.host}:${config.port}`;
  const status = await getLocalStatus(config);
  if (!status.configured || !status.sttReady) throw new Error(status.statusMessage);
  const lines = [`모델: ${config.textModel}`, 'Ollama·Whisper·FFmpeg 준비 완료'];
  let cookie = '';
  const call = async (base: string, endpoint: string, init: RequestInit = {}) => {
    let response: Response;
    try {
      response = await fetch(`${base}${endpoint}`, { ...init, redirect: 'error', signal: AbortSignal.timeout(warmup ? config.timeoutMs * 2 + 15000 : 20000),
        headers: { Origin: config.publicOrigin, ...(cookie ? { Cookie: cookie } : {}), ...init.headers } });
    } catch { throw new Error('로컬 화면 또는 서버에 연결할 수 없습니다. npm run dev:local 실행 상태를 확인하세요.'); }
    if (!response.ok) throw new Error(`로컬 서버 응답 HTTP ${response.status}. 화면의 연결 상태를 확인하세요.`);
    const body = await response.json().catch(() => null);
    if (!body || typeof body !== 'object') throw new Error('로컬 API 응답이 올바르지 않습니다. 개발 서버를 다시 시작하세요.');
    return { body, response };
  };
  for (const base of [api, ui.origin]) {
    const { body } = await call(base, '/api/session');
    if (body.textModel !== config.textModel) throw new Error('실행 중인 서버의 모델 설정이 현재 .env와 다릅니다. 개발 서버를 다시 시작하세요.');
    if (!body.aiEnabled || body.provider !== 'ollama' || !['ownerLog', 'brief', 'shelter'].every(key => body.features?.[key] === true))
      throw new Error('네 기능을 활성화해 주세요. npm run local:configure 후 개발 서버를 다시 시작하세요.');
    if (body.authenticated && (!body.configured || !body.sttReady)) throw new Error('실행 중인 서버의 모델·음성 준비 상태를 확인하세요.');
    if (base === api && !body.authenticated) lines.push('접근 비밀번호 사용 중: 시연 화면에서 로그인하세요.');
  }
  lines.push('로컬 API·화면 연결·네 기능 준비 완료');
  if (warmup) {
    try {
      if (config.password) {
        const login = await call(api, '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: config.password }) });
        cookie = login.response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
      }
      const started = Date.now();
      const { body } = await call(api, '/api/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '오늘 초코가 앉아를 세 번 연습했습니다.', sourceKind: 'trainer_summary_text', consent: true }) });
      if (body.fallbackUsed !== false || body.draft?.mode !== 'ollama') throw new Error('AI 예열 실패: 규칙 초안으로 대체됐습니다. 화면의 경고와 서버 상태를 확인하세요.');
      lines.push(`텍스트 AI 예열 완료: ${((Date.now() - started) / 1000).toFixed(1)}초. 가상 초안은 저장하지 않았습니다.`);
    } finally {
      if (cookie) await call(api, '/api/session', { method: 'DELETE' });
    }
  }
  lines.push('마이크 권한·실제 녹음·음성 품질은 시연 대본의 사전 점검에서 확인하세요.');
  return lines;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.includes('--help')) console.info('npm run beta:check [-- --warmup]\n기본: 읽기 전용 연결 점검. --warmup: 가상 상담 1회 생성, 일일 요청 1회 사용, 저장 없음.');
    else {
      if (args.some(arg => arg !== '--warmup')) throw new Error('지원 인자: --warmup, --help');
      console.info((await checkBeta(readConfig(), args.includes('--warmup'))).join('\n'));
    }
  } catch (error) { console.error(`시연 준비 실패: ${error instanceof Error ? error.message : '상태 확인 실패'}`); process.exitCode = 1; }
}
