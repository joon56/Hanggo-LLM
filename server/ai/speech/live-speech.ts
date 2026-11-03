import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Config } from '../../config.ts';
import { freePort } from '../free-port.ts';
import type { SpeechProvider } from './types.ts';

export type SpeechCandidate = Exclude<Config['liveSpeechModel'], 'cohere'>;
export const cohereModelPath = (config: Config) => resolve(config.liveModelDirectory, 'cohere-transcribe-03-2026-Q8_0.gguf');

export function buildSpeechCommand(config: Config, port: number, token: string) {
  const candidate = config.liveSpeechModel;
  if (candidate === 'cohere') throw new Error('Cohere Transcribe does not run through a server command.');
  const origin = `http://127.0.0.1:${port}`;
  if (candidate === 'qwen-asr') {
    const model = resolve(config.liveModelDirectory, 'Qwen3-ASR-1.7B-Q8_0.gguf');
    const projector = resolve(config.liveModelDirectory, 'mmproj-Qwen3-ASR-1.7B-Q8_0.gguf');
    const executable = resolve(config.llamaServer);
    return { executable, files: [executable, model, projector], baseUrl: origin,
      args: ['-m', model, '--mmproj', projector, '-ngl', '99', '-c', '4096', '-np', '1', '-t', '6',
        '--flash-attn', 'on', '--host', '127.0.0.1', '--port', String(port), '--api-key', token, '--no-webui', '--jinja'] };
  }
  const model = resolve(config.liveModelDirectory, 'ggml-large-v3-turbo.bin');
  const executable = resolve(config.whisperServer);
  return { executable, files: [executable, model], baseUrl: `${origin}/internal-${token}`,
    args: ['-m', model, '-l', 'ko', '-t', '6', '-bs', '5', '-bo', '5', '-nt', '--host', '127.0.0.1',
      '--port', String(port), '--request-path', `/internal-${token}`, '--public', resolve(config.home, 'runtime', 'empty-public')] };
}

export function speechInstalled(config: Config): boolean {
  try { return (config.liveSpeechModel === 'cohere' ? [cohereModelPath(config)] : buildSpeechCommand(config, 1, 'check').files).every(file => { const s = statSync(file); return s.isFile() && s.size > 0; }); }
  catch { return false; }
}

export function parseSpeechResponse(candidate: SpeechCandidate, raw: unknown): string {
  const body = raw as { text?: unknown; choices?: { finish_reason?: string; message?: { content?: unknown } }[] } | null;
  let text: unknown = body?.text;
  if (candidate === 'qwen-asr') {
    const choice = body?.choices?.[0];
    if (choice?.finish_reason !== 'stop') throw new Error('음성 모델의 응답이 끝나지 않았습니다.');
    text = choice.message?.content;
    if (typeof text === 'string') text = text.includes('<asr_text>') ? text.split('<asr_text>').slice(1).join('<asr_text>') : text;
  }
  if (typeof text !== 'string' || text.length > 8000) throw new Error('음성 모델의 응답 형식을 확인할 수 없습니다.');
  return text.replace(/<\|(?:im_end|endoftext)\|>/g, '').trim();
}

async function boundedJson(response: Response) {
  if (!response.ok || !response.body) throw new Error(`음성 모델 요청 실패 (${response.status}).`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.length;
      if (bytes > 256 * 1024) throw new Error('음성 모델의 응답이 너무 큽니다.');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function createLiveSpeech(config: Config, hooks: { unloadTextModel?: () => Promise<void> } = {}): SpeechProvider {
  let child: ChildProcess | undefined;
  let starting: Promise<void> | undefined;
  let lifetime: AbortController | undefined;
  let ready = false; let busy = false; let baseUrl = ''; let token = '';
  async function release() {
    ready = false;
    lifetime?.abort();
    const owned = child; child = undefined;
    if (owned && owned.exitCode === null) {
      await new Promise<void>(resolveExit => { owned.once('close', () => resolveExit()); owned.kill(); });
    }
  }
  return {
    async prepare() {
      if (ready) return;
      if (starting) return starting;
      if (!speechInstalled(config)) throw new Error('비교용 음성 모델과 GPU 실행기를 설치해 주세요.');
      lifetime = new AbortController();
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(config.sttTimeoutMs)]);
      starting = (async () => {
        await hooks.unloadTextModel?.(); signal.throwIfAborted();
        const port = await freePort(); signal.throwIfAborted();
        token = randomBytes(24).toString('hex');
        const command = buildSpeechCommand(config, port, token); baseUrl = command.baseUrl;
        child = spawn(command.executable, command.args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
        const owned = child;
        let failed = false;
        child.once('error', () => { failed = true; });
        child.once('close', () => { failed = true; if (child === owned) { child = undefined; ready = false; } });
        // Drain native logs. They can contain recognized speech, so do not retain or publish them.
        child.stdout?.resume(); child.stderr?.resume();
        while (true) {
          signal.throwIfAborted();
          if (failed) throw new Error('GPU 음성 실행기를 시작하지 못했습니다.');
          try {
            const response = await fetch(`${baseUrl}/health`, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]), headers: { Authorization: `Bearer ${token}` } });
            if (response.ok && (await boundedJson(response) as { status?: string }).status === 'ok') break;
          } catch { signal.throwIfAborted(); }
          await delay(100, undefined, { signal });
        }
        if (failed) throw new Error('GPU 음성 실행기가 종료되었습니다.');
        ready = true;
      })();
      try { await starting; } catch (error) { await release(); throw error; }
      finally { starting = undefined; }
    },
    async transcribe(wav, signal) {
      signal?.throwIfAborted();
      if (!ready || !lifetime || config.liveSpeechModel === 'cohere') throw new Error('음성 모델 준비가 필요합니다.');
      if (busy) throw new Error('이전 음성 구간을 처리 중입니다.');
      if (wav.length > 2.5 * 1024 * 1024) throw new Error('음성 구간이 너무 큽니다.');
      busy = true;
      const started = performance.now();
      const combined = AbortSignal.any([lifetime.signal, AbortSignal.timeout(config.sttTimeoutMs), ...(signal ? [signal] : [])]);
      try {
        let response: Response;
        if (config.liveSpeechModel === 'qwen-asr') {
          response = await fetch(`${baseUrl}/v1/chat/completions`, { method: 'POST', redirect: 'error', signal: combined,
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ temperature: 0, max_tokens: 512, stream: false,
              messages: [{ role: 'system', content: '' }, { role: 'user', content: [{ type: 'input_audio', input_audio: { data: wav.toString('base64'), format: 'wav' } }] }] }) });
        } else {
          const form = new FormData(); form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'segment.wav');
          form.append('response_format', 'json'); form.append('language', 'ko'); form.append('temperature', '0'); form.append('temperature_inc', '0');
          response = await fetch(`${baseUrl}/inference`, { method: 'POST', redirect: 'error', body: form, signal: combined });
        }
        const text = parseSpeechResponse(config.liveSpeechModel, await boundedJson(response));
        return { text, model: config.liveSpeechModel, latencyMs: Math.round(performance.now() - started) };
      } catch (error) {
        // A disconnected HTTP request may leave native GPU inference running. Terminate our helper before retry.
        await release(); throw error;
      } finally { busy = false; }
    },
    release,
  };
}
