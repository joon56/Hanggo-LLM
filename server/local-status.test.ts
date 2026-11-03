// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { LLM_MODELS } from './ai/llm/models.ts';
import { readConfig } from './config.ts';
import { getLocalStatus } from './local-status.ts';

const homes: string[] = [];
function home(files: string[]) {
  const directory = mkdtempSync(path.join(tmpdir(), 'hanggo-status-')); homes.push(directory);
  for (const relative of files) {
    const target = path.join(directory, relative);
    mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, 'x');
  }
  return directory;
}
const llm = [path.join('runtime', 'llama-cpp', 'llama-server.exe'), LLM_MODELS['gemma4-12b'].file, LLM_MODELS['gemma4-12b'].mmproj];
const speech = [path.join('models', 'stt', 'Qwen3-ASR-1.7B-Q8_0.gguf'), path.join('models', 'stt', 'mmproj-Qwen3-ASR-1.7B-Q8_0.gguf')];
afterEach(() => { for (const directory of homes.splice(0)) rmSync(directory, { recursive: true, force: true }); });

it('reports a missing local model without revealing file paths', async () => {
  const directory = home([]);
  const result = await getLocalStatus(readConfig({ HANGGO_HOME: directory }));
  expect(result.configured).toBe(false); expect(result.statusMessage).toContain('gemma4-12b');
  expect(JSON.stringify(result)).not.toContain(path.basename(directory));
});
it('allows text while reporting missing speech assets separately', async () => {
  const result = await getLocalStatus(readConfig({ HANGGO_HOME: home(llm) }));
  expect(result.configured).toBe(true); expect(result.sttReady).toBe(false);
});
it('reports speech ready when the selected model and FFmpeg exist', async () => {
  const result = await getLocalStatus(readConfig({ HANGGO_HOME: home([...llm, ...speech]) }));
  expect(result.sttReady).toBe(true);
});
it('does not mark speech ready when FFmpeg is missing despite existing speech paths', async () => {
  const status = await getLocalStatus(readConfig({ HANGGO_HOME: home([...llm, ...speech]), FFMPEG_PATH: 'missing-ffmpeg-hanggo' }));
  expect(status.sttReady).toBe(false);
});
it('checks the files of whichever speech model is selected', async () => {
  const whisper = [path.join('runtime', 'whisper-cpp', 'Release', 'whisper-server.exe'), path.join('models', 'stt', 'ggml-large-v3-turbo.bin')];
  expect((await getLocalStatus(readConfig({ HANGGO_HOME: home([...llm, ...speech]), SPEECH_MODEL: 'whisper-turbo' }))).sttReady).toBe(false);
  expect((await getLocalStatus(readConfig({ HANGGO_HOME: home([...llm, ...whisper]), SPEECH_MODEL: 'whisper-turbo' }))).sttReady).toBe(true);
});
