// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { readConfig } from './config.ts';
import { getProviderStatus } from './local-status.ts';

afterEach(() => vi.unstubAllGlobals());
it('reports API text readiness without requiring Ollama', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
  const status = await getProviderStatus(readConfig({ AI_PROVIDER: 'api', GEMINI_API_KEY: 'test-g', ANTHROPIC_API_KEY: 'test-a', WHISPER_EXECUTABLE: 'missing-whisper.exe' }));
  expect(status).toMatchObject({ configured: true, sttReady: false, statusMessage: '외부 AI 텍스트(gemini-3.8-flash) 준비됨 · 음성 모델과 FFmpeg 설치를 확인해 주세요.' });
});
it('keeps the local status unchanged for the local provider', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
  expect(await getProviderStatus(readConfig({ WHISPER_EXECUTABLE: 'missing-whisper.exe' }))).toMatchObject({ configured: false, statusMessage: 'Ollama를 실행한 뒤 다시 연결해 주세요.' });
});
