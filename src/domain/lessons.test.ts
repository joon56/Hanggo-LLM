import { expect, it } from 'vitest';
import { createDraft } from './notes';
import { LessonCatalogSchema, suggestLessons, suggestShelterLessons, type Lesson } from './lessons';
import { createManualShelterDraft } from './shelter';
import type { ShelterDraft } from './workspace-types';
const lesson: Lesson = { id: 'test-sit', title: '테스트 앉아', keywords: ['앉아'], species: ['dog'], minAgeMonths: 6, prerequisiteIds: [], contraindications: ['관절'], ownerDescription: '검증용 설명' };
const input = () => ({ draft: createDraft('앉아를 과제로 정했습니다.', 'trainer_summary_text'), species: 'dog' as const, ageMonths: 12, completedLessonIds: [], healthFlags: [] });
it('returns only existing IDs with exact task evidence', () => {
  const context = input(), result = suggestLessons([lesson], context);
  expect(result).toEqual([{ lessonId: lesson.id, title: lesson.title, ownerDescription: lesson.ownerDescription, itemId: context.draft.items[0].id, sourceQuote: context.draft.sourceText }]);
});
it('leaves custom tasks unchanged when catalog is missing or unrelated', () => {
  const context = input(), before = structuredClone(context.draft);
  expect(suggestLessons([], context)).toEqual([]);
  expect(suggestLessons([{ ...lesson, keywords: ['기다려'], title: '기다려' }], context)).toEqual([]);
  expect(context.draft).toEqual(before);
});
it.each(['species', 'age', 'prerequisite', 'health', 'risk', 'method', 'not-task', 'invalid-source'])('blocks unsuitable %s', kind => {
  const context = input(); let catalog = [lesson];
  if (kind === 'species') context.species = 'cat' as 'dog';
  if (kind === 'age') context.ageMonths = 2;
  if (kind === 'prerequisite') catalog = [{ ...lesson, prerequisiteIds: ['base'] }, { ...lesson, id: 'base', title: '다른 것', keywords: [] }];
  if (kind === 'health') context.healthFlags = ['관절'] as never[];
  if (kind === 'risk') context.draft.safetyFlags = ['통증'];
  if (kind === 'method') context.draft.methodReview = true;
  if (kind === 'not-task') context.draft.items[0].category = 'observation';
  if (kind === 'invalid-source') context.draft.items[0].sourceQuote = '날조';
  expect(suggestLessons(catalog, context)).toEqual([]);
});
it('rejects unknown prerequisite IDs and cycles', () => {
  expect(LessonCatalogSchema.safeParse([{ ...lesson, prerequisiteIds: ['missing'] }]).success).toBe(false);
  expect(LessonCatalogSchema.safeParse([{ ...lesson, prerequisiteIds: [lesson.id] }]).success).toBe(false);
  expect(LessonCatalogSchema.safeParse([lesson, lesson]).success).toBe(false);
});
it('rejects unknown pet species and unbounded ages', () => {
  expect(suggestLessons([lesson], { ...input(), species: 'unknown' as 'dog' })).toEqual([]);
  expect(suggestLessons([lesson], { ...input(), ageMonths: NaN })).toEqual([]);
});

const shelterInput = (text = '앉아 신호에 앉았습니다.') => ({
  draft: createManualShelterDraft({ animal: { id: 'dog', name: '보리', species: 'dog', ageMonths: 12 }, memos: [{ id: 'm', date: '2026-09-30', role: 'staff', text }] }),
  completedLessonIds: [] as string[], healthFlags: [] as string[],
});
it('connects shelter observations only to existing grounded lessons without changing profile', () => {
  const context = shelterInput(), before = structuredClone(context.draft);
  expect(suggestShelterLessons([lesson], context)).toEqual([{ lessonId: lesson.id, title: lesson.title, ownerDescription: lesson.ownerDescription, itemId: context.draft.observations[0].id, sourceQuote: context.draft.observations[0].sourceQuote }]);
  expect(suggestShelterLessons([], context)).toEqual([]);
  expect(suggestShelterLessons([{ ...lesson, title: '다른 레슨', keywords: ['산책'] }], context)).toEqual([]);
  expect(context.draft).toEqual(before);
});
it.each(['unknown-age', 'young', 'species', 'health', 'prerequisite', 'safety', 'method', 'ungrounded'])('blocks unsuitable shelter lesson: %s', kind => {
  let context = shelterInput(); let catalog = [lesson];
  if (kind === 'unknown-age') context.draft.animal.ageMonths = null;
  if (kind === 'young') context.draft.animal.ageMonths = 1;
  if (kind === 'species') context.draft.animal.species = 'cat';
  if (kind === 'health') context.healthFlags = ['관절'];
  if (kind === 'prerequisite') catalog = [{ ...lesson, prerequisiteIds: ['base'] }, { ...lesson, id: 'base', title: '다른 것', keywords: [] }];
  if (kind === 'safety') context = shelterInput('앉아 연습 중 구토했습니다.');
  if (kind === 'method') context = shelterInput('앉아를 안 해서 체벌했습니다.');
  if (kind === 'ungrounded') context.draft.observations[0].sourceQuote = '앉아를 날조함';
  expect(suggestShelterLessons(catalog, context)).toEqual([]);
});
it('allows shelter prerequisite only when completed', () => {
  const context = shelterInput(); context.completedLessonIds = ['base'];
  expect(suggestShelterLessons([{ ...lesson, prerequisiteIds: ['base'] }, { ...lesson, id: 'base', title: '다른 것', keywords: [] }], context).map(value => value.lessonId)).toEqual([lesson.id]);
});
it('handles malformed shelter draft safely', () => {
  expect(suggestShelterLessons([lesson], { draft: null as unknown as ShelterDraft, completedLessonIds: [], healthFlags: [] })).toEqual([]);
});
it.each(['앉아 제외하고 기다려를 과제로 정했습니다.', '앉아 빼고 기다려를 과제로 정했습니다.', '앉아는 보류하고 기다려를 과제로 정했습니다.'])('does not match rejected trainer lesson in %s', text => {
  const context = { ...input(), draft: createDraft(text, 'trainer_summary_text') };
  expect(suggestLessons([lesson], context)).toEqual([]);
});
it.each(['앉아는 제외하고 기다려를 연습함.', '앉아는 하지 않음.', '앉아 연습을 거부함.'])('does not match negated shelter method in %s', text => {
  expect(suggestShelterLessons([lesson], shelterInput(text))).toEqual([]);
});
