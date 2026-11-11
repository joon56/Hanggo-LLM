import { z } from 'zod';
import { Extraction } from './service.ts';
import { NOTE_INSTRUCTIONS } from './prompts.ts';
import { OWNER_INSTRUCTIONS } from './owner-service.ts';
import { BRIEF_INSTRUCTIONS } from './brief-service.ts';
import { SHELTER_INSTRUCTIONS, ShelterExtraction } from './shelter-service.ts';
import { OwnerEventFields, ownerSafetyFlags } from '../src/domain/owner-log.ts';
import { isBriefChange } from '../src/domain/brief.ts';
import { memoSentences } from '../src/domain/shelter.ts';
import { numberSentences, quoteRange, unitText, type SentenceUnit } from './sentence-choice.ts';
import type { BriefDraft, OwnerInput, ShelterInput } from '../src/domain/workspace-types.ts';

// Output schemas stay free of length and range keywords that some vendors reject;
// the existing services still enforce every limit after mapping.
const nullableText = z.string().nullable(), ids = z.array(z.string());
const owner = OwnerEventFields.shape, shelter = ShelterExtraction.shape.observations.element.shape;
export const NoteChoice = z.object({ items: z.array(z.object({ sentence: z.string(), category: Extraction.shape.items.element.shape.category }).strict()), safetyFlags: Extraction.shape.safetyFlags, methodReview: z.boolean() }).strict();
export const OwnerChoice = z.object({ events: z.array(z.object({
  petId: z.string().nullable(), type: owner.type, fromSentence: z.string(), toSentence: z.string(), timeHint: nullableText, durationMin: z.number().nullable(),
  trigger: owner.trigger, intervention: nullableText, outcome: owner.outcome,
  details: z.object({ amountText: nullableText, isTreat: z.boolean().nullable(), excretionKinds: z.array(z.enum(['pee', 'poop', 'unknown'])), placeText: nullableText }).strict(),
}).strict()), safetyFlags: z.array(z.enum(ownerSafetyFlags)), clarification: nullableText }).strict();
export const ShelterChoice = z.object({ observations: z.array(z.object({ sentence: z.string(), category: shelter.category, valence: shelter.valence }).strict()), safetyFlags: ShelterExtraction.shape.safetyFlags }).strict();
export const BriefChoice = z.object({ summary: ids, changes: ids, questionsForOwner: ids }).strict();

const CHOOSE = '입력의 sentences는 원문을 나눈 문장이며 id로 가리킵니다. 문장을 다시 쓰지 말고 id만 고르세요. 코드가 해당 원문을 그대로 복사합니다.';
export const API_NOTE_INSTRUCTIONS = `${NOTE_INSTRUCTIONS.replace('sourceQuote는 입력의 정확한 연속 부분 문자열이어야 한다. 바꾸거나 덧붙이지 않는다.', '각 항목의 sentence에는 입력 문장 id 하나를 쓴다.')}
${CHOOSE} 같은 문장 id를 두 번 쓰지 마세요. 출처가 없는 짧은 메모·일상 진술·건강 증상은 follow_up입니다. observation은 훈련사의 직접 관찰이 명시된 경우입니다. 증상과 확인할 내용은 follow_up에 보존하세요. 체벌·강압 행위는 methodReview에 표시합니다. 행위만으로 원문에 없는 통증이나 건강 증상을 추측해 safetyFlags에 추가하지 마세요.`;
export const API_OWNER_INSTRUCTIONS = `${OWNER_INSTRUCTIONS.replace('각 사건 sourceQuote는 입력의 정확한 부분 문자열. timeHint, intervention, amountText, placeText도 해당 sourceQuote의 정확한 부분 문자열이며 요약하지 않는다.', '각 사건의 근거는 fromSentence부터 toSentence까지의 입력 문장 id 범위다. 한 문장이면 두 값이 같다. timeHint, intervention, amountText, placeText는 그 범위 원문의 정확한 부분 문자열이며 요약하지 않는다.')}
${CHOOSE} 발생 시점이 없으면 timeHint=null, 지속 시간이 없으면 durationMin=null입니다. now를 발생 시각으로 복사하지 마세요. 모르는 값을 0이나 무관한 원문으로 채우지 마세요. excretionKinds의 pee는 소변, poop은 대변이며 배변 외 사건에서는 []입니다. 음식 외 사건의 isTreat는 null입니다.`;
export const API_SHELTER_INSTRUCTIONS = `${SHELTER_INSTRUCTIONS.replace('보호소 메모의 관찰을 원문 그대로 sourceQuote로 추출하고 memoId, category, valence를 반환하세요.', '보호소 메모 문장 중 관찰을 골라 sentence에 문장 id를 쓰고 category, valence를 반환하세요.').replace(' 마침표나 줄바꿈으로 나눈 원문 문장 전체를 인용하세요.', '')}
${CHOOSE} 행동 관찰과 무관한 연락처는 제외하세요. category는 기록 대상 동물의 종이 아니라 관찰 주제입니다. people=사람과의 관계, dogs=다른 개와의 관계, cats=고양이와의 관계, food=음식·간식입니다.`;

export const API_BRIEF_INSTRUCTIONS = `${BRIEF_INSTRUCTIONS}
changes에는 changeCandidates에 있는 ID만 고르세요. changeCandidates가 비어 있으면 changes는 []입니다.`;

const sentences = (units: SentenceUnit[]) => units.map(({ id, text }) => ({ id, text }));
const risk = (raw: unknown) => raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
export type ShelterUnits = { memo: ShelterInput['memos'][number]; units: SentenceUnit[] }[];

// A repeated sentence would yield duplicate quotes, which the services reject; keep the first of each.
const firstOfEach = (units: SentenceUnit[]) => units.filter((unit, index) => units.findIndex(other => other.text === unit.text) === index);
export function noteRequest(masked: string) { const units = firstOfEach(numberSentences(masked)); return { units, input: { sentences: sentences(units) } }; }
export function ownerRequest(masked: OwnerInput) {
  const { text, ...context } = masked; const units = numberSentences(text);
  return { units, input: { ...context, sentences: sentences(units) } };
}
export function shelterRequest(masked: ShelterInput) {
  const memos: ShelterUnits = masked.memos.map((memo, index) => ({ memo, units: firstOfEach(numberSentences(memo.text, memoSentences, `M${index + 1}-S`)) }));
  return { memos, input: { animal: { species: masked.animal.species, ageMonths: masked.animal.ageMonths }, memos: memos.map(({ memo, units }) => ({ date: memo.date, role: memo.role, sentences: sentences(units) })) } };
}
export function briefRequest(draft: BriefDraft) {
  const facts = draft.facts.slice(0, 48).map(({ id, label, value, unit, previousValue }) => ({ id, label, value: typeof value === 'string' ? value.slice(0, 160) : value, unit, previousValue }));
  const sent = facts.map(fact => fact.id), priorDays = Number(draft.facts.find(fact => fact.id === 'record-days')?.previousValue);
  const changeCandidates = draft.facts.filter(fact => sent.includes(fact.id) && isBriefChange(fact, draft.period.daysWithRecords, priorDays)).map(fact => fact.id);
  return { period: draft.period, facts, changeCandidates, omittedFacts: draft.facts.length - facts.length, scope: '날짜별 기록 집계와 제한된 맥락 발췌. 원문 전체와 전사는 보내지 않음.' };
}

export function mapNoteChoice(units: SentenceUnit[], raw: unknown): unknown {
  const parsed = NoteChoice.safeParse(raw);
  if (!parsed.success) return { safetyFlags: risk(raw).safetyFlags, methodReview: risk(raw).methodReview };
  const { safetyFlags, methodReview } = parsed.data;
  const items = parsed.data.items.map(item => ({ category: item.category, sourceQuote: unitText(units, item.sentence) }));
  return items.some(item => item.sourceQuote === null) ? { safetyFlags, methodReview } : { items, safetyFlags, methodReview };
}
export function mapOwnerChoice(source: string, units: SentenceUnit[], raw: unknown): unknown {
  const parsed = OwnerChoice.safeParse(raw);
  if (!parsed.success) return { safetyFlags: risk(raw).safetyFlags };
  const events = parsed.data.events.map(({ fromSentence, toSentence, ...event }) => ({ ...event, sourceQuote: quoteRange(source, units, fromSentence, toSentence) }));
  return events.some(event => event.sourceQuote === null) ? { safetyFlags: parsed.data.safetyFlags } : { events, safetyFlags: parsed.data.safetyFlags, clarification: parsed.data.clarification };
}
export function mapShelterChoice(memos: ShelterUnits, raw: unknown): unknown {
  const parsed = ShelterChoice.safeParse(raw);
  if (!parsed.success) return { safetyFlags: risk(raw).safetyFlags };
  const observations = parsed.data.observations.map(item => {
    const match = memos.find(({ units }) => units.some(unit => unit.id === item.sentence));
    return match ? { memoId: match.memo.id, sourceQuote: unitText(match.units, item.sentence), category: item.category, valence: item.valence } : null;
  });
  return observations.some(item => item === null) ? { safetyFlags: parsed.data.safetyFlags } : { observations, safetyFlags: parsed.data.safetyFlags };
}
