import { z } from 'zod';
import { validateDraft } from '../src/domain/notes.ts';
import type { Draft } from '../src/domain/notes.ts';
import type { createOllamaServices } from '../server/ollama.ts';
import { validateOwnerDraft } from '../src/domain/owner-log.ts';
import { validateShelterDraft } from '../src/domain/shelter.ts';
import { OwnerInputSchema } from '../server/owner-service.ts';
import { BriefInputSchema } from '../server/brief-service.ts';
import { ShelterInputSchema } from '../server/shelter-service.ts';

export const Fixture = z.object({
  id: z.string().regex(/^N\d{2}$/), description: z.string().min(1), text: z.string().min(1).max(8000),
  expect: z.object({ categories: z.array(z.string()), safetyFlags: z.array(z.string()), methodReview: z.boolean(), noTasks: z.boolean() }),
  keyTerms: z.array(z.string()),
});
export type FixtureCase = z.infer<typeof Fixture>;
export function evaluateDraft(draft: Draft, expected: FixtureCase['expect'], fallbackUsed: boolean): string[] {
  const failures = [...validateDraft(draft)];
  if (fallbackUsed || draft.mode !== 'ollama') failures.push('AI 생성 실패 또는 수동 대체');
  for (const category of expected.categories) if (!draft.items.some(item => item.category === category)) failures.push(`분류 누락: ${category}`);
  for (const flag of expected.safetyFlags) if (!draft.safetyFlags.includes(flag)) failures.push(`안전 신호 누락: ${flag}`);
  if (expected.methodReview && !draft.methodReview) failures.push('훈련 방법 검토 누락');
  if (expected.noTasks && draft.items.some(item => item.category === 'task')) failures.push('허용되지 않은 과제');
  if (draft.items.some(item => item.edited || item.text !== item.sourceQuote)) failures.push('AI가 원문 구절을 변경함');
  return failures;
}

export type TextServices = Pick<ReturnType<typeof createOllamaServices>, 'generate' | 'generateOwner' | 'generateBrief' | 'generateShelter'>;
export const featureFiles = ['session-notes', 'owner-logs', 'briefs', 'shelter-profiles'] as const;
// Pick a fixed, visible subset; never choose cases based on a model's outputs.
export const smokeCases: Record<string, string[]> = {
  'session-notes': ['N06', 'N09', 'N11', 'N15', 'N23', 'N29'],
  'owner-logs': ['bark-delivery', 'walk', 'ambiguous-pet', 'multi-events'],
  briefs: ['empty', 'increase'],
  'shelter-profiles': ['one-memo', 'contradiction', 'all-cautions', 'sensitive-context'],
};
export async function evaluateFixture(file: string, fixture: any, services: TextServices): Promise<{ failures: string[]; result: unknown }> {
  const failures: string[] = []; let result: unknown;
  try {
    if (file === 'session-notes') {
      const f = Fixture.parse(fixture), r = await services.generate(f.text, 'trainer_summary_text'); result = r;
      failures.push(...evaluateDraft(r.draft, f.expect, r.fallbackUsed));
      if (r.draft.safetyFlags.some(flag => !f.expect.safetyFlags.includes(flag))) failures.push('기대하지 않은 안전 신호');
      if (r.draft.methodReview !== f.expect.methodReview) failures.push('방법 검토 신호 불일치');
    } else if (file === 'owner-logs') {
      const r = await services.generateOwner(OwnerInputSchema.parse(fixture.input)); result = r;
      failures.push(...validateOwnerDraft({ ...r.draft, events: r.draft.events.map(e => ({ ...e, petId: e.petId ?? r.draft.pets[0].id })) }));
      const expected = fixture.expected ?? fixture.expect ?? {};
      for (const key of ['type', 'durationMin', 'petId', 'occurredAt'] as const) if (key in expected && r.draft.events[0]?.[key] !== expected[key]) failures.push(`사건 ${key} 불일치`);
      for (const flag of expected.safetyFlags ?? []) if (!r.draft.safetyFlags.includes(flag)) failures.push(`안전 신호 누락: ${flag}`);
      if (expected.safetyFlags && r.draft.safetyFlags.some(flag => !expected.safetyFlags.includes(flag))) failures.push('기대하지 않은 안전 신호');
      if (r.fallbackUsed) failures.push('수동 대체');
    } else if (file === 'briefs') {
      const r = await services.generateBrief(BriefInputSchema.parse(fixture.input)); result = r;
      if (r.fallbackUsed) failures.push('코드 집계로 대체');
      const expected = fixture.expect ?? {};
      if ('days' in expected && r.draft.period.daysWithRecords !== expected.days) failures.push('기록 일수 불일치');
      if ('walk' in expected && r.draft.facts.find(f => f.id === 'count:walk')?.value !== expected.walk) failures.push('산책 횟수 불일치');
      if ([...r.draft.summary, ...r.draft.changes, ...r.draft.questionsForOwner].some(line => !line.refs.length || line.refs.some(id => !r.draft.facts.some(f => f.id === id)))) failures.push('잘못된 사실 근거');
    } else {
      const r = await services.generateShelter(ShelterInputSchema.parse(fixture.input)); result = r;
      failures.push(...validateShelterDraft(r.draft));
      const expected = fixture.expect ?? {};
      for (const key of ['people', 'dogs', 'cats'] as const) if (key in expected && r.draft.sociability[key] !== expected[key]) failures.push(`사회성 ${key} 불일치`);
      if ('cautions' in expected && r.draft.cautions.length !== expected.cautions) failures.push('주의 관찰 수 불일치');
      if (expected.safetyFlag && !r.draft.safetyFlags.includes(expected.safetyFlag)) failures.push('안전 신호 누락');
      if (expected.introExclude && r.draft.adopterIntro.text.includes(expected.introExclude)) failures.push('금지된 소개 추론');
      if (r.fallbackUsed) failures.push('원문 규칙으로 대체');
    }
  } catch (error) { failures.push(error instanceof Error ? error.message : '요청 실패'); }
  return { failures, result };
}
