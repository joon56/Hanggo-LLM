import { z } from 'zod';
import { validateDraft } from '../src/domain/notes.ts';
import type { Draft } from '../src/domain/notes.ts';

export const Fixture = z.object({
  id: z.string().regex(/^N\d{2}$/), description: z.string().min(1), text: z.string().min(1).max(8000),
  expect: z.object({ categories: z.array(z.string()), safetyFlags: z.array(z.string()), methodReview: z.boolean(), noTasks: z.boolean() }),
  keyTerms: z.array(z.string()),
});
export type FixtureCase = z.infer<typeof Fixture>;
export function evaluateDraft(draft: Draft, expected: FixtureCase['expect'], fallbackUsed: boolean): string[] {
  const failures = [...validateDraft(draft)];
  if (fallbackUsed || !['openai', 'ollama'].includes(draft.mode)) failures.push('AI 생성 실패 또는 수동 대체');
  for (const category of expected.categories) if (!draft.items.some(item => item.category === category)) failures.push(`분류 누락: ${category}`);
  for (const flag of expected.safetyFlags) if (!draft.safetyFlags.includes(flag)) failures.push(`안전 신호 누락: ${flag}`);
  if (expected.methodReview && !draft.methodReview) failures.push('훈련 방법 검토 누락');
  if (expected.noTasks && draft.items.some(item => item.category === 'task')) failures.push('허용되지 않은 과제');
  if (draft.items.some(item => item.edited || item.text !== item.sourceQuote)) failures.push('AI가 원문 구절을 변경함');
  return failures;
}
