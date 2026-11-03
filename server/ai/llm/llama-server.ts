import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { freePort } from '../free-port.ts';
import type { LlmOutput, LlmProvider, LlmRequest } from './types.ts';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
// Loading an 18GB model from a hard drive takes minutes, not seconds.
const START_TIMEOUT_MS = 10 * 60_000;
const IDLE_SLEEP_SECONDS = 300;

type Options = { executable: string; model: string; mmproj?: string; contextSize: number; spawnProcess?: typeof spawn; fetchImpl?: typeof fetch };

export function createLlamaServer({ executable, model, mmproj, contextSize, spawnProcess = spawn, fetchImpl = fetch }: Options): LlmProvider {
  let child: ChildProcess | undefined;
  let starting: Promise<void> | undefined;
  let lifetime: AbortController | undefined;
  let baseUrl = ''; let token = '';

  async function release() {
    lifetime?.abort();
    const owned = child; child = undefined;
    if (owned && owned.exitCode === null) await new Promise<void>(resolve => { owned.once('close', () => resolve()); owned.kill(); });
  }

  function start(): Promise<void> {
    if (child) return Promise.resolve();
    starting ??= (async () => {
      lifetime = new AbortController();
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(START_TIMEOUT_MS)]);
      const port = await freePort();
      token = randomBytes(24).toString('hex');
      baseUrl = `http://127.0.0.1:${port}`;
      const args = ['-m', model, ...(mmproj ? ['--mmproj', mmproj] : []), '-c', String(contextSize), '--parallel', '1', '--host', '127.0.0.1', '--port', String(port),
        '--api-key', token, '--no-webui', '--reasoning', 'off', '--sleep-idle-seconds', String(IDLE_SLEEP_SECONDS)];
      const owned = spawnProcess(executable, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      child = owned;
      let failed = false;
      owned.once('error', () => { failed = true; });
      owned.once('close', () => { failed = true; if (child === owned) child = undefined; });
      // Drain native logs. They can contain record contents, so do not retain or publish them.
      owned.stdout?.resume(); owned.stderr?.resume();
      while (true) {
        signal.throwIfAborted();
        if (failed) throw new Error('Could not start local model server.');
        try {
          const response = await fetchImpl(`${baseUrl}/health`, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]) });
          if (response.ok && !failed) return;
          await response.body?.cancel();
        } catch { signal.throwIfAborted(); }
        await delay(200, undefined, { signal });
      }
    })().catch(async error => { await release(); throw error; }).finally(() => { starting = undefined; });
    return starting;
  }

  async function readBounded(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Local model returned no body.');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.length;
        if (size > MAX_RESPONSE_BYTES) throw new Error('Local model response too large.');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    return Buffer.concat(chunks).toString('utf8');
  }

  const untilAborted = (task: Promise<void>, signal?: AbortSignal) => !signal ? task : Promise.race([task, new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  })]);

  return {
    name: 'llama-server',
    supportsVision: !!mmproj,
    release,
    async structured(request: LlmRequest): Promise<LlmOutput> {
      request.signal?.throwIfAborted();
      if (request.images?.length && !mmproj) throw new Error('Selected model does not support vision.');
      await untilAborted(start(), request.signal);
      request.signal?.throwIfAborted();
      const user = request.images?.length ? [{ type: 'text', text: request.user },
        ...request.images.map(image => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image.toString('base64')}` } }))] : request.user;
      const response = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
        method: 'POST', redirect: 'error', signal: request.signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ temperature: 0, seed: 42, stream: false, max_tokens: request.maxTokens ?? 4096,
          response_format: { type: 'json_schema', json_schema: { name: 'output', schema: request.jsonSchema } },
          messages: [{ role: 'system', content: request.system }, { role: 'user', content: user }] }),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Local model unavailable (${response.status}).`); }
      const choice = JSON.parse(await readBounded(response)).choices?.[0];
      let json: unknown = null;
      try { json = JSON.parse(choice?.message?.content); } catch { json = null; }
      return { json, finished: choice?.finish_reason === 'stop' };
    },
  };
}
