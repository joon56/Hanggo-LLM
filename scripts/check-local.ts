import { spawnSync } from 'node:child_process';
import { readConfig } from '../server/config.ts';
import { getLocalStatus } from '../server/local-status.ts';

const config = readConfig({ ...process.env, AI_PROVIDER: 'ollama' });
const status = await getLocalStatus(config);
console.info(`텍스트 모델: ${config.textModel}\n${status.statusMessage}`);
console.info(`음성 모델 파일: ${status.sttReady ? '준비됨' : '설치 필요'}`);
let ready = status.configured && status.sttReady;
for (const [label, executable] of [['FFmpeg', config.ffmpegPath], ['ffprobe', config.ffprobePath]]) {
  const result = spawnSync(executable, ['-version'], { windowsHide: true, timeout: 5000, stdio: 'ignore' });
  const ok = result.status === 0; ready &&= ok;
  console.info(`${label}: ${ok ? '준비됨' : '실행 파일을 확인하세요'}`);
}
console.info('실제 추출 품질: npm run llm:eval:local / 화면: npm run dev:local');
if (!ready) process.exitCode = 1;
