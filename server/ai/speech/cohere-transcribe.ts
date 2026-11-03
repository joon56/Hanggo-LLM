import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { SpeechProvider, SpeechResult } from './types.ts';

// A 60-second upload at 16kHz mono is about 1.9MB.
const MAX_WAV_BYTES = 2.5 * 1024 * 1024;

type Model = { transcribe(pcm: Float32Array, options: { language: string }): Promise<{ text: string }> };
/** Cohere keeps decoding non-speech until the library stops it for repeating. Repetition carries no words to keep. */
export async function runCohere(model: Model, pcm: Float32Array, repetition: new (...args: never[]) => Error): Promise<string> {
  try { return (await model.transcribe(pcm, { language: 'ko' })).text; }
  catch (error) { if (error instanceof repetition) return ''; throw error; }
}

type Options = { modelPath: string; nativeDir?: string; cudaRuntimeDir?: string; timeoutMs: number; beforeLoad?: () => Promise<void>; forkProcess?: typeof fork };
type Message = { type: 'ready' } | { type: 'load-failed'; message: string } | { type: 'result'; id: number; text: string } | { type: 'failure'; id: number; message: string };

export function createCohereTranscribe({ modelPath, nativeDir, cudaRuntimeDir, timeoutMs, beforeLoad, forkProcess = fork }: Options): SpeechProvider {
  let child: ChildProcess | undefined;
  let starting: Promise<void> | undefined;
  let ready = false; let busy = false; let nextId = 0;
  let pending: { id: number; resolve: (text: string) => void; reject: (error: unknown) => void } | undefined;
  const fail = (error: unknown) => { const current = pending; pending = undefined; current?.reject(error); };

  async function release() {
    ready = false;
    const owned = child; child = undefined;
    fail(new Error('음성 모델을 해제했습니다.'));
    if (owned && owned.exitCode === null) await new Promise<void>(resolve => { owned.once('exit', () => resolve()); owned.kill(); });
  }

  function load() {
    return new Promise<void>((resolve, reject) => {
      const env: NodeJS.ProcessEnv = { ...process.env, HANGGO_STT_MODEL: modelPath };
      if (nativeDir) env.TRANSCRIBE_LIBRARY = path.join(nativeDir, 'transcribe.dll');
      if (cudaRuntimeDir) env.TRANSCRIBE_CUDA_RUNTIME_DIR = cudaRuntimeDir;
      // Windows resolves the native DLL's own dependencies through PATH.
      env.PATH = [cudaRuntimeDir, nativeDir, process.env.PATH].filter(Boolean).join(path.delimiter);
      // Native logs can contain recognized speech, so they are never captured.
      const owned = forkProcess(new URL('./cohere-worker.ts', import.meta.url), [], { serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true, env });
      child = owned;
      owned.on('message', (raw: unknown) => {
        const message = raw as Message;
        if (message.type === 'ready') { ready = true; resolve(); }
        else if (message.type === 'load-failed') reject(new Error(message.message));
        else if (pending?.id === message.id) {
          const current = pending; pending = undefined;
          if (message.type === 'result') current.resolve(message.text); else current.reject(new Error(message.message));
        }
      });
      owned.once('exit', () => {
        if (child === owned) { child = undefined; ready = false; }
        const error = new Error('음성 실행기가 종료되었습니다.');
        reject(error); fail(error);
      });
    });
  }

  return {
    release,
    prepare() {
      if (ready) return Promise.resolve();
      starting ??= (async () => { await beforeLoad?.(); await load(); })()
        .catch(async error => { await release(); throw error; })
        .finally(() => { starting = undefined; });
      return starting;
    },
    async transcribe(wav, signal): Promise<SpeechResult> {
      signal?.throwIfAborted();
      if (!ready || !child) throw new Error('음성 모델 준비가 필요합니다.');
      if (busy) throw new Error('이전 음성 구간을 처리 중입니다.');
      if (wav.length > MAX_WAV_BYTES) throw new Error('음성 구간이 너무 큽니다.');
      busy = true;
      const started = performance.now(); const id = ++nextId; const owned = child;
      // A cancelled native run keeps the GPU busy, so cancellation ends the worker.
      const stop = (reason: unknown) => { fail(reason); void release(); };
      const onAbort = () => stop(signal!.reason);
      const timer = setTimeout(() => stop(new Error('음성 처리 시간이 초과되었습니다.')), timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const text = await new Promise<string>((resolve, reject) => {
          pending = { id, resolve, reject };
          owned.send({ type: 'transcribe', id, wav });
        });
        return { text: text.trim(), model: 'cohere', latencyMs: Math.round(performance.now() - started) };
      } finally {
        clearTimeout(timer); signal?.removeEventListener('abort', onAbort); busy = false;
      }
    },
  };
}
