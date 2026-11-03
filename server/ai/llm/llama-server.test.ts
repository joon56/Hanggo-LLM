// @vitest-environment node
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { createLlamaServer } from './llama-server.ts';

function fakeChild() {
  const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => { child.exitCode = 0; child.emit('close', 0); return true; }) });
  return child;
}
const completion = (content: unknown, finish = 'stop') => Response.json({ choices: [{ finish_reason: finish, message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] });
function harness(chat: (body: any, init: RequestInit) => Response | Promise<Response> = () => completion({ ok: true }), options: { mmproj?: string } = {}) {
  const children: ReturnType<typeof fakeChild>[] = [];
  const spawnProcess = vi.fn(() => { const child = fakeChild(); children.push(child); return child; });
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => String(url).endsWith('/health') ? Response.json({ status: 'ok' }) : chat(JSON.parse(String(init?.body)), init!));
  const provider = createLlamaServer({ executable: 'llama-server.exe', model: 'model.gguf', contextSize: 8192, ...options, spawnProcess: spawnProcess as never, fetchImpl: fetchImpl as never });
  return { provider, spawnProcess, fetchImpl, children };
}
const request = { jsonSchema: { type: 'object' }, system: '규칙', user: '입력' };

it('starts a loopback server with a random key, no web UI, and thinking off', async () => {
  const { provider, spawnProcess } = harness();
  await provider.structured(request);
  const [executable, args, options] = spawnProcess.mock.calls[0] as unknown as [string, string[], { shell: boolean; windowsHide: boolean }];
  expect(executable).toBe('llama-server.exe');
  expect(args).toEqual(expect.arrayContaining(['-m', 'model.gguf', '-c', '8192', '--host', '127.0.0.1', '--no-webui', '--reasoning', 'off', '--parallel', '1']));
  expect(args[args.indexOf('--api-key') + 1]).toMatch(/^[0-9a-f]{48}$/);
  expect(args).not.toContain('--mmproj');
  expect(options).toMatchObject({ shell: false, windowsHide: true });
});
it('passes the projector only when configured and reports vision support from it', async () => {
  expect(harness().provider.supportsVision).toBe(false);
  const { provider, spawnProcess } = harness(undefined, { mmproj: 'projector.gguf' });
  expect(provider.supportsVision).toBe(true);
  await provider.structured(request);
  const args = (spawnProcess.mock.calls[0] as unknown as [string, string[]])[1];
  expect(args[args.indexOf('--mmproj') + 1]).toBe('projector.gguf');
});
it('sends an authenticated schema request with fixed sampling and returns parsed output', async () => {
  let body: any; let init: RequestInit | undefined;
  const { provider, spawnProcess, fetchImpl } = harness((value, options) => { body = value; init = options; return completion({ answer: 1 }); });
  await expect(provider.structured({ ...request, maxTokens: 512 })).resolves.toEqual({ json: { answer: 1 }, finished: true });
  const args = (spawnProcess.mock.calls[0] as unknown as [string, string[]])[1];
  const url = String(fetchImpl.mock.calls.at(-1)![0]);
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1\/chat\/completions$/);
  expect(new Headers(init!.headers).get('Authorization')).toBe(`Bearer ${args[args.indexOf('--api-key') + 1]}`);
  expect(body).toMatchObject({ temperature: 0, seed: 42, stream: false, max_tokens: 512, response_format: { type: 'json_schema', json_schema: { schema: request.jsonSchema } } });
  expect(body.messages).toEqual([{ role: 'system', content: '규칙' }, { role: 'user', content: '입력' }]);
  expect(init!.redirect).toBe('error');
});
it('encodes images as data URIs when a projector exists', async () => {
  let body: any;
  const { provider } = harness(value => { body = value; return completion({}); }, { mmproj: 'projector.gguf' });
  await provider.structured({ ...request, images: [Buffer.from('jpeg-bytes')] });
  expect(body.messages[1].content).toEqual([{ type: 'text', text: '입력' }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${Buffer.from('jpeg-bytes').toString('base64')}` } }]);
});
it('refuses images without a projector before starting the model', async () => {
  const { provider, spawnProcess } = harness();
  await expect(provider.structured({ ...request, images: [Buffer.from('x')] })).rejects.toThrow(/vision/i);
  expect(spawnProcess).not.toHaveBeenCalled();
});
it('reports truncated output as unfinished while keeping parseable JSON', async () => {
  const { provider } = harness(() => completion({ safetyFlags: ['통증'] }, 'length'));
  await expect(provider.structured(request)).resolves.toEqual({ json: { safetyFlags: ['통증'] }, finished: false });
});
it('returns null JSON for malformed content instead of throwing', async () => {
  const { provider } = harness(() => completion('not json'));
  await expect(provider.structured(request)).resolves.toEqual({ json: null, finished: true });
});
it('rejects error statuses', async () => {
  const { provider } = harness(() => new Response('', { status: 503 }));
  await expect(provider.structured(request)).rejects.toThrow('503');
});
it('rejects oversized responses', async () => {
  const { provider } = harness(() => new Response('x'.repeat(2 * 1024 * 1024 + 1)));
  await expect(provider.structured(request)).rejects.toThrow(/too large/i);
});
it('does not start after cancellation', async () => {
  const { provider, spawnProcess } = harness();
  await expect(provider.structured({ ...request, signal: AbortSignal.abort() })).rejects.toThrow();
  expect(spawnProcess).not.toHaveBeenCalled();
});
it('shares one process across concurrent calls', async () => {
  const { provider, spawnProcess } = harness();
  await Promise.all([provider.structured(request), provider.structured(request)]);
  expect(spawnProcess).toHaveBeenCalledTimes(1);
});
it('releases the process and starts a new one on the next call', async () => {
  const { provider, spawnProcess, children } = harness();
  await provider.structured(request);
  await provider.release();
  expect(children[0].kill).toHaveBeenCalled();
  await provider.structured(request);
  expect(spawnProcess).toHaveBeenCalledTimes(2);
});
it('restarts after the process exits on its own', async () => {
  const { provider, spawnProcess, children } = harness();
  await provider.structured(request);
  children[0].exitCode = 1; children[0].emit('close', 1);
  await provider.structured(request);
  expect(spawnProcess).toHaveBeenCalledTimes(2);
});
it('fails when the process exits during startup and retries on the next call', async () => {
  const children: ReturnType<typeof fakeChild>[] = [];
  const spawnProcess = vi.fn(() => {
    const child = fakeChild(); children.push(child);
    if (children.length === 1) setImmediate(() => { child.exitCode = 1; child.emit('close', 1); });
    return child;
  });
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    if (!String(url).endsWith('/health')) return completion({ ok: true });
    if (children.length === 1) throw new Error('connection refused');
    return Response.json({ status: 'ok' });
  });
  const provider = createLlamaServer({ executable: 'llama-server.exe', model: 'model.gguf', contextSize: 8192, spawnProcess: spawnProcess as never, fetchImpl: fetchImpl as never });
  await expect(provider.structured(request)).rejects.toThrow(/start/i);
  await expect(provider.structured(request)).resolves.toMatchObject({ finished: true });
  expect(spawnProcess).toHaveBeenCalledTimes(2);
});
