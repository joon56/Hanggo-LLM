// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { readConfig } from './config.ts';
import { getLocalStatus } from './local-status.ts';
afterEach(() => vi.unstubAllGlobals());
it('reports a missing local model without revealing file paths', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ version: '0.34.4', models: [{ name: 'qwen2.5:3b' }] }))));
  const result = await getLocalStatus(readConfig({ AI_PROVIDER: 'ollama' }));
  expect(result.configured).toBe(false); expect(result.statusMessage).toContain('qwen3.5:9b');
  expect(JSON.stringify(result)).not.toContain('.local-ai');
});
it('allows text while reporting missing speech assets separately', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ version: '0.34.4', models: [{ name: 'qwen3.5:9b' }] }))));
  const result = await getLocalStatus(readConfig({ AI_PROVIDER: 'ollama', WHISPER_EXECUTABLE: 'missing-executable' }));
  expect(result.configured).toBe(true); expect(result.sttReady).toBe(false);
});
it('reports unavailable Ollama as unavailable, never connected', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
  expect((await getLocalStatus(readConfig({ AI_PROVIDER: 'ollama' }))).configured).toBe(false);
});
it('does not mark speech ready when FFmpeg is missing despite existing speech paths', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ version: '0.34.4', models: [{ name: 'qwen3.5:9b' }] }))));
  const status = await getLocalStatus(readConfig({ AI_PROVIDER: 'ollama', WHISPER_EXECUTABLE: process.execPath, WHISPER_MODEL_PATH: 'package.json', FFMPEG_PATH: 'missing-ffmpeg-hanggo' }));
  expect(status.sttReady).toBe(false);
});
