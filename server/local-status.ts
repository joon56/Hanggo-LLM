import { statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import type { Config } from './config.ts';
import { LLM_MODELS } from './ai/llm/models.ts';
import { speechInstalled } from './live-speech.ts';

export async function getLocalStatus(config: Config) {
  const liveConsultation = { enabled: config.liveConsultationEnabled, ready: config.liveConsultationEnabled && speechInstalled(config), model: config.liveSpeechModel };
  const file = (location: string) => { try { const stat = statSync(location); return stat.isFile() && stat.size > 0; } catch { return false; } };
  const runnable = (executable: string, args: string[]) => new Promise<boolean>(resolve => {
    execFile(executable, args, { timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true }, error => resolve(!error));
  });
  const sttReady = file(config.whisperExecutable) && file(config.whisperModelPath) && (await Promise.all([
    runnable(config.ffmpegPath, ['-version']), runnable(config.ffprobePath, ['-version']), runnable(config.whisperExecutable, ['--help']),
  ])).every(Boolean);
  const model: { file: string; mmproj?: string } = LLM_MODELS[config.llmModel];
  const configured = file(config.llamaServer) && [model.file, model.mmproj].every(relative => !relative || file(path.join(config.home, relative)));
  return { configured, sttReady, liveConsultation, statusMessage: !configured ? `${config.textModel} 로컬 모델을 설치한 뒤 다시 연결해 주세요.` : !sttReady ? '텍스트 모델 준비됨 · 음성 모델과 FFmpeg 설치를 확인해 주세요.' : '로컬 텍스트·음성 실행기 준비됨' };
}
