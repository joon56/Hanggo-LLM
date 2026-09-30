import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalTranscriber } from './local-speech.ts';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function sandbox() {
  const directory = mkdtempSync(join(tmpdir(), 'hanggo-speech-test-'));
  directories.push(directory);
  return directory;
}

function transcriber(directory: string, timeoutMs = 5_000) {
  return createLocalTranscriber({
    executable: join(directory, 'missing-whisper.exe'),
    modelPath: join(directory, 'missing-model.bin'),
    ffmpegPath: 'ffmpeg',
    timeoutMs,
  });
}

test('rejects an aborted request before starting tools', async () => {
  const controller = new AbortController();
  controller.abort();
  const directory = sandbox();
  await expect(transcriber(directory)(Buffer.from('audio'), 'recording.webm', '초코', controller.signal))
    .rejects.toMatchObject({ name: 'AbortError' });
});

test('rejects undecodable audio without exposing content or leaving recordings', async () => {
  const directory = sandbox();
  const originalTmp = process.env.TMP;
  process.env.TMP = directory;
  try {
    await expect(transcriber(directory)(Buffer.from('PRIVATE_AUDIO_CONTENT'), 'name with spaces.webm', '초코'))
      .rejects.toThrow('Audio conversion failed.');
    expect(readdirSync(directory)).toEqual([]);
  } finally {
    if (originalTmp === undefined) delete process.env.TMP;
    else process.env.TMP = originalTmp;
  }
});

test('rejects unavailable inference executable and removes converted WAV', async () => {
  const directory = sandbox();
  const originalTmp = process.env.TMP;
  process.env.TMP = directory;
  try {
    const silence = Buffer.alloc(44 + 16000 * 2 * 3);
    silence.write('RIFF', 0); silence.writeUInt32LE(silence.length - 8, 4);
    silence.write('WAVEfmt ', 8); silence.writeUInt32LE(16, 16);
    silence.writeUInt16LE(1, 20); silence.writeUInt16LE(1, 22);
    silence.writeUInt32LE(16000, 24); silence.writeUInt32LE(32000, 28);
    silence.writeUInt16LE(2, 32); silence.writeUInt16LE(16, 34);
    silence.write('data', 36); silence.writeUInt32LE(silence.length - 44, 40);
    await expect(transcriber(directory)(silence, 'recording.wav', '초코'))
      .rejects.toThrow('Local transcription unavailable.');
    expect(readdirSync(directory)).toEqual([]);
  } finally {
    if (originalTmp === undefined) delete process.env.TMP;
    else process.env.TMP = originalTmp;
  }
});
