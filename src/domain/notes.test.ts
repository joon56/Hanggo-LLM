import { describe, expect, it } from 'vitest';
import { approveDraft, createDraft, getReviewSignals, validateDraft, type Draft } from './notes';

describe('createDraft', () => {
  it('extracts only source sentences with exact provenance', () => {
    const source = '보호자가 산책 중 짖었다고 말했습니다. 오늘 앉아를 연습했습니다. 다음 시간에 다시 확인합니다.';
    const draft = createDraft(source, 'trainer_summary_text');
    expect(draft.items.map(({ category, text, sourceQuote }) => ({ category, text, sourceQuote }))).toEqual([
      { category: 'owner_report', text: '보호자가 산책 중 짖었다고 말했습니다.', sourceQuote: '보호자가 산책 중 짖었다고 말했습니다.' },
      { category: 'observation', text: '오늘 앉아를 연습했습니다.', sourceQuote: '오늘 앉아를 연습했습니다.' },
      { category: 'follow_up', text: '다음 시간에 다시 확인합니다.', sourceQuote: '다음 시간에 다시 확인합니다.' },
    ]);
    expect(draft.mode).toBe('demo');
    expect(validateDraft(draft)).toEqual([]);
  });

  it('routes health and coercive-method tasks to follow-up and keeps source flags', () => {
    const draft = createDraft('다리를 절뚝입니다. 아프더라도 목줄을 강하게 당겨 연습하세요.', 'trainer_summary_voice');
    expect(draft.items.map(item => item.category)).toEqual(['follow_up', 'follow_up']);
    expect(draft.safetyFlags.length).toBeGreaterThan(0);
    expect(draft.methodReview).toBe(true);
    expect(validateDraft({ ...draft, safetyFlags: [], methodReview: false })).not.toEqual([]);
    expect(validateDraft({ ...draft, items: draft.items.map(item => ({ ...item, category: 'task' })) })).not.toEqual([]);
  });

  it('keeps all tasks in follow-up when any source sentence signals risk', () => {
    const draft = createDraft('초코가 다리를 절뚝거려요. 이번 주 과제는 산책 30분입니다.', 'trainer_summary_text');
    expect(draft.items.map(item => item.category)).toEqual(['follow_up', 'follow_up']);
    expect(validateDraft({ ...draft, items: [{ ...draft.items[0] }, { ...draft.items[1], category: 'task' }] })).not.toEqual([]);
  });

  it('recognizes common urgent symptoms and keeps decimal values in one quote', () => {
    const draft = createDraft('호흡 곤란과 발작이 있었습니다. 사료를 안 먹고 설사를 했습니다. 2.5km 걸었습니다.', 'trainer_summary_text');
    expect(draft.safetyFlags).toEqual(expect.arrayContaining(['호흡 곤란', '발작', '설사', '식욕 저하']));
    expect(draft.items).toHaveLength(3);
    expect(draft.items[2].sourceQuote).toBe('2.5km 걸었습니다.');
  });

  it('preserves quoted diagnostic language for review', () => {
    const draft = createDraft('훈련사가 분리불안 확진이라고 말했습니다.', 'trainer_summary_text');
    expect(draft.items[0].category).toBe('follow_up');
    expect(validateDraft(draft)).toEqual([]);
    expect(validateDraft({ ...draft, items: [{ ...draft.items[0], category: 'observation' }] })).not.toEqual([]);
  });

  it('classifies only agreed homework as a task', () => {
    const source = '이번 주 과제는 아직 정하지 않았습니다. 산책 과제는 하지 않기로 했습니다. 매일 짖었습니다. 이번 주 과제는 상담에서 연습한 앉아를 같은 조건에서 반복하기로 했습니다.';
    const draft = createDraft(source, 'trainer_summary_text');
    expect(draft.items.map(item => item.category)).toEqual(['follow_up', 'follow_up', 'follow_up', 'task']);
    expect(validateDraft({ ...draft, items: draft.items.map((item, index) => index === 0 ? { ...item, category: 'task' } : item) })).not.toEqual([]);
  });

  it('blocks tasks when an edit adds a health or coercive-method signal', () => {
    const draft = createDraft('이번 주 과제는 앉아를 반복하기로 했습니다.', 'trainer_summary_text');
    const healthEdit = { ...draft, items: [{ ...draft.items[0], text: '아프지만 앉아를 반복하기로 했습니다.', edited: true }] };
    expect(getReviewSignals(healthEdit).safetyFlags).toContain('통증');
    expect(validateDraft(healthEdit)).not.toEqual([]);
    const methodEdit = { ...draft, items: [{ ...draft.items[0], text: '목줄을 세게 당겨 앉아를 반복하기로 했습니다.', edited: true }] };
    expect(getReviewSignals(methodEdit).methodReview).toBe(true);
    expect(validateDraft(methodEdit)).not.toEqual([]);
    const demoted = { ...methodEdit, items: [{ ...methodEdit.items[0], category: 'follow_up' as const }] };
    const approved = approveDraft(demoted, { petName: '몽이', trainerName: '김훈련', sessionDate: '2026-09-28' }, true);
    expect(approved.draft.methodReview).toBe(true);
  });

  it('rejects unsupported numeric edits, invented provenance, and generated diagnosis', () => {
    const draft = createDraft('보호자가 산책했다고 말했습니다.', 'trainer_summary_text');
    expect(validateDraft({ ...draft, items: [{ ...draft.items[0], text: '산책 30분' }] })).not.toEqual([]);
    expect(validateDraft({ ...draft, items: [{ ...draft.items[0], sourceQuote: '없는 원문' }] })).not.toEqual([]);
    expect(validateDraft({ ...draft, items: [{ ...draft.items[0], text: '분리불안 확진입니다.' }] })).not.toEqual([]);
  });

  it('requires valid source and structure', () => {
    expect(() => createDraft('   ', 'trainer_summary_text')).toThrow();
    expect(() => createDraft('가'.repeat(8001), 'trainer_summary_text')).toThrow();
    expect(() => createDraft('문장.', 'other' as Draft['sourceKind'])).toThrow();
    const draft = createDraft('문장.', 'trainer_summary_text');
    expect(validateDraft({ ...draft, sourceKind: 'other' as Draft['sourceKind'] })).not.toEqual([]);
  });
});

describe('approveDraft', () => {
  it('requires review and complete valid metadata, then snapshots the draft', () => {
    const draft = createDraft('오늘 앉아를 연습했습니다.', 'trainer_summary_text');
    const metadata = { petName: '몽이', trainerName: '김훈련', sessionDate: '2026-09-28' };
    expect(() => approveDraft(draft, metadata, false)).toThrow();
    expect(() => approveDraft(draft, { ...metadata, sessionDate: '2026-02-30' }, true)).toThrow();
    expect(() => approveDraft(draft, { ...metadata, petName: ' ' }, true)).toThrow();
    const note = approveDraft(draft, metadata, true);
    draft.items[0].text = '변경';
    metadata.petName = '변경';
    expect(note.draft.items[0].text).toBe('오늘 앉아를 연습했습니다.');
    expect(note.metadata.petName).toBe('몽이');
    expect(note.mode).toBe('demo');
  });
});
