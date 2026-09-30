import { describe, expect, it, vi } from 'vitest';
import { createOwnerService, resolveOwnerTime } from './owner-service.ts';
import type { OwnerInput } from '../src/domain/workspace-types.ts';
import fixtures from '../fixtures/owner-logs.json' with { type: 'json' };
const input: OwnerInput = { text: '초코가 5분 짖었다', pets: [{ id: 'p1', name: '초코', nicknames: [] }], now: '2026-09-30T14:00:00+09:00', timeZone: 'Asia/Seoul', sourceKind: 'nl_log_text' };
const event = { petId: 'p1', type: 'bark', timeHint: null, durationMin: 5, trigger: null, intervention: null, outcome: null, details: { amountText: null, isTreat: null, excretionKinds: [], placeText: null }, sourceQuote: input.text };
describe('owner extraction', () => {
  it.each(fixtures)('golden fixture $id', async fixture => {
    const result = await createOwnerService({ model: 'fixture', extract: async () => fixture.extraction }).generate(fixture.input as OwnerInput);
    expect(result.fallbackUsed).toBe(fixture.expected.fallbackUsed);
    expect(result.draft.events[0]).toMatchObject({ type: fixture.expected.type, durationMin: fixture.expected.durationMin, petId: fixture.expected.petId, occurredAt: fixture.expected.occurredAt, sourceQuote: fixture.input.text });
    for (const flag of fixture.expected.safetyFlags) expect(result.draft.safetyFlags).toContain(flag);
  });
  it('rejects invented type on unrelated source', async () => {
    const unrelated = { ...input, text: '오늘 주식 시장 어때' };
    const result = await createOwnerService({ model: 'test', extract: async () => ({ events: [{ ...event, durationMin: null, sourceQuote: unrelated.text }], safetyFlags: [], clarification: null }) }).generate(unrelated);
    expect(result.fallbackUsed).toBe(true);
  });
  it.each([
    ['bark', '초코는 오늘 짖지 않았다'], ['bark', '초코는 안 짖었어요'],
    ['walk', '초코 산책 안 했어요'], ['feeding', '초코 밥을 먹지 않아요'],
    ['bark', '초코가 짖으면 기록할 예정'], ['walk', '초코가 산책했는지 모르겠어요'],
  ])('does not count absent or hypothetical %s from %s', async (type, text) => {
    const result = await createOwnerService({ model: 'test', extract: async () => ({ events: [{ ...event, type, durationMin: null, sourceQuote: text }], safetyFlags: [], clarification: null }) }).generate({ ...input, text });
    expect(result.fallbackUsed).toBe(true); expect(result.draft.events[0].type).toBe('other');
  });
  it('cannot evade negation by quoting only the behavior word', async () => {
    const result = await createOwnerService({ model: 'test', extract: async () => ({ events: [{ ...event, durationMin: null, sourceQuote: '짖' }], safetyFlags: [], clarification: null }) }).generate({ ...input, text: '초코는 오늘 짖지 않았다' });
    expect(result.fallbackUsed).toBe(true);
  });
  it('masks pet context and restores source offsets', async () => {
    const pii = { ...input, text: '초코가 010-1234-5678 연락처 앞에서 짖었다', pets: [{ id: 'owner@example.com', name: '초코', nicknames: ['010-1234-5678'] }] };
    const result = await createOwnerService({ model: 'test', extract: async masked => {
      expect(JSON.stringify(masked)).not.toContain('010-1234-5678'); expect(JSON.stringify(masked)).not.toContain('owner@example.com');
      return { events: [{ ...event, petId: 'pet_0', durationMin: null, sourceQuote: masked.text }], safetyFlags: [], clarification: null };
    } }).generate(pii);
    expect(result.fallbackUsed).toBe(false); expect(result.draft.events[0].sourceQuote).toBe(pii.text);
  });
  it('aborts instead of returning fallback', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(createOwnerService({ model: 'test', extract: async () => ({}) }).generate(input, controller.signal)).rejects.toThrow();
  });
  it('leaves extreme and ambiguous relative times unknown', () => {
    expect(resolveOwnerTime('9999999999999999999999999999시간 전', input)).toBeNull();
    expect(resolveOwnerTime('어제 오후', input)).toBeNull();
    expect(resolveOwnerTime('2026-10-01T00:00:00+09:00', input)).toBeNull();
  });
  it('splits multiple source-grounded events and pets', async () => {
    const multiple = { ...input, text: '초코 5분 짖음. 보리 산책 30분.', pets: [...input.pets, { id: 'p2', name: '보리', nicknames: [] }] };
    const result = await createOwnerService({ model: 'test', extract: async () => ({ events: [
      { ...event, petId: 'pet_0', sourceQuote: '초코 5분 짖음.' },
      { ...event, petId: 'pet_1', type: 'walk', durationMin: 30, sourceQuote: '보리 산책 30분.' },
    ], safetyFlags: [], clarification: null }) }).generate(multiple);
    expect(result.fallbackUsed).toBe(false); expect(result.draft.events.map(value => value.petId)).toEqual(['p1', 'p2']);
  });
  it('does not invent a pet for unnamed multi-pet input', async () => {
    const ambiguous = { ...input, text: '5분 짖었다', pets: [...input.pets, { id: 'p2', name: '보리', nicknames: [] }] };
    const result = await createOwnerService({ model: 'test', extract: async () => ({ events: [{ ...event, petId: 'pet_0', sourceQuote: ambiguous.text }], safetyFlags: [], clarification: null }) }).generate(ambiguous);
    expect(result.draft.events[0].petId).toBeNull(); expect(result.draft.clarification).toBeTruthy();
  });
  it('retries bad quotes once and retains risk after successful repair', async () => {
    const extract = vi.fn().mockResolvedValueOnce({ events: [{ ...event, sourceQuote: '날조' }], safetyFlags: ['pain_sign'], clarification: null }).mockResolvedValueOnce({ events: [event], safetyFlags: [], clarification: null });
    const result = await createOwnerService({ model: 'test', extract }).generate(input);
    expect(result.fallbackUsed).toBe(false); expect(result.draft.safetyFlags).toContain('pain_sign'); expect(extract).toHaveBeenCalledTimes(2);
  });
  it('does not expose model-authored advice through clarification', async () => {
    const result = await createOwnerService({ model: 'test', extract: async () => ({ events: [event], safetyFlags: [], clarification: '약을 50mg 주세요. 완치됩니다.' }) }).generate(input);
    expect(result.draft.clarification).toBeNull();
  });
  it('accepts grounded event facts', async () => {
    const result = await createOwnerService({ model: 'test', extract: async () => ({ events: [event], safetyFlags: [], clarification: null }) }).generate(input);
    expect(result.fallbackUsed).toBe(false); expect(result.draft.events[0].durationMin).toBe(5);
  });
  it('retains valid safety flags in malformed response and retry failure', async () => {
    const extract = vi.fn().mockResolvedValueOnce({ events: 'invalid', safetyFlags: ['pain_sign', 'fake'] }).mockRejectedValueOnce(new Error('offline'));
    const result = await createOwnerService({ model: 'test', extract }).generate(input);
    expect(result.fallbackUsed).toBe(true); expect(result.draft.safetyFlags).toEqual(['pain_sign']);
  });
  it('rejects unsupported duration then falls back', async () => {
    const result = await createOwnerService({ model: 'test', extract: async () => ({ events: [{ ...event, durationMin: 55 }], safetyFlags: [], clarification: null }) }).generate(input);
    expect(result.fallbackUsed).toBe(true);
  });
});
