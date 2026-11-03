// @vitest-environment node
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { readConfig } from '../../config.ts';
import { buildSpeechCommand, createLiveSpeech, buildQwenRequest, parseSpeechResponse } from './live-speech.ts';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), stat: vi.fn(() => ({ isFile: () => true, size: 10 })) }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('node:fs', () => ({ statSync: mocks.stat }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('accepts only local speech models', () => {
  expect(readConfig({})).toMatchObject({ liveSpeechModel: 'qwen-asr' });
  expect(readConfig({ SPEECH_MODEL: 'whisper-turbo' }).liveSpeechModel).toBe('whisper-turbo');
  expect(readConfig({ SPEECH_MODEL: 'qwen-asr', LIVE_SPEECH_MODEL: 'whisper-turbo' }).liveSpeechModel).toBe('qwen-asr');
  expect(() => readConfig({ SPEECH_MODEL: 'remote-api' })).toThrow(/SPEECH_MODEL/);
  expect(() => readConfig({ LIVE_SPEECH_MODEL: 'remote-api' })).toThrow(/SPEECH_MODEL/);
});
it('constructs an isolated GPU Whisper command with a private route', () => {
  const command = buildSpeechCommand(readConfig({ LIVE_SPEECH_MODEL: 'whisper-turbo' }), 32123, 'test-token');
  expect(command.args).toContain('ko');
  expect(command.args).not.toContain('-ng');
  expect(command.args).toContain('/internal-test-token');
  expect(command.baseUrl).toBe('http://127.0.0.1:32123/internal-test-token');
  expect(command.args.join(' ')).toContain('ggml-large-v3-turbo.bin');
});
it('uses the local Qwen audio encoder and limits parallel GPU contexts', () => {
  const command = buildSpeechCommand(readConfig({ LIVE_SPEECH_MODEL: 'qwen-asr' }), 32123, 'test-token');
  expect(command.args).toContain('--mmproj');
  expect(command.args).toContain('--api-key');
  expect(command.args).toContain('--no-webui');
  expect(command.args.join(' ')).toContain('-np 1');
  expect(command.files).toHaveLength(3);
});
it('parses Qwen language markers but rejects truncated or oversized output', () => {
  const body = { choices: [{ finish_reason: 'stop', message: { content: 'language Korean<asr_text>오늘 초코는 밥을 먹지 않았습니다.' } }] };
  expect(parseSpeechResponse('qwen-asr', body)).toBe('오늘 초코는 밥을 먹지 않았습니다.');
  expect(() => parseSpeechResponse('qwen-asr', { choices: [{ ...body.choices[0], finish_reason: 'length' }] })).toThrow();
  expect(() => parseSpeechResponse('whisper-turbo', { text: 'x'.repeat(8001) })).toThrow();
  expect(parseSpeechResponse('whisper-turbo', { text: '' })).toBe('');
});
function childProcess() {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null,
    kill: vi.fn(() => { child.exitCode = 0; queueMicrotask(() => child.emit('close', 0)); return true; }) });
  return child;
}
it('reuses the prepared process and releases its own child', async () => {
  const child = childProcess(); mocks.spawn.mockReturnValue(child);
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify(init?.method === 'POST' ? { text: '안녕하세요.' } : { status: 'ok' })));
  vi.stubGlobal('fetch', fetcher);
  const speech = createLiveSpeech(readConfig({ LIVE_SPEECH_MODEL: 'whisper-turbo' }), { unloadTextModel: async () => {} });
  await speech.prepare(); await speech.prepare();
  expect(mocks.spawn).toHaveBeenCalledTimes(1);
  expect(await speech.transcribe(Buffer.from('sample'))).toMatchObject({ text: '안녕하세요.', model: 'whisper-turbo' });
  await speech.release(); expect(child.kill).toHaveBeenCalledTimes(1);
  await expect(speech.transcribe(Buffer.from('sample'))).rejects.toThrow(/준비/);
});
it('kills the owned process when an inference is cancelled', async () => {
  const child = childProcess(); mocks.spawn.mockReturnValue(child);
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method !== 'POST') return new Response('{"status":"ok"}');
    return new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }));
  }));
  const speech = createLiveSpeech(readConfig({ LIVE_SPEECH_MODEL: 'whisper-turbo' }), { unloadTextModel: async () => {} });
  await speech.prepare();
  const controller = new AbortController();
  const pending = speech.transcribe(Buffer.from('sample'), controller.signal);
  controller.abort(); await expect(pending).rejects.toThrow();
  expect(child.kill).toHaveBeenCalledTimes(1);
});
it('reports missing executables before launching a process', async () => {
  mocks.stat.mockImplementationOnce(() => { throw new Error('missing'); });
  const speech = createLiveSpeech(readConfig({ LIVE_SPEECH_MODEL: 'whisper-turbo' }), { unloadTextModel: async () => {} });
  await expect(speech.prepare()).rejects.toThrow(/설치/);
  expect(mocks.spawn).not.toHaveBeenCalled();
});
it('rejects startup failure without waiting for a second close event', async () => {
  const child = childProcess();
  child.kill.mockImplementation(() => false);
  mocks.spawn.mockImplementationOnce(() => { queueMicrotask(() => { child.emit('error', new Error('missing DLL')); child.emit('close', -1); }); return child; });
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('not listening'); }));
  const speech = createLiveSpeech(readConfig({ LIVE_SPEECH_MODEL: 'whisper-turbo' }), { unloadTextModel: async () => {} });
  await expect(speech.prepare()).rejects.toThrow(/시작/);
  await speech.release();
});

it('tells the model the language, because it guesses wrong on short sounds', () => {
  const { messages } = buildQwenRequest(Buffer.from([1, 2, 3]));
  expect(messages.at(-1)).toEqual({ role: 'assistant', content: 'language Korean<asr_text>' });
  expect(JSON.stringify(messages[1])).toContain(Buffer.from([1, 2, 3]).toString('base64'));
});
