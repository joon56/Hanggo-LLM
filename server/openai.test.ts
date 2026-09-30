// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { readConfig } from './config.ts';
import { createOpenAIServices } from './openai.ts';

afterEach(() => vi.unstubAllGlobals());
it('sends masked text with strict schema and no response storage through the actual SDK', async () => {
  let body: Record<string, any> = {};
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
    body = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ id: 'resp_test', object: 'response', created_at: 1, status: 'completed',
      output: [{ type: 'message', id: 'msg_test', role: 'assistant', status: 'completed', content: [{ type: 'output_text', annotations: [], text: JSON.stringify({ items: [{ category: 'observation', sourceQuote: '앉아를 관찰했습니다.' }], safetyFlags: [], methodReview: false }) }] }] }), { headers: { 'content-type': 'application/json' } });
  }));
  const result = await createOpenAIServices(readConfig({ OPENAI_API_KEY: 'test' })).generate('연락처 010-1234-5678. 앉아를 관찰했습니다.', 'trainer_summary_text');
  expect(body.store).toBe(false);
  expect(body.text.format.strict).toBe(true);
  expect(JSON.stringify(body)).not.toContain('010-1234-5678');
  expect(result.fallbackUsed).toBe(false);
});
it('sends Korean audio with an extension to the transcription API', async () => {
  let url = ''; let form: FormData | undefined;
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init: RequestInit) => {
    url = String(input); form = init.body as FormData;
    return new Response(JSON.stringify({ text: '앉아를 관찰했습니다.' }), { headers: { 'content-type': 'application/json' } });
  }));
  const text = await createOpenAIServices(readConfig({ OPENAI_API_KEY: 'test' })).transcribe(Buffer.from('audio'), 'recording.webm', '초코');
  expect(url).toContain('/audio/transcriptions');
  expect(form?.get('language')).toBe('ko');
  expect((form?.get('file') as File).name).toBe('recording.webm');
  expect(text).toBe('앉아를 관찰했습니다.');
});

it('retains risk and retries malformed output through the real SDK response parser', async () => {
  let calls = 0;
  vi.stubGlobal('fetch', vi.fn(async () => {
    calls++;
    const extraction = calls === 1
      ? { items: [{ category: 'invalid', sourceQuote: '앉아를 관찰했습니다.' }], safetyFlags: ['통증'], methodReview: true }
      : { items: [{ category: 'observation', sourceQuote: '앉아를 관찰했습니다.' }], safetyFlags: [], methodReview: false };
    return new Response(JSON.stringify({ id: 'resp_test', object: 'response', created_at: 1, status: 'completed',
      output: [{ type: 'message', id: 'msg_test', role: 'assistant', status: 'completed', content: [{ type: 'output_text', annotations: [], text: JSON.stringify(extraction) }] }] }), { headers: { 'content-type': 'application/json' } });
  }));
  const result = await createOpenAIServices(readConfig({ OPENAI_API_KEY: 'test' })).generate('앉아를 관찰했습니다.', 'trainer_summary_text');
  expect(calls).toBe(2);
  expect(result.fallbackUsed).toBe(false);
  expect(result.draft.safetyFlags).toContain('통증');
  expect(result.draft.methodReview).toBe(true);
});
