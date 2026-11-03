import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { loadLocalEnv, readConfig } from '../server/config.ts';
import { ensurePassword, parseTunnelUrl } from './tunnel-lib.ts';

// Opens this PC's app to the internet for a live demo. Usage: npm.cmd run demo:tunnel [-- hours]
loadLocalEnv();
const home = path.resolve(readConfig().home);
const port = Number(process.env.DEMO_PORT ?? 3001);
const hours = Number(process.argv[2] ?? 4);
mkdirSync(home, { recursive: true });
const { password, created } = ensurePassword(path.join(home, 'secrets.env'), process.env);

console.info('화면을 빌드합니다.');
execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', '-s', 'build'], { stdio: 'inherit', shell: process.platform === 'win32' });

const children: ChildProcess[] = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill();
  process.exitCode = code;
  setTimeout(() => process.exit(code), 1000).unref();
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

const tunnel = spawn(path.join(home, 'runtime', 'cloudflared', 'cloudflared.exe'), ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
children.push(tunnel);
tunnel.once('error', () => { console.error('cloudflared를 실행하지 못했습니다. scripts/setup-models.ps1을 먼저 실행해 주세요.'); stop(1); });
tunnel.once('exit', () => { if (!stopping) { console.error('터널이 닫혔습니다.'); stop(1); } });

let started = false;
function onOutput(chunk: Buffer) {
  const url = parseTunnelUrl(String(chunk));
  if (!url || started) return;
  started = true;
  const server = spawn(process.execPath, ['--env-file-if-exists=.env', 'server/index.ts'], { stdio: 'inherit', windowsHide: true,
    env: { ...process.env, NODE_ENV: 'production', HANGGO_PROFILE: 'tunnel', HOST: '127.0.0.1', PORT: String(port), PUBLIC_ORIGIN: url, APP_ACCESS_PASSWORD: password } });
  children.push(server);
  server.once('exit', () => { if (!stopping) { console.error('서버가 종료되었습니다.'); stop(1); } });
  console.info(`\n이 PC의 앱이 인터넷에 열렸습니다. ${hours}시간 뒤 자동으로 닫힙니다. 끝내려면 Ctrl+C를 누르세요.`);
  console.info(`훈련사 주소: ${url}/coaching`);
  console.info(created ? `접근 비밀번호를 새로 만들었습니다: ${password}\n이 값은 ${path.join(home, 'secrets.env')}에 저장되었습니다.` : `접근 비밀번호는 ${path.join(home, 'secrets.env')}에 있습니다.`);
  console.info(`중계 서버: ${process.env.TURN_URLS ? '설정됨' : '없음. 다른 네트워크끼리는 연결이 실패할 수 있습니다.'}\n`);
}
tunnel.stdout.on('data', onOutput);
tunnel.stderr.on('data', onOutput);
setTimeout(() => { console.info('시간이 지나 터널을 닫습니다.'); stop(); }, hours * 60 * 60 * 1000).unref();
setTimeout(() => { if (!started) { console.error('터널 주소를 받지 못했습니다. 네트워크를 확인해 주세요.'); stop(1); } }, 60_000).unref();
