// @vitest-environment node
import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { createCohereTranscribe, runCohere } from './cohere-transcribe.ts';

function fakeWorker(reply: (message: any, child: any) => void = (message, child) => child.emit('message', { type: 'result', id: message.id, text: ' 초코가 앉았습니다. ' })) {
  const child: any = Object.assign(new EventEmitter(), { exitCode: null as number | null, connected: true,
    send: vi.fn((message: any) => queueMicrotask(() => reply(message, child))),
    kill: vi.fn(() => { child.exitCode = 0; child.connected = false; queueMicrotask(() => child.emit('exit', 0)); return true; }) });
  return child;
}
function harness(child = fakeWorker(), options: { beforeLoad?: () => Promise<void>; timeoutMs?: number } = {}) {
  const forkProcess = vi.fn(() => { queueMicrotask(() => child.emit('message', { type: 'ready' })); return child; });
  const provider = createCohereTranscribe({ modelPath: 'model.gguf', nativeDir: 'native', cudaRuntimeDir: 'runtime', timeoutMs: 1000, forkProcess: forkProcess as never, ...options });
  return { provider, forkProcess, child };
}

it('loads the model in an isolated worker and shares one load across calls', async () => {
  const { provider, forkProcess } = harness();
  await Promise.all([provider.prepare(), provider.prepare()]);
  await provider.prepare();
  expect(forkProcess).toHaveBeenCalledTimes(1);
  const options = (forkProcess.mock.calls[0] as unknown as [unknown, unknown, { env: NodeJS.ProcessEnv; serialization: string }])[2];
  expect(options.serialization).toBe('advanced');
  expect(options.env).toMatchObject({ HANGGO_STT_MODEL: 'model.gguf', TRANSCRIBE_CUDA_RUNTIME_DIR: 'runtime' });
  expect(options.env.TRANSCRIBE_LIBRARY).toMatch(/native[\\/]transcribe\.dll$/);
  expect(options.env.PATH?.startsWith('runtime')).toBe(true);
});
it('frees the text model before loading', async () => {
  const order: string[] = [];
  const child = fakeWorker();
  const forkProcess = vi.fn(() => { order.push('fork'); queueMicrotask(() => child.emit('message', { type: 'ready' })); return child; });
  const provider = createCohereTranscribe({ modelPath: 'm', nativeDir: 'n', cudaRuntimeDir: 'r', timeoutMs: 1000, forkProcess: forkProcess as never, beforeLoad: async () => { order.push('unload'); } });
  await provider.prepare();
  expect(order).toEqual(['unload', 'fork']);
});
it('returns trimmed text with the model name and latency', async () => {
  const { provider } = harness();
  await provider.prepare();
  const result = await provider.transcribe(Buffer.from('wav'));
  expect(result).toMatchObject({ text: '초코가 앉았습니다.', model: 'cohere' });
  expect(result.latencyMs).toBeGreaterThanOrEqual(0);
});
it('requires preparation before transcribing', async () => {
  await expect(harness().provider.transcribe(Buffer.from('wav'))).rejects.toThrow(/준비/);
});
it('rejects overlapping requests instead of queueing inside the provider', async () => {
  const { provider } = harness(fakeWorker(() => {}));
  await provider.prepare();
  const first = provider.transcribe(Buffer.from('wav'));
  await expect(provider.transcribe(Buffer.from('wav'))).rejects.toThrow(/처리 중/);
  await provider.release();
  await expect(first).rejects.toThrow();
});
it('rejects oversized audio', async () => {
  const { provider } = harness();
  await provider.prepare();
  await expect(provider.transcribe(Buffer.alloc(3 * 1024 * 1024))).rejects.toThrow(/너무 큽니다/);
});
it('surfaces worker errors without exposing them as text', async () => {
  const { provider } = harness(fakeWorker((message, child) => child.emit('message', { type: 'failure', id: message.id, message: 'native failure' })));
  await provider.prepare();
  await expect(provider.transcribe(Buffer.from('wav'))).rejects.toThrow('native failure');
});
it('kills the worker when a request is cancelled so native inference cannot linger', async () => {
  const { provider, child } = harness(fakeWorker(() => {}));
  await provider.prepare();
  const controller = new AbortController();
  const pending = provider.transcribe(Buffer.from('wav'), controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow();
  expect(child.kill).toHaveBeenCalled();
});
it('kills the worker on timeout', async () => {
  const { provider, child } = harness(fakeWorker(() => {}), { timeoutMs: 5 });
  await provider.prepare();
  await expect(provider.transcribe(Buffer.from('wav'))).rejects.toThrow(/시간/);
  expect(child.kill).toHaveBeenCalled();
});
it('fails pending work when the worker exits and restarts on the next prepare', async () => {
  const first = fakeWorker(() => {});
  const second = fakeWorker();
  const children = [first, second];
  const forkProcess = vi.fn(() => { const child = children.shift()!; queueMicrotask(() => child.emit('message', { type: 'ready' })); return child; });
  const provider = createCohereTranscribe({ modelPath: 'm', nativeDir: 'n', cudaRuntimeDir: 'r', timeoutMs: 1000, forkProcess: forkProcess as never });
  await provider.prepare();
  const pending = provider.transcribe(Buffer.from('wav'));
  first.exitCode = 1; first.emit('exit', 1);
  await expect(pending).rejects.toThrow(/종료/);
  await provider.prepare();
  await expect(provider.transcribe(Buffer.from('wav'))).resolves.toMatchObject({ text: '초코가 앉았습니다.' });
});
it('reports load failure and allows a retry', async () => {
  const bad = fakeWorker();
  const good = fakeWorker();
  let call = 0;
  const forkProcess = vi.fn(() => {
    const child = call++ === 0 ? bad : good;
    queueMicrotask(() => child.emit('message', child === bad ? { type: 'load-failed', message: 'no CUDA' } : { type: 'ready' }));
    return child;
  });
  const provider = createCohereTranscribe({ modelPath: 'm', nativeDir: 'n', cudaRuntimeDir: 'r', timeoutMs: 1000, forkProcess: forkProcess as never });
  await expect(provider.prepare()).rejects.toThrow('no CUDA');
  await expect(provider.prepare()).resolves.toBeUndefined();
});
it('release kills the worker and transcription then needs preparation', async () => {
  const { provider, child } = harness();
  await provider.prepare();
  await provider.release();
  expect(child.kill).toHaveBeenCalled();
  await expect(provider.transcribe(Buffer.from('wav'))).rejects.toThrow(/준비/);
});

class OutputRepetition extends Error {}
it('treats repetition on non-speech as an empty transcript', async () => {
  const model = { transcribe: vi.fn(async () => { throw new OutputRepetition('run stopped'); }) };
  await expect(runCohere(model, new Float32Array(1), OutputRepetition)).resolves.toBe('');
});
it('passes Korean and rethrows other failures', async () => {
  const model = { transcribe: vi.fn(async () => ({ text: '안녕하세요' })) };
  await expect(runCohere(model, new Float32Array(1), OutputRepetition)).resolves.toBe('안녕하세요');
  expect(model.transcribe).toHaveBeenCalledWith(expect.any(Float32Array), { language: 'ko' });
  const failing = { transcribe: vi.fn(async () => { throw new Error('out of memory'); }) };
  await expect(runCohere(failing, new Float32Array(1), OutputRepetition)).rejects.toThrow('out of memory');
});
