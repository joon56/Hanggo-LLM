import { z } from 'zod';
import { createDraft, getReviewSignals, validateDraft, type Draft } from './notes.ts';
import { validateShelterDraft } from './shelter.ts';
import type { ShelterDraft } from './workspace-types.ts';

export const LessonSchema = z.object({
  id: z.string().trim().min(1).max(100), title: z.string().trim().min(1).max(200),
  keywords: z.array(z.string().trim().min(1).max(100)).max(30),
  species: z.array(z.enum(['dog', 'cat'])).min(1).max(2), minAgeMonths: z.number().int().min(0).max(600),
  prerequisiteIds: z.array(z.string().min(1).max(100)).max(100), contraindications: z.array(z.string().trim().min(1).max(100)).max(100),
  ownerDescription: z.string().trim().min(1).max(4000),
}).strict();
export type Lesson = z.infer<typeof LessonSchema>;
export const LessonCatalogSchema = z.array(LessonSchema).max(100).superRefine((lessons, context) => {
  const byId = new Map(lessons.map(lesson => [lesson.id, lesson]));
  if (byId.size !== lessons.length) context.addIssue({ code: 'custom', message: '레슨 ID가 중복되었습니다.' });
  const visited = new Set<string>(), visiting = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    const lesson = byId.get(id); if (!lesson) return false;
    visiting.add(id);
    for (const prerequisite of lesson.prerequisiteIds) if (!visit(prerequisite)) return false;
    visiting.delete(id); visited.add(id); return true;
  };
  if (lessons.some(lesson => !visit(lesson.id))) context.addIssue({ code: 'custom', message: '선행 레슨이 없거나 순환 참조가 있습니다.' });
});
export type LessonSuggestionInput = { draft: Draft; species: 'dog' | 'cat'; ageMonths: number; completedLessonIds: string[]; healthFlags: string[] };
export type LessonSuggestion = { lessonId: string; title: string; ownerDescription: string; itemId: string; sourceQuote: string };
const ContextSchema = z.object({ species: z.enum(['dog', 'cat']), ageMonths: z.number().int().min(0).max(600), completedLessonIds: z.array(z.string().min(1).max(100)).max(100), healthFlags: z.array(z.string().min(1).max(100)).max(100) });
function eligibleLessons(catalog: Lesson[], input: z.infer<typeof ContextSchema>): Lesson[] {
  const completed = new Set(input.completedLessonIds), health = new Set(input.healthFlags);
  return catalog.filter(lesson => lesson.species.includes(input.species) && lesson.minAgeMonths <= input.ageMonths &&
    lesson.prerequisiteIds.every(id => completed.has(id)) && !lesson.contraindications.some(flag => health.has(flag)));
}
function matchesLesson(lesson: Lesson, quote: string, source: string): boolean {
  let start = source.indexOf(quote), end = start + quote.length;
  if (start < 0) return false;
  while (start > 0 && !/[\n.!?。！？]/.test(source[start - 1])) start--;
  while (end < source.length && !/[\n.!?。！？]/.test(source[end])) end++;
  // Do not turn a rejected method into a recommendation. Ambiguous mixed
  // sentences remain available as the original observation/custom task.
  if (/제외|빼고|빼기로|빼자|취소|보류|거부|원하지|싫|지\s*않|지\s*말|안\s*(?:하|해|했)|아니|\b(?:not|without|except|cancel)\b/i.test(source.slice(start, end))) return false;
  return [lesson.title, ...lesson.keywords].some(term => quote.includes(term));
}

export function suggestLessons(catalog: Lesson[], input: LessonSuggestionInput): LessonSuggestion[] {
  const parsed = LessonCatalogSchema.safeParse(catalog);
  if (!parsed.success || !input || !ContextSchema.safeParse(input).success || validateDraft(input.draft).length) return [];
  const risk = getReviewSignals(input.draft);
  if (risk.safetyFlags.length || risk.methodReview) return [];
  const candidates = eligibleLessons(parsed.data, input);
  return input.draft.items.filter(item => item.category === 'task').flatMap(item =>
    candidates.filter(lesson => matchesLesson(lesson, item.sourceQuote, input.draft.sourceText)).map(lesson => ({
      lessonId: lesson.id, title: lesson.title, ownerDescription: lesson.ownerDescription, itemId: item.id, sourceQuote: item.sourceQuote,
    })));
}

export type ShelterLessonSuggestionInput = { draft: ShelterDraft; completedLessonIds: string[]; healthFlags: string[] };
export function suggestShelterLessons(catalog: Lesson[], input: ShelterLessonSuggestionInput): LessonSuggestion[] {
  const parsed = LessonCatalogSchema.safeParse(catalog);
  if (!parsed.success || !input || validateShelterDraft(input.draft).length || input.draft.safetyFlags.length) return [];
  const context = ContextSchema.safeParse({ ...input, species: input.draft.animal.species, ageMonths: input.draft.animal.ageMonths });
  if (!context.success) return [];
  // Shelter profiles have no methodReview field; inspect every original memo.
  // This also prevents an omitted observation from hiding a coercive method.
  if (input.draft.memos.some(memo => {
    const risk = getReviewSignals(createDraft(memo.text, 'trainer_summary_text'));
    return risk.methodReview || risk.safetyFlags.length > 0;
  })) return [];
  const candidates = eligibleLessons(parsed.data, context.data);
  return input.draft.observations.flatMap(observation => candidates
    .filter(lesson => matchesLesson(lesson, observation.sourceQuote, input.draft.memos.find(memo => memo.id === observation.memoId)!.text))
    .map(lesson => ({ lessonId: lesson.id, title: lesson.title, ownerDescription: lesson.ownerDescription,
      itemId: observation.id, sourceQuote: observation.sourceQuote })));
}
