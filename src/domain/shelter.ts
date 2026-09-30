import { z } from 'zod';
import { createManualDraft, getReviewSignals } from './notes.ts';
import type { ShelterInput, ShelterDraft, ShelterObservation, EvidenceText, Sociality } from './workspace-types.ts';

const text = z.string().trim().min(1).max(2000);
const safetyFlagsSchema = z.array(z.enum(['통증', '구토', '출혈', '절뚝거림', '갑작스러운 공격성', '호흡 곤란', '발작', '설사', '식욕 저하', '물림']));
const generationSchema = z.object({ requestId: text, model: text, promptVersion: text, latencyMs: z.number().finite().min(0), fallbackUsed: z.boolean() }).strict();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => { const d = new Date(`${v}T00:00:00Z`); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v; });
export const ShelterInputSchema = z.object({
  animal: z.object({ id: text, name: text, species: z.enum(['dog', 'cat']), ageMonths: z.number().int().min(0).max(600).nullable() }).strict(),
  memos: z.array(z.object({ id: text, date, role: z.enum(['staff', 'volunteer']), text: z.string().min(1).max(8000).refine(v => !!v.trim()) }).strict()).min(1).max(100),
}).strict().refine(v => new Set(v.memos.map(m => m.id)).size === v.memos.length, '메모 ID는 중복될 수 없습니다.').refine(v => v.memos.reduce((n, m) => n + m.text.length, 0) <= 32000, '메모 원문은 총 32000자 이하입니다.');
const cautionPattern = /짖|으르렁|물었|물림|깨물|피함|피하|싫어|무서|겁|경계|불편|공격|통증|구토|출혈|절뚝|설사|발작|안\s*먹|못\s*쉬|혼내|체벌|때리|불안|긁|할퀴|숨(?:음|었)|도망|거부|싫음|싫다/i;
const positivePattern = /좋아|잘\s*놀|순하|순함|다가|편안|잘\s*잠|잘\s*쉼|꼬리.*흔|조용/i;
const negationPattern = /지\s*않|지\s*못|안\s+|못\s+|아니|없/;
const unsupported = /(?:품종|진돗개|푸들|리트리버|외모|나이).*(?:라서|라\s*그런지|때문|성격|충성)|진단|확진|완치|100\s*%|반드시|완벽|최고|천사|문제견|공격견|때문|인\s*것\s*같|듯[.\s]?|추측|추정/i;
const categories: [ShelterObservation['category'], RegExp][] = [['people', /사람|직원|봉사자|아이들|낯선\s*분/], ['dogs', /다른\s*개|강아지|다른\s*견/], ['cats', /고양이/], ['handling', /만지|발을|발\s|빗질|목욕/], ['food', /간식|밥|먹이|급식/], ['alone', /혼자|부재/], ['noise', /소리|소음/], ['walk', /산책/], ['house', /켄넬|집|잠|쉼/]];
export function classifyShelterQuote(quote: string): Pick<ShelterObservation, 'category' | 'valence'> {
  if (unsupported.test(quote)) return { category: 'other', valence: cautionPattern.test(quote) ? 'caution' : 'neutral' };
  return { category: categories.find(([, pattern]) => pattern.test(quote))?.[0] ?? 'other', valence: cautionPattern.test(quote) || (positivePattern.test(quote) && negationPattern.test(quote)) ? 'caution' : positivePattern.test(quote) ? 'positive' : 'neutral' };
}
export function shelterRisk(text: string): string[] {
  // Scan the complete text, so a keyword or phrase cannot fall between chunks.
  return getReviewSignals({ ...createManualDraft('검토', 'trainer_summary_text'), sourceText: text, items: [] }).safetyFlags;
}
function evidence(o: ShelterObservation): EvidenceText { return { text: o.text, sourceQuote: o.sourceQuote, memoId: o.memoId, memoDate: o.memoDate }; }
export function deriveShelterProfile(observations: ShelterObservation[]): Pick<ShelterDraft, 'sociability' | 'likes' | 'cautions' | 'unknowns' | 'adopterIntro'> {
  const sociability = Object.fromEntries(['people', 'dogs', 'cats'].map(category => {
    const rows = observations.filter(o => o.category === category), positive = rows.some(o => o.valence === 'positive'), caution = rows.some(o => o.valence === 'caution');
    const value: Sociality = positive && caution ? 'mixed' : caution ? 'observed_caution' : positive ? 'observed_positive' : 'unknown';
    return [category, value];
  })) as ShelterDraft['sociability'];
  const likes = observations.filter(o => o.valence === 'positive' && !unsupported.test(o.sourceQuote)).map(evidence);
  const cautions = observations.filter(o => o.valence === 'caution').map(evidence);
  const unknowns = Object.entries(sociability).filter(([, value]) => value === 'unknown').map(([category]) => `${({ people: '사람', dogs: '다른 개', cats: '고양이' } as Record<string, string>)[category]}와의 사회성 판단 기록이 없어요.`);
  if (!observations.some(o => o.category === 'alone')) unknowns.push('혼자 있는 시간에 대한 기록이 없어요.');
  return { sociability, likes, cautions, unknowns, adopterIntro: { text: likes.length ? likes.map(o => o.text).join(' ') : '관찰 기록을 확인해 주세요.', cautionLine: cautions.map(o => o.text).join(' ') } };
}
function memoSentences(source: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    const decimal = char === '.' && /\d/.test(source[index - 1] ?? '') && /\d/.test(source[index + 1] ?? '');
    if (char === '\n' || (/[.!?。！？]/.test(char) && !decimal)) {
      const quote = source.slice(start, char === '\n' ? index : index + 1).trim();
      if (quote) sentences.push(quote);
      start = index + 1;
    }
  }
  const tail = source.slice(start).trim();
  if (tail) sentences.push(tail);
  return sentences;
}
export function createManualShelterDraft(input: ShelterInput): ShelterDraft {
  const valid = ShelterInputSchema.parse(input);
  const observations: ShelterObservation[] = valid.memos.flatMap(memo => memoSentences(memo.text).map(sourceQuote => ({ id: crypto.randomUUID(), ...classifyShelterQuote(sourceQuote), text: sourceQuote, sourceQuote, memoId: memo.id, memoDate: memo.date, edited: false })));
  return { id: crypto.randomUUID(), ...valid, observations, ...deriveShelterProfile(observations), safetyFlags: shelterRisk(valid.memos.map(m => m.text).join('\n')), mode: 'manual' };
}
export function validateShelterDraft(draft: ShelterDraft): string[] {
  const errors: string[] = [];
  try {
    if (!draft || !ShelterInputSchema.safeParse({ animal: draft.animal, memos: draft.memos }).success || typeof draft.id !== 'string' || !draft.id.trim() || !['manual', 'openai', 'ollama', 'demo'].includes(draft.mode)) return ['프로필 기본 정보가 올바르지 않습니다.'];
    if (!Array.isArray(draft.observations) || !draft.observations.length || draft.observations.length > 1000 || !safetyFlagsSchema.safeParse(draft.safetyFlags).success) return ['관찰 또는 안전 정보가 올바르지 않습니다.'];
    const ids = new Set<string>();
    for (const o of draft.observations) {
      const memo = draft.memos.find(m => m.id === o.memoId);
      if (!memo || typeof o.id !== 'string' || !o.id.trim() || ids.has(o.id) || typeof o.sourceQuote !== 'string' || !o.sourceQuote.trim() || !memo.text.includes(o.sourceQuote) || o.memoDate !== memo.date || typeof o.text !== 'string' || !o.text.trim() || !o.sourceQuote.includes(o.text) || typeof o.edited !== 'boolean' || (!o.edited && o.text !== o.sourceQuote)) { errors.push('관찰 원문 근거를 확인하세요.'); continue; }
      ids.add(o.id);
      const classified = classifyShelterQuote(o.sourceQuote);
      if (o.valence !== classified.valence || o.category !== classified.category) errors.push('관찰 분류는 원문 근거와 같아야 합니다.');
      if (o.valence === 'caution' && o.text !== o.sourceQuote) errors.push('주의사항 원문을 줄이거나 약화할 수 없습니다.');
    }
    const baseline = createManualShelterDraft({ animal: draft.animal, memos: draft.memos });
    for (const caution of baseline.cautions) if (!draft.observations.some(o => o.memoId === caution.memoId && o.sourceQuote === caution.sourceQuote && o.valence === 'caution')) errors.push('원문 주의사항을 삭제할 수 없습니다.');
    const expected = deriveShelterProfile(draft.observations);
    for (const field of ['sociability', 'likes', 'cautions', 'unknowns', 'adopterIntro'] as const) if (JSON.stringify(draft[field]) !== JSON.stringify(expected[field])) errors.push('소개와 주의사항은 관찰 근거를 모두 보존해야 합니다.');
    if (baseline.safetyFlags.some(flag => !draft.safetyFlags.includes(flag))) errors.push('안전 신호를 삭제할 수 없습니다.');
    if (draft.generation !== undefined && !generationSchema.safeParse(draft.generation).success) errors.push('생성 정보가 올바르지 않습니다.');
  } catch { errors.push('프로필 형식이 올바르지 않습니다.'); }
  return [...new Set(errors)];
}
