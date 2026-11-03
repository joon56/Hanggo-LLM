// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { LLM_MODELS } from './ai/llm/models.ts';
import { readConfig } from './config.ts';
import { getLocalStatus } from './local-status.ts';

const homes: string[] = [];
function home(withModel: boolean) {
  const directory = mkdtempSync(path.join(tmpdir(), 'hanggo-status-')); homes.push(directory);
  if (!withModel) return directory;
  const { file, mmproj } = LLM_MODELS['qwen35-9b'];
  for (const relative of [path.join('runtime', 'llama-cpp', 'llama-server.exe'), file, mmproj]) {
    const target = path.join(directory, relative);
    mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, 'x');
  }
  return directory;
}
afterEach(() => { for (const directory of homes.splice(0)) rmSync(directory, { recursive: true, force: true }); });

it('reports a missing local model without revealing file paths', async () => {
  const directory = home(false);
  const result = await getLocalStatus(readConfig({ HANGGO_HOME: directory }));
  expect(result.configured).toBe(false); expect(result.statusMessage).toContain('qwen35-9b');
  expect(JSON.stringify(result)).not.toContain(path.basename(directory));
});
it('allows text while reporting missing speech assets separately', async () => {
  const result = await getLocalStatus(readConfig({ HANGGO_HOME: home(true), WHISPER_EXECUTABLE: 'missing-executable' }));
  expect(result.configured).toBe(true); expect(result.sttReady).toBe(false);
});
it('does not mark speech ready when FFmpeg is missing despite existing speech paths', async () => {
  const status = await getLocalStatus(readConfig({ HANGGO_HOME: home(true), WHISPER_EXECUTABLE: process.execPath, WHISPER_MODEL_PATH: 'package.json', FFMPEG_PATH: 'missing-ffmpeg-hanggo' }));
  expect(status.sttReady).toBe(false);
});
