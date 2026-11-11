// @vitest-environment node
import { expect, it } from 'vitest';
import { z } from 'zod';
import { API_BRIEF_INSTRUCTIONS, API_NOTE_INSTRUCTIONS, API_OWNER_INSTRUCTIONS, API_SHELTER_INSTRUCTIONS, BriefChoice, NoteChoice, OwnerChoice, ShelterChoice, briefRequest, mapNoteChoice, mapOwnerChoice, mapShelterChoice, noteRequest, ownerRequest, shelterRequest } from './api-mappers.ts';
import type { BriefDraft } from '../src/domain/workspace-types.ts';

it('asks API models for sentence IDs instead of rewritten quotes', () => {
  for (const text of [API_NOTE_INSTRUCTIONS, API_OWNER_INSTRUCTIONS, API_SHELTER_INSTRUCTIONS]) expect(text).not.toContain('sourceQuote');
});
it('maps note sentence IDs back to exact masked text and keeps risk on invalid IDs', () => {
  const { units, input } = noteRequest('보호자는 짖는다고 말했습니다. 앉아를 관찰했습니다.');
  expect(input).toEqual({ sentences: [{ id: 'S1', text: '보호자는 짖는다고 말했습니다.' }, { id: 'S2', text: '앉아를 관찰했습니다.' }] });
  expect(mapNoteChoice(units, { items: [{ sentence: 'S2', category: 'observation' }], safetyFlags: [], methodReview: false }))
    .toEqual({ items: [{ category: 'observation', sourceQuote: '앉아를 관찰했습니다.' }], safetyFlags: [], methodReview: false });
  expect(mapNoteChoice(units, { items: [{ sentence: 'S9', category: 'task' }], safetyFlags: ['통증'], methodReview: true })).toEqual({ safetyFlags: ['통증'], methodReview: true });
  expect(mapNoteChoice(units, { broken: true, safetyFlags: ['물림'] })).toEqual({ safetyFlags: ['물림'], methodReview: undefined });
});
it('maps an owner sentence range to one contiguous quote without sending the raw text field', () => {
  const masked = { text: '초코가 초인종에 3분 짖었어요. 매트로 보냈더니 멈췄어요.', pets: [{ id: 'pet_0', name: '초코', nicknames: [] }], now: '2026-11-11T10:00:00+09:00', timeZone: 'Asia/Seoul', sourceKind: 'nl_log_text' as const };
  const { units, input } = ownerRequest(masked);
  expect(input).not.toHaveProperty('text');
  expect(input.sentences).toHaveLength(2);
  const event = { petId: 'pet_0', type: 'bark', fromSentence: 'S1', toSentence: 'S2', timeHint: null, durationMin: 3, trigger: 'doorbell', intervention: '매트로 보냈더니', outcome: 'stopped', details: { amountText: null, isTreat: null, excretionKinds: [], placeText: null } };
  const mapped = mapOwnerChoice(masked.text, units, { events: [event], safetyFlags: [], clarification: null }) as { events: Record<string, unknown>[] };
  expect(mapped.events[0].sourceQuote).toBe(masked.text);
  expect(mapped.events[0]).not.toHaveProperty('fromSentence');
  expect(mapOwnerChoice(masked.text, units, { events: [{ ...event, fromSentence: 'S2', toSentence: 'S1' }], safetyFlags: ['pain_sign'], clarification: null })).toEqual({ safetyFlags: ['pain_sign'] });
});
it('maps memo sentence IDs to opaque memo IDs and exact sentences', () => {
  const masked = { animal: { id: 'animal', name: '**', species: 'dog' as const, ageMonths: 24 }, memos: [
    { id: 'memo-0', date: '2026-11-01', role: 'staff' as const, text: '사람을 좋아함. 다른 개를 피함.' },
    { id: 'memo-1', date: '2026-11-02', role: 'volunteer' as const, text: '간식을 잘 먹음.' }] };
  const { memos, input } = shelterRequest(masked);
  expect(JSON.stringify(input)).not.toContain('memo-0');
  expect(input.memos[1].sentences).toEqual([{ id: 'M2-S1', text: '간식을 잘 먹음.' }]);
  expect(mapShelterChoice(memos, { observations: [{ sentence: 'M1-S2', category: 'dogs', valence: 'caution' }], safetyFlags: [] }))
    .toEqual({ observations: [{ memoId: 'memo-0', sourceQuote: '다른 개를 피함.', category: 'dogs', valence: 'caution' }], safetyFlags: [] });
  expect(mapShelterChoice(memos, { observations: [{ sentence: 'M3-S1', category: 'food', valence: 'positive' }], safetyFlags: [] })).toEqual({ safetyFlags: [] });
});
it('sends at most 48 brief facts with bounded text', () => {
  const draft = { period: { from: '2026-10-29', to: '2026-11-11', daysWithRecords: 3 }, facts: Array.from({ length: 50 }, (_, index) => ({ id: `f${index}`, label: 'L', value: 'x'.repeat(200), unit: '건', previousValue: null, refs: [] })) } as unknown as BriefDraft;
  const request = briefRequest(draft);
  expect(request.facts).toHaveLength(48);
  expect(request.omittedFacts).toBe(2);
  expect(String(request.facts[0].value)).toHaveLength(160);
});
it('uses wire-safe schemas without length or range constraints', () => {
  for (const schema of [NoteChoice, OwnerChoice, ShelterChoice, BriefChoice]) {
    const json = JSON.stringify(z.toJSONSchema(schema));
    for (const keyword of ['minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems']) expect(json).not.toContain(`"${keyword}"`);
  }
});
it('sends only repeated-sentence first occurrences and keeps numbered IDs', () => {
  expect(noteRequest('네. 산책을 했습니다. 네.').input.sentences).toEqual([{ id: 'S1', text: '네.' }, { id: 'S2', text: '산책을 했습니다.' }]);
  const memo = { id: 'm1', date: '2026-10-01', role: 'staff', text: '순합니다. 산책을 했습니다. 순합니다.' };
  const { input } = shelterRequest({ animal: { species: 'dog', ageMonths: 12 }, memos: [memo] } as never);
  expect(input.memos[0].sentences.map(s => s.text)).toEqual(['순합니다.', '산책을 했습니다.']);
});
it('gives API models the change candidates the local path would allow', () => {
  const facts = [
    { id: 'record-days', label: '기록일', value: 5, unit: '일', previousValue: 5, refs: [] },
    { id: 'count:a', label: 'A', value: 10, unit: '건', previousValue: 4, refs: [] },
    { id: 'count:b', label: 'B', value: 5, unit: '건', previousValue: 5, refs: [] },
    { id: 'other', label: 'C', value: 9, unit: '건', previousValue: 1, refs: [] },
  ];
  const draft = { period: { from: '2026-10-29', to: '2026-11-11', daysWithRecords: 5 }, facts } as unknown as BriefDraft;
  expect(briefRequest(draft).changeCandidates).toEqual(['count:a']);
  expect(briefRequest({ ...draft, period: { ...draft.period, daysWithRecords: 2 } } as BriefDraft).changeCandidates).toEqual([]);
  expect(API_BRIEF_INSTRUCTIONS).toContain('changeCandidates');
});
