// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { readConfig } from './config.ts';
import { createOllamaServices } from './ollama.ts';

afterEach(() => vi.unstubAllGlobals());
function stubLocalFetch(handler: typeof fetch) {
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => String(input).endsWith('/api/version')
    ? Promise.resolve(new Response(JSON.stringify({ version: '0.34.4' }))) : String(input).endsWith('/api/show')
    ? Promise.resolve(new Response(JSON.stringify({ details: { format: 'gguf' }, capabilities: ['completion'] })))
    : handler(input, init));
}
const config = () => readConfig({ AI_ENABLED: 'true' });
const extraction = { items: [{ category: 'observation', sourceQuote: '앉아를 관찰했습니다.' }], safetyFlags: [], methodReview: false };
function response(raw: unknown = extraction, extra = {}) {
  return new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(raw) }, ...extra }));
}
it('uses loopback JSON schema with thinking disabled and no credentials, preserving local provenance', async () => {
  let body: any; let url = ''; let headers: unknown;
  stubLocalFetch( vi.fn(async (input, init) => { url = String(input); body = JSON.parse(init.body); headers = init.headers; return response(); }));
  const result = await createOllamaServices(config()).generate('010-1234-5678. 앉아를 관찰했습니다.', 'trainer_summary_text');
  expect(url).toBe('http://127.0.0.1:11434/api/chat');
  expect(body).toMatchObject({ model: 'qwen3.5:9b', stream: false, think: false, format: { type: 'object', additionalProperties: false }, options: { num_ctx: 8192, temperature: 0 } });
  expect(JSON.stringify(body)).not.toContain('010-1234-5678');
  expect(body.messages[0].content).toContain(JSON.stringify(body.format));
  expect(body).toMatchObject({ truncate: false, shift: false });
  expect(JSON.stringify(headers)).not.toContain('Authorization');
  expect(result.fallbackUsed).toBe(false); expect(result.draft.mode).toBe('ollama');
});
it('never sends record contents to a locally aliased cloud model', async () => {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    calls.push(String(url));
    expect(String(init?.body)).not.toContain('PRIVATE_RECORD');
    return new Response(JSON.stringify({ version: '0.34.4', remote_host: 'https://ollama.com', remote_model: 'remote', capabilities: ['completion'] }));
  }));
  const result = await createOllamaServices(config()).generate('PRIVATE_RECORD', 'trainer_summary_text');
  expect(result.fallbackUsed).toBe(true);
  expect(calls.some(url => url.endsWith('/api/chat'))).toBe(false);
});
it('rejects older runtimes that may silently ignore context protection', async () => {
  const fetch = vi.fn(async (url) => String(url).endsWith('/api/version')
    ? new Response(JSON.stringify({ version: '0.10.0' }))
    : String(url).endsWith('/api/show')
    ? new Response(JSON.stringify({ details: { format: 'gguf' }, capabilities: ['completion'] }))
    : response());
  vi.stubGlobal('fetch', fetch);
  const result = await createOllamaServices(config()).generate('관찰했습니다.', 'trainer_summary_text');
  expect(result.fallbackUsed).toBe(true);
  expect(fetch.mock.calls.every(([url]) => String(url).endsWith('/api/version'))).toBe(true);
});
it('retries malformed JSON and preserves model risk from a truncated response', async () => {
  let count = 0;
  stubLocalFetch( vi.fn(async () => ++count === 1 ? response({ ...extraction, safetyFlags: ['통증'] }, { done_reason: 'length' }) : response()));
  const result = await createOllamaServices(config()).generate('앉아를 관찰했습니다.', 'trainer_summary_text');
  expect(count).toBe(2); expect(result.fallbackUsed).toBe(false); expect(result.draft.safetyFlags).toContain('통증');
});
it.each(['invalid JSON', 'length', 'unavailable'])('falls back without contacting cloud on %s', async failure => {
  const fetch = vi.fn(async () => failure === 'unavailable' ? new Response('', { status: 503 }) : failure === 'length' ? response(extraction, { done_reason: 'length' }) : new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { content: 'oops' } })));
  stubLocalFetch( fetch);
  const result = await createOllamaServices(config()).generate('앉아를 관찰했습니다.', 'trainer_summary_text');
  expect(result.fallbackUsed).toBe(true); expect(result.draft.mode).toBe('manual');
  expect(fetch.mock.calls.every(call => String((call as unknown[])[0]).startsWith('http://127.0.0.1:11434/'))).toBe(true);
});
it('does not start a request after cancellation', async () => {
  const fetch = vi.fn(); stubLocalFetch( fetch);
  await expect(createOllamaServices(config()).generate('관찰했습니다.', 'trainer_summary_text', AbortSignal.abort())).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
it('times out stalled local requests and returns the source for review', async () => {
  stubLocalFetch( vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }))));
  const result = await createOllamaServices(readConfig({ OLLAMA_TIMEOUT_MS: '20' })).generate('관찰했습니다.', 'trainer_summary_text');
  expect(result.fallbackUsed).toBe(true); expect(result.draft.sourceText).toBe('관찰했습니다.');
});
it('runs all workspace extractors through the same local adapter', async () => {
  stubLocalFetch( vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body); const input = JSON.parse(body.messages[1].content);
    return response(input.pets ? { events: [{ petId: 'pet_0', type: 'bark', timeHint: null, durationMin: null, trigger: null, intervention: null, outcome: null, details: { amountText: null, isTreat: null, excretionKinds: [], placeText: null }, sourceQuote: '초코가 짖었어요.' }], safetyFlags: [], clarification: null }
      : input.memos ? { observations: [{ memoId: 'memo-0', sourceQuote: '사람에게 다가왔습니다.', category: 'people', valence: 'positive' }], safetyFlags: [] }
      : { summary: ['record-days'], changes: [], questionsForOwner: [] });
  }));
  const services = createOllamaServices(config());
  const pet = { id: 'p', name: '초코', nicknames: [] }, now = '2026-09-30T10:00:00+09:00', timeZone = 'Asia/Seoul';
  const results = [await services.generateOwner({ text: '초코가 짖었어요.', pets: [pet], now, timeZone, sourceKind: 'nl_log_text' }),
    await services.generateBrief({ pet, records: [], now, timeZone }),
    await services.generateShelter({ animal: { id: 'p', name: '초코', species: 'dog', ageMonths: 24 }, memos: [{ id: 'm', date: '2026-09-30', role: 'staff', text: '사람에게 다가왔습니다.' }] })];
  expect(results.map(result => [result.fallbackUsed, result.draft.mode])).toEqual([[false, 'ollama'], [false, 'ollama'], [false, 'ollama']]);
});
it('constrains brief output to computed fact IDs and excludes unsupported changes', async () => {
  stubLocalFetch(vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body), input = JSON.parse(body.messages[1].content);
    const properties = body.format.properties;
    expect(properties.summary.items.enum).toEqual(input.facts.map((fact: { id: string }) => fact.id));
    expect(properties.questionsForOwner.items.enum).toEqual(input.facts.map((fact: { id: string }) => fact.id));
    expect(properties.changes.maxItems).toBe(0);
    return response({ summary: ['record-days'], changes: [], questionsForOwner: [] });
  }));
  const result = await createOllamaServices(config()).generateBrief({ pet: { id: 'p', name: '초코', nicknames: [] }, records: [], now: '2026-09-30T10:00:00+09:00', timeZone: 'Asia/Seoul' });
  expect(result.fallbackUsed).toBe(false);
});
it('constrains note quotations to exact source sentences, preserving decimals and spacing', async () => {
  const text = '오늘 1.5미터 거리에서 5회 중 3회 수행을 관찰했습니다.';
  let format: any;
  stubLocalFetch(vi.fn(async (_url, init) => {
    format = JSON.parse(init.body).format;
    return response({ ...extraction, items: [{ category: 'observation', sourceQuote: text }] });
  }));
  const result = await createOllamaServices(config()).generate(text, 'trainer_summary_text');
  expect(format.properties.items.items.properties.sourceQuote.enum).toEqual([text]);
  expect(result.fallbackUsed).toBe(false);
  expect(result.draft.items[0].sourceQuote).toBe(text);
});
