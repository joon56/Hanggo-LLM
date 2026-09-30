// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { createNoteService, maskPii } from './service.ts';

const source = '오늘 앉아를 관찰했습니다.';
const result = { items: [{ category: 'observation', sourceQuote: source }], safetyFlags: [], methodReview: false };
it('accepts only exact evidence and attaches real generation provenance', async () => {
  const extract = vi.fn().mockResolvedValue(result);
  const response = await createNoteService({ extract, model: 'test' }).generate(source, 'trainer_summary_text');
  expect(response.draft.items[0].text).toBe(source);
  expect(response.draft.mode).toBe('openai');
  expect(response.fallbackUsed).toBe(false);
  expect(response.draft.generation?.requestId).toBe(response.requestId);
});
it('retries invented evidence once then returns clearly marked manual review', async () => {
  const extract = vi.fn().mockResolvedValue({ ...result, items: [{ category: 'task', sourceQuote: '없는 과제' }] });
  const response = await createNoteService({ extract, model: 'test' }).generate(source, 'trainer_summary_text');
  expect(extract).toHaveBeenCalledTimes(2);
  expect(response.fallbackUsed).toBe(true);
  expect(response.draft.mode).toBe('manual');
  expect(response.draft.items.every(item => item.category === 'follow_up')).toBe(true);
});
it('preserves rule and model risk flags, removing task classification', async () => {
  const text = '초코가 절뚝거립니다. 이번 주 과제는 앉아를 반복하기로 했습니다.';
  const response = await createNoteService({ model: 'test', extract: async () => ({
    items: [{ category: 'task', sourceQuote: '이번 주 과제는 앉아를 반복하기로 했습니다.' }],
    safetyFlags: ['통증'], methodReview: false,
  }) }).generate(text, 'trainer_summary_text');
  expect(response.draft.safetyFlags).toEqual(expect.arrayContaining(['통증', '절뚝거림']));
  expect(response.draft.items[0].category).toBe('follow_up');
});
it('does not retry authentication or transport failures as schema repair', async () => {
  const extract = vi.fn().mockRejectedValue(new Error('provider-secret-message'));
  const response = await createNoteService({ extract, model: 'test' }).generate(source, 'trainer_summary_text');
  expect(extract).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(response)).not.toContain('provider-secret');
  expect(response.fallbackUsed).toBe(true);
});
it('masks contact information without moving evidence offsets', async () => {
  const text = '보호자 연락처 010-1234-5678, a@example.com. 서울시 강남구 테헤란로 123에서 상담했습니다.';
  expect(maskPii(text).length).toBe(text.length);
  expect(maskPii(text)).not.toContain('1234');
  expect(maskPii(text)).not.toContain('example.com');
  expect(maskPii(text)).not.toContain('테헤란로 123');
  const extract = vi.fn(async (masked: string) => ({ items: [{ category: 'owner_report', sourceQuote: masked }], safetyFlags: [], methodReview: false }));
  const response = await createNoteService({ extract, model: 'test' }).generate(text, 'trainer_summary_text');
  expect(extract.mock.calls[0][0]).not.toContain('010-1234');
  expect(response.draft.items[0].sourceQuote).toBe(text);
});
it('aborts without producing fallback after cancellation', async () => {
  const controller = new AbortController(); controller.abort();
  const extract = vi.fn();
  await expect(createNoteService({ extract, model: 'test' }).generate(source, 'trainer_summary_text', controller.signal)).rejects.toThrow();
  expect(extract).not.toHaveBeenCalled();
});

it.each(['관찰했습니다. '.repeat(101), '가'.repeat(2000) + ' '.repeat(2000) + '나'])('keeps fallback editable for long valid input', async text => {
  const { validateDraft } = await import('../src/domain/notes.ts');
  const response = await createNoteService({ model: 'test', extract: async () => { throw new Error(); } }).generate(text, 'trainer_summary_text');
  expect(validateDraft(response.draft)).toEqual([]);
  expect(response.draft.items.every(item => text.includes(item.sourceQuote))).toBe(true);
});

it('retains known risk fields even if unrelated model fields are malformed', async () => {
  const extract = vi.fn().mockResolvedValueOnce({ items: [{ category: 'invalid', sourceQuote: source }], safetyFlags: ['통증'], methodReview: true }).mockResolvedValueOnce(result);
  const response = await createNoteService({ model: 'test', extract }).generate(source, 'trainer_summary_text');
  expect(response.draft.safetyFlags).toContain('통증');
  expect(response.draft.methodReview).toBe(true);
});
