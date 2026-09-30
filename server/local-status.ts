import { statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import type { Config } from './config.ts';
import { supportsLocalGuards } from './local-model.ts';

export async function getLocalStatus(config: Config) {
  const file = (path: string) => { try { const stat = statSync(path); return stat.isFile() && stat.size > 0; } catch { return false; } };
  const runnable = (executable: string, args: string[]) => new Promise<boolean>(resolve => {
    execFile(executable, args, { timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true }, error => resolve(!error));
  });
  const sttReady = file(config.whisperExecutable) && file(config.whisperModelPath) && (await Promise.all([
    runnable(config.ffmpegPath, ['-version']), runnable(config.ffprobePath, ['-version']), runnable(config.whisperExecutable, ['--help']),
  ])).every(Boolean);
  try {
    const version = await fetch(`${config.ollamaBaseUrl}/api/version`, { redirect: 'error', signal: AbortSignal.timeout(3000) });
    if (!version.ok || !supportsLocalGuards((await version.json()).version)) return { configured: false, sttReady, statusMessage: 'Ollama 0.34.4 이상으로 업데이트한 뒤 다시 연결해 주세요.' };
    const response = await fetch(`${config.ollamaBaseUrl}/api/tags`, { redirect: 'error', signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error('Ollama unavailable');
    const body = await response.json();
    const model = config.textModel.includes(':') ? config.textModel : `${config.textModel}:latest`;
    const configured = Array.isArray(body.models) && body.models.some((item: { name?: string; remote_host?: string; remote_model?: string }) => item.name === model && !item.remote_host && !item.remote_model);
    return { configured, sttReady, statusMessage: !configured ? `${config.textModel} 로컬 모델을 설치한 뒤 다시 연결해 주세요.` : !sttReady ? '텍스트 모델 준비됨 · 음성 모델과 FFmpeg 설치를 확인해 주세요.' : '로컬 텍스트·음성 실행기 준비됨' };
  } catch { return { configured: false, sttReady, statusMessage: 'Ollama를 실행한 뒤 다시 연결해 주세요.' }; }
}
