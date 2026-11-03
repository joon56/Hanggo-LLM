// @vitest-environment node
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { SpeechProvider } from './types.ts';
import { createUploadTranscriber } from './upload.ts';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function sandbox() {
  const directory = mkdtempSync(join(tmpdir(), 'hanggo-speech-test-'));
  directories.push(directory);
  return directory;
}
function fakeSpeech(overrides: Partial<SpeechProvider> = {}) {
  return { prepare: vi.fn(async () => {}), transcribe: vi.fn(async () => ({ text: ' 초코가 짖었어요. ', model: 'fake', latencyMs: 1 })), release: vi.fn(async () => {}), ...overrides } satisfies SpeechProvider;
}
const transcriber = (speech: SpeechProvider) => createUploadTranscriber({ speech, ffmpegPath: 'ffmpeg', timeoutMs: 5_000 });
function silence() {
  const wav = Buffer.alloc(44 + 16000 * 2 * 3);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  return wav;
}
async function withTmp<T>(directory: string, run: () => Promise<T>) {
  const original = process.env.TMP;
  process.env.TMP = directory;
  try { return await run(); }
  finally { if (original === undefined) delete process.env.TMP; else process.env.TMP = original; }
}

test('rejects an aborted request before starting tools', async () => {
  const speech = fakeSpeech();
  await expect(transcriber(speech)(Buffer.from('audio'), 'recording.webm', '초코', AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' });
  expect(speech.prepare).not.toHaveBeenCalled();
});
test('rejects undecodable audio without exposing content or leaving recordings', async () => {
  const directory = sandbox();
  await withTmp(directory, async () => {
    await expect(transcriber(fakeSpeech())(Buffer.from('PRIVATE_AUDIO_CONTENT'), 'name with spaces.webm', '초코')).rejects.toThrow('Audio conversion failed.');
    expect(readdirSync(directory)).toEqual([]);
  });
});
test('transcribes converted audio through the provider and frees the GPU afterward', async () => {
  const transcribe = vi.fn(async (_wav: Buffer) => ({ text: ' 초코가 짖었어요. ', model: 'fake', latencyMs: 1 }));
  const speech = fakeSpeech({ transcribe });
  await expect(transcriber(speech)(silence(), 'recording.wav', '초코')).resolves.toBe('초코가 짖었어요.');
  expect(transcribe.mock.calls[0][0].toString('ascii', 0, 4)).toBe('RIFF');
  expect(speech.prepare).toHaveBeenCalledTimes(1);
  expect(speech.release).toHaveBeenCalledTimes(1);
});
test('releases the provider and removes the converted WAV when inference fails', async () => {
  const directory = sandbox();
  const speech = fakeSpeech({ transcribe: vi.fn(async () => { throw new Error('native failure'); }) });
  await withTmp(directory, async () => {
    await expect(transcriber(speech)(silence(), 'recording.wav', '초코')).rejects.toThrow('Local transcription unavailable.');
    expect(readdirSync(directory)).toEqual([]);
  });
  expect(speech.release).toHaveBeenCalledTimes(1);
});
