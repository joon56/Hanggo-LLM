// @vitest-environment node
import { expect, it } from 'vitest';
import { createDraft } from '../src/domain/notes.ts';
import { evaluateDraft } from '../scripts/evaluation.ts';
const expected = { categories: ['observation'], safetyFlags: [], methodReview: false, noTasks: true };
it('does not count a fallback as a successful live AI evaluation', () => {
  const draft = createDraft('관찰했습니다.', 'trainer_summary_text');
  expect(evaluateDraft(draft, expected, true)).toContain('AI 생성 실패 또는 수동 대체');
});
it('detects missed risk flags and category expectations', () => {
  const draft = createDraft('관찰했습니다.', 'trainer_summary_text'); draft.mode = 'ollama';
  const failures = evaluateDraft(draft, { ...expected, safetyFlags: ['통증'], categories: ['task'] }, false);
  expect(failures.join(' ')).toContain('통증');
  expect(failures.join(' ')).toContain('task');
});
