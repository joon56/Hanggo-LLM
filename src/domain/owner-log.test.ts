import { describe, expect, it } from 'vitest';
import { createManualOwnerDraft, validateOwnerDraft, ownerRiskFlags } from './owner-log';
import type { OwnerInput } from './workspace-types';
export const input: OwnerInput = { text: '초코가 5분 짖었다', pets: [{ id: 'p1', name: '초코', nicknames: [] }], now: '2026-09-30T14:00:00+09:00', timeZone: 'Asia/Seoul', sourceKind: 'nl_log_text' };
describe('owner draft', () => {
  it('does not treat fatigue or avoiding a dog as bleeding', () => {
    expect(ownerRiskFlags('초코가 피곤해서 쉬었어요.')).not.toContain('bleeding');
    expect(ownerRiskFlags('다른 강아지를 피해 걸었어요.')).not.toContain('bleeding');
    for (const text of ['발에서 피가 났어요.', '코피가 났어요.', '피를 흘렸어요.', '출혈이 있어요.', '혈변을 봤어요.']) expect(ownerRiskFlags(text)).toContain('bleeding');
  });
  it('preserves manual source without inventing event facts', () => {
    const draft = createManualOwnerDraft(input);
    expect(draft.events[0]).toMatchObject({ type: 'other', durationMin: null, occurredAt: null, sourceQuote: input.text });
    expect(validateOwnerDraft(draft)).toEqual([]);
  });
  it('requires pet resolution before saving', () => {
    const draft = createManualOwnerDraft({ ...input, text: '짖었다', pets: [...input.pets, { id: 'p2', name: '보리', nicknames: [] }] });
    expect(draft.events[0].petId).toBeNull();
    expect(draft.clarification).toBeTruthy();
    expect(validateOwnerDraft(draft).length).toBeGreaterThan(0);
  });
  it('rejects fabricated numbers even with edited provenance', () => {
    const draft = createManualOwnerDraft(input);
    draft.events[0].durationMin = 50; draft.events[0].edited = true;
    expect(validateOwnerDraft(draft).length).toBeGreaterThan(0);
  });
  it('does not mistake elapsed time for duration', () => {
    const draft = createManualOwnerDraft({ ...input, text: '초코 30분 전 산책했다' });
    draft.events[0].durationMin = 30;
    expect(validateOwnerDraft(draft).length).toBeGreaterThan(0);
  });
  it('keeps source safety flags immutable', () => {
    const draft = createManualOwnerDraft({ ...input, text: '초코가 구토했다' });
    draft.safetyFlags = [];
    expect(validateOwnerDraft(draft).length).toBeGreaterThan(0);
  });
  it('rejects malformed payloads without throwing', () => {
    for (const value of [null, {}, { events: [null] }, [], 123]) expect(validateOwnerDraft(value as never).length).toBeGreaterThan(0);
  });
});
