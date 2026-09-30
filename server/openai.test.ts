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

it('uses strict schemas for owner logs, briefs and shelter profiles through the SDK', async () => {
  const sent: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string); sent.push(body);
    const name = body.text.format.name;
    const output = name === 'owner_log'
      ? { events: [{ petId: 'pet_0', type: 'bark', timeHint: null, durationMin: null, trigger: null, intervention: null, outcome: null, details: { amountText: null, isTreat: null, excretionKinds: [], placeText: null }, sourceQuote: '초코가 짖었어요.' }], safetyFlags: [], clarification: null }
      : name === 'owner_brief' ? { summary: ['record-days'], changes: [], questionsForOwner: [] }
      : { observations: [{ memoId: 'memo-0', sourceQuote: '사람에게 다가왔습니다.', category: 'people', valence: 'positive' }], safetyFlags: [] };
    return new Response(JSON.stringify({ id: 'resp_test', object: 'response', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }] }), { headers: { 'content-type': 'application/json' } });
  }));
  const services = createOpenAIServices(readConfig({ OPENAI_API_KEY: 'test' }));
  const pet = { id: 'choco', name: '초코', nicknames: [] };
  const owner = await services.generateOwner({ text: '010-1234-5678. 초코가 짖었어요.', pets: [pet], now: '2026-09-30T10:00:00+09:00', timeZone: 'Asia/Seoul', sourceKind: 'nl_log_text' });
  const brief = await services.generateBrief({ pet, records: [], now: '2026-09-30T10:00:00+09:00', timeZone: 'Asia/Seoul' });
  const shelter = await services.generateShelter({ animal: { id: 'dog', name: '보리', species: 'dog', ageMonths: 24 }, memos: [{ id: 'note', date: '2026-09-30', role: 'staff', text: '사람에게 다가왔습니다.' }] });
  expect([owner.fallbackUsed, brief.fallbackUsed, shelter.fallbackUsed]).toEqual([false, false, false]);
  expect(sent).toHaveLength(3);
  expect(sent.every(body => body.store === false && body.text.format.strict === true)).toBe(true);
  expect(JSON.stringify(sent)).not.toContain('010-1234-5678');
});

it.each(['refusal', 'incomplete-message', 'incomplete-response'])('discards %s even alongside valid JSON', async mode => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'resp_test', object: 'response', status: mode === 'incomplete-response' ? 'incomplete' : 'completed', output: [{ type: 'message', status: mode === 'incomplete-message' ? 'incomplete' : 'completed', content: [
    ...(mode === 'refusal' ? [{ type: 'refusal', refusal: 'Declined' }] : []),
    { type: 'output_text', text: JSON.stringify({ summary: ['record-days'], changes: [], questionsForOwner: [] }) },
  ] }] }), { headers: { 'content-type': 'application/json' } })));
  const result = await createOpenAIServices(readConfig({ OPENAI_API_KEY: 'test' })).generateBrief({ pet: { id: 'p', name: '초코', nicknames: [] }, records: [], now: '2026-09-30T00:00:00Z', timeZone: 'Asia/Seoul' });
  expect(result.fallbackUsed).toBe(true);
  expect(result.draft.mode).toBe('manual');
});
