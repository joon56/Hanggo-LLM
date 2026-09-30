import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type LocalSpeechOptions = {
  executable: string;
  modelPath: string;
  ffmpegPath: string;
  timeoutMs: number;
};

type Result = 'ok' | 'failed' | 'unavailable' | 'timeout' | 'output-limit';

async function run(executable: string, args: string[], input: Buffer | undefined,
  signal: AbortSignal | undefined, timeoutMs: number): Promise<Result> {
  signal?.throwIfAborted();
  return new Promise<Result>((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let result: Result = 'failed';
    let outputBytes = 0;
    let cancelled = false;
    const abort = () => { cancelled = true; child.kill(); };
    const timer = setTimeout(() => { result = 'timeout'; child.kill(); }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', () => { result = 'unavailable'; });
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > 64 * 1024) { result = 'output-limit'; child.kill(); }
      });
    }
    child.stdin.on('error', () => { /* Invalid input can close stdin early. Exit code decides result. */ });
    child.on('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (cancelled || signal?.aborted) reject(new DOMException('Local transcription cancelled.', 'AbortError'));
      else resolve(result === 'failed' && code === 0 ? 'ok' : result);
    });
    child.stdin.end(input);
    if (signal?.aborted) abort();
  });
}

export function createLocalTranscriber(options: LocalSpeechOptions) {
  return async (buffer: Buffer, _filename: string, _petName: string, signal?: AbortSignal): Promise<string> => {
    signal?.throwIfAborted();
    const directory = await mkdtemp(join(tmpdir(), 'hanggo-speech-'));
    const wavPath = join(directory, 'audio.wav');
    const outputPath = join(directory, 'transcript');
    try {
      const converted = await run(options.ffmpegPath, [
        '-v', 'error', '-nostdin', '-y', '-protocol_whitelist', 'pipe',
        '-format_whitelist', 'matroska,webm,wav,mov,mp3', '-i', 'pipe:0',
        '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', wavPath,
      ], buffer, signal, options.timeoutMs);
      if (converted !== 'ok') throw new Error('Audio conversion failed.');
      const inferred = await run(options.executable, [
        '-m', options.modelPath, '-f', wavPath, '-l', 'ko', '-otxt', '-of', outputPath,
        '-np', '-nt', '-ng',
      ], undefined, signal, options.timeoutMs);
      if (inferred !== 'ok') throw new Error('Local transcription unavailable.');
      return (await readFile(`${outputPath}.txt`, 'utf8')).trim();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
}
