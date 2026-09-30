import { z } from 'zod';
import type { OwnerDraft, OwnerInput } from './workspace-types.ts';

export const ownerSafetyFlags = ['bleeding', 'vomiting', 'diarrhea', 'not_eating', 'limping', 'seizure', 'breathing', 'bite_injury', 'sudden_aggression', 'pain_sign', 'other_health'] as const;
export const PetSchema = z.object({ id: z.string().trim().min(1).max(100), name: z.string().trim().min(1).max(100), nicknames: z.array(z.string().trim().min(1).max(100)).max(20) }).strict();
export const OwnerInputSchema = z.object({
  text: z.string().min(1).max(8000).refine(value => !!value.trim()),
  pets: z.array(PetSchema).min(1).max(30).refine(pets => new Set(pets.map(pet => pet.id)).size === pets.length),
  now: z.iso.datetime({ offset: true }),
  timeZone: z.string().max(100).refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }),
  sourceKind: z.enum(['nl_log_text', 'nl_log_voice']),
}).strict();
export const OwnerEventFields = z.object({
  petId: z.string().max(100).nullable(),
  type: z.enum(['bark', 'feeding', 'walk', 'excretion', 'rest', 'activity', 'training', 'other_behavior', 'health_observation', 'other']),
  timeHint: z.string().min(1).max(300).nullable(), durationMin: z.number().min(0).max(600).nullable(),
  trigger: z.enum(['doorbell', 'delivery', 'visitor', 'stranger', 'other_dog', 'other_animal', 'noise', 'left_alone', 'owner_return', 'food', 'unknown', 'other']).nullable(),
  intervention: z.string().min(1).max(2000).nullable(), outcome: z.enum(['stopped', 'reduced', 'continued', 'escalated', 'unknown']).nullable(),
  details: z.object({ amountText: z.string().min(1).max(300).nullable(), isTreat: z.boolean().nullable(), excretionKinds: z.array(z.enum(['pee', 'poop', 'unknown'])).max(3), placeText: z.string().min(1).max(300).nullable() }).strict(),
  sourceQuote: z.string().min(1).max(8000),
}).strict();
const DraftSchema = z.object({
  id: z.string().min(1), sourceText: z.string().min(1).max(8000), sourceKind: OwnerInputSchema.shape.sourceKind,
  pets: OwnerInputSchema.shape.pets, now: OwnerInputSchema.shape.now, timeZone: OwnerInputSchema.shape.timeZone,
  events: z.array(OwnerEventFields.extend({ id: z.string().min(1), occurredAt: z.iso.datetime({ offset: true }).nullable(), edited: z.boolean() })).min(1).max(100),
  safetyFlags: z.array(z.enum(ownerSafetyFlags)).max(30), clarification: z.string().max(1000).nullable(), mode: z.enum(['demo', 'manual', 'openai', 'ollama']),
  generation: z.object({ requestId: z.string(), model: z.string(), promptVersion: z.string(), latencyMs: z.number().min(0), fallbackUsed: z.boolean() }).strict().optional(),
}).strict();

export function ownerRiskFlags(text: string): string[] {
  const patterns: RegExp[] = [/출혈|코피|혈변|혈뇨|피가\s*(?:나|난|났|묻|보)|피를?\s*(?:흘|토)|피\s*(?:났|남)|bleed/i, /구토|토했|토함|토해|vomit/i, /설사|diarrhea/i, /안\s*먹|밥을\s*안|먹지\s*않|식욕.*(?:없|저하)/i, /절뚝|다리를\s*절|limp/i, /경련|발작|seizure/i, /호흡|숨을?\s*(?:헐떡|못|가쁘)/i, /물었|물려|물린|상처|bite|bitten/i, /갑자기.*(?:공격|물)|갑작스러운\s*공격/i, /통증|깨갱|아파|아프|pain/i, /건강\s*이상/i];
  return ownerSafetyFlags.filter((_, index) => patterns[index].test(text));
}

export function resolveOwnerPet(quote: string, input: OwnerInput): string | null {
  const matched = input.pets.filter(pet => [pet.name, ...pet.nicknames].some(name => quote.includes(name)));
  return matched.length === 1 ? matched[0].id : matched.length === 0 && input.pets.length === 1 ? input.pets[0].id : null;
}

export function groundedDuration(quote: string, duration: number): boolean {
  return [...quote.matchAll(/(\d+(?:\.\d+)?)\s*(분|시간|초|minutes?|hours?|seconds?)/gi)].some(match => {
    const tail = quote.slice((match.index ?? 0) + match[0].length);
    if (/^\s*(?:전|후|ago|later)/i.test(tail)) return false;
    const value = Number(match[1]) * (/시간|hour/i.test(match[2]) ? 60 : /초|second/i.test(match[2]) ? 1 / 60 : 1);
    return Math.abs(value - duration) < 0.000001;
  });
}

export function createManualOwnerDraft(input: OwnerInput): OwnerDraft {
  OwnerInputSchema.parse(input);
  const petId = resolveOwnerPet(input.text, input);
  return { id: crypto.randomUUID(), sourceText: input.text, sourceKind: input.sourceKind, pets: structuredClone(input.pets), now: input.now, timeZone: input.timeZone,
    events: [{ id: crypto.randomUUID(), petId, type: 'other', occurredAt: null, timeHint: null, durationMin: null, trigger: null, intervention: null, outcome: null,
      details: { amountText: null, isTreat: null, excretionKinds: [], placeText: null }, sourceQuote: input.text, edited: false }],
    safetyFlags: ownerRiskFlags(input.text), clarification: petId ? '원문을 확인하고 사건 종류와 알려진 내용을 직접 입력하세요.' : '어느 반려동물의 기록인가요? 사건별로 선택하세요.', mode: 'manual' };
}

export function validateOwnerDraft(draft: OwnerDraft): string[] {
  const parsed = DraftSchema.safeParse(draft);
  if (!parsed.success) return ['기록 형식, 숫자 범위 또는 필수 정보를 확인하세요.'];
  const errors: string[] = [];
  if (!draft.sourceText.trim()) errors.push('원문이 필요합니다.');
  if (new Set(draft.events.map(event => event.id)).size !== draft.events.length) errors.push('사건 ID가 중복되었습니다.');
  if (ownerRiskFlags(draft.sourceText).some(flag => !draft.safetyFlags.includes(flag))) errors.push('원문 안전 신호를 삭제할 수 없습니다.');
  for (const event of draft.events) {
    if (!event.petId || !draft.pets.some(pet => pet.id === event.petId)) errors.push('사건별 반려동물을 선택하세요.');
    if (!event.sourceQuote.trim() || !draft.sourceText.includes(event.sourceQuote)) errors.push('사건의 정확한 원문 근거가 필요합니다.');
    if (event.durationMin !== null && !groundedDuration(event.sourceQuote, event.durationMin)) errors.push('지속 시간은 원문에 있는 값만 입력하세요.');
    if (event.occurredAt !== null && Date.parse(event.occurredAt) > Date.parse(draft.now)) errors.push('발생 시각은 미래일 수 없습니다.');
    const fields = [event.timeHint, event.intervention, event.details.amountText, event.details.placeText].filter((value): value is string => value !== null);
    const numbers = new Set(event.sourceQuote.match(/\d+(?:\.\d+)?/g) ?? []);
    if (fields.some(value => (value.match(/\d+(?:\.\d+)?/g) ?? []).some(number => !numbers.has(number)))) errors.push('원문에 없는 숫자를 추가할 수 없습니다.');
    if (!event.edited && fields.some(value => !event.sourceQuote.includes(value))) errors.push('자동 추출 필드는 원문의 정확한 구절이어야 합니다.');
    if (fields.some(value => /확진|완치|100\s*%|진단입니다/.test(value) && !event.sourceQuote.includes(value))) errors.push('진단 또는 결과 보장을 추가할 수 없습니다.');
  }
  return [...new Set(errors)];
}
