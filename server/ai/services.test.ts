// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { readConfig } from '../config.ts';
import type { LlmOutput, LlmProvider, LlmRequest } from './llm/types.ts';
import { createAiServices } from './services.ts';

const config = () => readConfig({ AI_ENABLED: 'true' });
const extraction = { items: [{ category: 'observation', sourceQuote: '앉아를 관찰했습니다.' }], safetyFlags: [], methodReview: false };
function fakeLlm(handler: (request: LlmRequest) => LlmOutput | Promise<LlmOutput> = () => ({ json: extraction, finished: true })) {
  return { name: 'fake', supportsVision: false, structured: vi.fn(async (request: LlmRequest) => handler(request)), release: vi.fn(async () => {}) } satisfies LlmProvider;
}
it('sends the schema and masked input through the provider, preserving local provenance', async () => {
  const llm = fakeLlm();
  const result = await createAiServices(config(), llm).generate('010-1234-5678. 앉아를 관찰했습니다.', 'trainer_summary_text');
  const request = llm.structured.mock.calls[0][0];
  expect(request.jsonSchema).toMatchObject({ type: 'object', additionalProperties: false });
  expect(request.user).not.toContain('010-1234-5678');
  expect(request.system).toContain(JSON.stringify(request.jsonSchema));
  expect(result.fallbackUsed).toBe(false); expect(result.draft.mode).toBe('ollama');
});
it('retries malformed JSON and preserves model risk from a truncated response', async () => {
  let count = 0;
  const llm = fakeLlm(() => ++count === 1 ? { json: { ...extraction, safetyFlags: ['통증'] }, finished: false } : { json: extraction, finished: true });
  const result = await createAiServices(config(), llm).generate('앉아를 관찰했습니다.', 'trainer_summary_text');
  expect(count).toBe(2); expect(result.fallbackUsed).toBe(false); expect(result.draft.safetyFlags).toContain('통증');
});
it.each(['invalid JSON', 'length', 'unavailable'])('falls back to manual review on %s', async failure => {
  const llm = fakeLlm(() => {
    if (failure === 'unavailable') throw new Error('Local model unavailable (503).');
    return failure === 'length' ? { json: extraction, finished: false } : { json: null, finished: true };
  });
  const result = await createAiServices(config(), llm).generate('앉아를 관찰했습니다.', 'trainer_summary_text');
  expect(result.fallbackUsed).toBe(true); expect(result.draft.mode).toBe('manual');
});
it('does not start a request after cancellation', async () => {
  const llm = fakeLlm();
  await expect(createAiServices(config(), llm).generate('관찰했습니다.', 'trainer_summary_text', AbortSignal.abort())).rejects.toThrow();
  expect(llm.structured).not.toHaveBeenCalled();
});
it('times out stalled local requests and returns the source for review', async () => {
  const llm = fakeLlm(request => new Promise<LlmOutput>((_resolve, reject) => request.signal!.addEventListener('abort', () => reject(request.signal!.reason), { once: true })));
  const result = await createAiServices(readConfig({ LLM_TIMEOUT_MS: '20' }), llm).generate('관찰했습니다.', 'trainer_summary_text');
  expect(result.fallbackUsed).toBe(true); expect(result.draft.sourceText).toBe('관찰했습니다.');
});
it('runs all workspace extractors through the same provider', async () => {
  const llm = fakeLlm(request => {
    const input = JSON.parse(request.user);
    return { finished: true, json: input.pets ? { events: [{ petId: 'pet_0', type: 'bark', timeHint: null, durationMin: null, trigger: null, intervention: null, outcome: null, details: { amountText: null, isTreat: null, excretionKinds: [], placeText: null }, sourceQuote: '초코가 짖었어요.' }], safetyFlags: [], clarification: null }
      : input.memos ? { observations: [{ memoId: 'memo-0', sourceQuote: '사람에게 다가왔습니다.', category: 'people', valence: 'positive' }], safetyFlags: [] }
      : { summary: ['record-days'], changes: [], questionsForOwner: [] } };
  });
  const services = createAiServices(config(), llm);
  const pet = { id: 'p', name: '초코', nicknames: [] }, now = '2026-09-30T10:00:00+09:00', timeZone = 'Asia/Seoul';
  const results = [await services.generateOwner({ text: '초코가 짖었어요.', pets: [pet], now, timeZone, sourceKind: 'nl_log_text' }),
    await services.generateBrief({ pet, records: [], now, timeZone }),
    await services.generateShelter({ animal: { id: 'p', name: '초코', species: 'dog', ageMonths: 24 }, memos: [{ id: 'm', date: '2026-09-30', role: 'staff', text: '사람에게 다가왔습니다.' }] })];
  expect(results.map(result => [result.fallbackUsed, result.draft.mode])).toEqual([[false, 'ollama'], [false, 'ollama'], [false, 'ollama']]);
});
it('constrains brief output to computed fact IDs and excludes unsupported changes', async () => {
  const llm = fakeLlm(request => {
    const input = JSON.parse(request.user), properties = (request.jsonSchema as any).properties;
    expect(properties.summary.items.enum).toEqual(input.facts.map((fact: { id: string }) => fact.id));
    expect(properties.questionsForOwner.items.enum).toEqual(input.facts.map((fact: { id: string }) => fact.id));
    expect(properties.changes.maxItems).toBe(0);
    return { json: { summary: ['record-days'], changes: [], questionsForOwner: [] }, finished: true };
  });
  const result = await createAiServices(config(), llm).generateBrief({ pet: { id: 'p', name: '초코', nicknames: [] }, records: [], now: '2026-09-30T10:00:00+09:00', timeZone: 'Asia/Seoul' });
  expect(result.fallbackUsed).toBe(false);
});
it('constrains note quotations to exact source sentences, preserving decimals and spacing', async () => {
  const text = '오늘 1.5미터 거리에서 5회 중 3회 수행을 관찰했습니다.';
  let format: any;
  const llm = fakeLlm(request => { format = request.jsonSchema; return { json: { ...extraction, items: [{ category: 'observation', sourceQuote: text }] }, finished: true }; });
  const result = await createAiServices(config(), llm).generate(text, 'trainer_summary_text');
  expect(format.properties.items.items.properties.sourceQuote.enum).toEqual([text]);
  expect(result.fallbackUsed).toBe(false);
  expect(result.draft.items[0].sourceQuote).toBe(text);
});
