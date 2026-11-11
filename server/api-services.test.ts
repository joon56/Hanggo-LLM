// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { readConfig } from './config.ts';
import { createApiServices } from './api-services.ts';
import type { StructuredClient, StructuredRequest } from './api-types.ts';
import { classifyShelterQuote, memoSentences } from '../src/domain/shelter.ts';
import { BriefInputSchema } from './brief-service.ts';

const config = () => readConfig({ AI_ENABLED: 'true', AI_PROVIDER: 'api', GEMINI_API_KEY: 'test-g', ANTHROPIC_API_KEY: 'test-a' });
const fixture = async (file: string, id: string) => (JSON.parse(await readFile(new URL(`../fixtures/${file}.json`, import.meta.url), 'utf8')) as { id: string }[]).find(item => item.id === id) as any;

it('builds a note draft from chosen IDs with exact quotes, masked input and usage', async () => {
  const usage = vi.fn(); let request: StructuredRequest | undefined;
  const client: StructuredClient = async value => { request = value; return { json: { items: [{ sentence: 'S2', category: 'observation' }], safetyFlags: [], methodReview: false }, inputTokens: 30, outputTokens: 8 }; };
  const result = await createApiServices(config(), { client, onUsage: usage }).generate('연락처 010-1234-5678. 앉아를 관찰했습니다.', 'trainer_summary_text');
  expect(request?.model).toBe('gemini-3.8-flash');
  expect(JSON.stringify(request?.input)).not.toContain('010-1234-5678');
  expect(result).toMatchObject({ fallbackUsed: false, model: 'gemini-3.8-flash' });
  expect(result.draft.items).toEqual([expect.objectContaining({ category: 'observation', sourceQuote: '앉아를 관찰했습니다.', text: '앉아를 관찰했습니다.' })]);
  expect(usage).toHaveBeenCalledWith(expect.objectContaining({ model: 'gemini-3.8-flash', inputTokens: 30, outputTokens: 8 }));
});
it('retries with the validation message and falls back when IDs stay invalid', async () => {
  const systems: string[] = [];
  const client: StructuredClient = async value => { systems.push(value.system); return { json: { items: [{ sentence: 'S9', category: 'task' }], safetyFlags: [], methodReview: false }, inputTokens: 1, outputTokens: 1 }; };
  const result = await createApiServices(config(), { client }).generate('앉아를 관찰했습니다.', 'trainer_summary_text');
  expect(systems).toHaveLength(2); expect(systems[1]).toContain('검증 재시도:');
  expect(result.fallbackUsed).toBe(true);
});
it('falls back without retrying when the vendor call fails', async () => {
  const models: string[] = [];
  const client: StructuredClient = async value => { models.push(value.model); throw new Error('offline'); };
  const owner = await createApiServices(config(), { client }).generateOwner({ text: '초코 산책 30분 하고 응가함', pets: [{ id: 'p1', name: '초코', nicknames: [] }], now: '2026-09-30T14:00:00+09:00', timeZone: 'Asia/Seoul', sourceKind: 'nl_log_text' });
  expect(owner.fallbackUsed).toBe(true); expect(models).toEqual(['claude-haiku-5-5']);
});
it('accepts an owner event chosen by sentence range', async () => {
  const item = await fixture('owner-logs', 'multi-events');
  const { sourceQuote: _quote, ...event } = item.extraction.events[0];
  const client: StructuredClient = async () => ({ json: { events: [{ ...event, fromSentence: 'S1', toSentence: 'S1' }], safetyFlags: [], clarification: null }, inputTokens: 1, outputTokens: 1 });
  const result = await createApiServices(config(), { client }).generateOwner(item.input);
  expect(result.fallbackUsed).toBe(false);
  expect(result.draft.events[0].sourceQuote).toBe(item.input.text);
});
it('maps shelter sentence IDs to the original memos', async () => {
  const item = await fixture('shelter-profiles', 'one-memo');
  const observations = item.input.memos.flatMap((memo: { text: string }, memoIndex: number) => memoSentences(memo.text).map((sentence, index) => ({ sentence: `M${memoIndex + 1}-S${index + 1}`, ...classifyShelterQuote(sentence) })));
  const client: StructuredClient = async () => ({ json: { observations, safetyFlags: [] }, inputTokens: 1, outputTokens: 1 });
  const result = await createApiServices(config(), { client }).generateShelter(item.input);
  expect(result.fallbackUsed).toBe(false);
  expect(result.draft.observations.map(observation => observation.memoId)).toEqual(observations.map(() => item.input.memos[0].id));
});
it('sends only computed brief facts to the text model', async () => {
  const item = await fixture('briefs', 'increase'); let request: StructuredRequest | undefined;
  const client: StructuredClient = async value => { request = value; return { json: { summary: [], changes: [], questionsForOwner: [] }, inputTokens: 1, outputTokens: 1 }; };
  const result = await createApiServices(config(), { client }).generateBrief(BriefInputSchema.parse(item.input));
  expect(request?.model).toBe('gemini-3.8-flash');
  expect(request?.input).not.toHaveProperty('records');
  expect(result.model).toBe('gemini-3.8-flash');
});
