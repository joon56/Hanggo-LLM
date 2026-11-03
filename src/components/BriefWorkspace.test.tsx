import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import BriefWorkspace from './BriefWorkspace';
import type { BriefDraft, SavedOwnerLog } from '../domain/workspace-types';
import { createDraft } from '../domain/notes';

const api = vi.hoisted(() => ({ generate: vi.fn(), choices: vi.fn(), context: vi.fn(), compute: vi.fn(), notesError: null as Error | null, notes: [] as unknown[] }));
vi.mock('../feature-api', () => ({ generateBrief: api.generate }));

const records: SavedOwnerLog[] = [{
  id: 'log-1', savedAt: '2026-09-29T10:00:00.000Z', draft: {
    id: 'draft-1', sourceText: '초코가 5분 산책했어요.', sourceKind: 'nl_log_text', pets: [{ id: 'pet-1', name: '초코', nicknames: [] }], now: '2026-09-29T10:00:00.000Z', timeZone: 'Asia/Seoul',
    events: [{ id: 'event-1', petId: 'pet-1', type: 'walk', occurredAt: '2026-09-29T09:00:00.000Z', timeHint: null, durationMin: 5, trigger: null, intervention: null, outcome: null, details: { amountText: null, isTreat: null, excretionKinds: [], placeText: null }, sourceQuote: '초코가 5분 산책했어요.', edited: false }],
    safetyFlags: [], clarification: null, mode: 'manual',
  },
}];
const draft: BriefDraft = { id: 'brief-1', petId: 'pet-1', period: { from: '2026-09-17', to: '2026-09-30', daysWithRecords: 1 }, facts: [{ id: 'count:walk', label: '산책 횟수', value: 1, unit: '건', previousValue: null, refs: ['event-1'] }], summary: [{ text: '산책 횟수: 1건.', refs: ['count:walk'] }], changes: [], questionsForOwner: [], previousTasks: [], cautions: [], dataGaps: [], safetyFlags: [], mode: 'manual' };

vi.mock('../domain/owner-storage', () => ({ listPets: () => [{ id: 'pet-1', name: '초코', nicknames: [] }, { id: 'pet-2', name: '보리', nicknames: [] }], listOwnerLogs: () => records }));
vi.mock('../domain/storage', () => ({ listNotes: () => { if (api.notesError) throw api.notesError; return api.notes; } }));
vi.mock('../domain/brief', () => ({ computeBrief: api.compute }));

beforeEach(() => { vi.clearAllMocks(); api.notes = []; api.notesError = null; api.compute.mockImplementation(() => draft); });

test('summary fact reference opens original owner event quote', async () => {
  render(<BriefWorkspace aiReady={false} />);
  const section = screen.getByRole('heading', { name: '핵심 3줄' }).closest('section')!;
  await userEvent.click(within(section).getByRole('button', { name: '근거 보기' }));
  expect(screen.getByRole('status')).toHaveTextContent('초코가 5분 산책했어요.');
});

test('legacy approved note is optional and never selected by matching name', async () => {
  api.notes = [{ id: 'legacy', metadata: { petName: '초코', trainerName: '김', sessionDate: '2026-09-25' }, draft: createDraft('과제를 하기로 했다.', 'trainer_summary_text'), approvedAt: '2026-09-25T00:00:00Z' }];
  api.generate.mockResolvedValue({ draft, fallbackUsed: false, warnings: [] });
  render(<BriefWorkspace aiReady />);
  expect(screen.getByLabelText('확정 상담일지 (선택 사항)')).toHaveValue('');
  await userEvent.click(screen.getByRole('checkbox'));
  await userEvent.click(screen.getByRole('button', { name: 'AI 브리핑 만들기' }));
  expect(api.generate.mock.calls[0][0].previousSession).toBeUndefined();
});
test('ignores late generation after pet change or cancellation', async () => {
  let complete!: (value: unknown) => void;
  api.generate.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  render(<BriefWorkspace aiReady />);
  await userEvent.click(screen.getByRole('checkbox'));
  await userEvent.click(screen.getByRole('button', { name: 'AI 브리핑 만들기' }));
  await userEvent.selectOptions(screen.getByLabelText('반려동물'), 'pet-2');
  await act(async () => { complete({ draft: { ...draft, summary: [{ text: '오래된 응답', refs: [] }] }, fallbackUsed: false, warnings: [] }); });
  expect(screen.queryByText('오래된 응답')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'AI 브리핑 만들기' }));
  await userEvent.click(screen.getByRole('button', { name: '생성 취소' }));
  await act(async () => { complete({ draft: { ...draft, summary: [{ text: '취소된 응답', refs: [] }] }, fallbackUsed: false, warnings: [] }); });
  expect(screen.queryByText('취소된 응답')).not.toBeInTheDocument();
});
for (const mutation of ['deleted', 'replaced', 'unreadable'] as const) {
  for (const outcome of ['success', 'rejection'] as const) test(`invalidates ${mutation} legacy approval during ${outcome} instead of stale result or fallback`, async () => {
    const note = { id: 'legacy', metadata: { petName: '초코', trainerName: '김', sessionDate: '2026-09-25' }, draft: createDraft('초인종 때 짖었다.', 'trainer_summary_text'), approvedAt: '2026-09-25T00:00:00Z' };
    api.notes = [note];
    let complete!: (value: unknown) => void, reject!: (error: Error) => void;
    api.generate.mockImplementation(() => new Promise((resolve, fail) => { complete = resolve; reject = fail; }));
    render(<BriefWorkspace aiReady />);
    await userEvent.selectOptions(screen.getByLabelText('확정 상담일지 (선택 사항)'), 'legacy:legacy');
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: 'AI 브리핑 만들기' }));
    if (mutation === 'deleted') api.notes = [];
    if (mutation === 'replaced') api.notes = [{ ...note, approvedAt: '2026-09-26T00:00:00Z' }];
    if (mutation === 'unreadable') api.notesError = new Error('저장된 기록이 손상되어 읽을 수 없습니다.');
    api.compute.mockClear();
    await act(async () => {
      if (outcome === 'success') complete({ draft: { ...draft, summary: [{ text: '오래된 상담 응답', refs: [] }] }, fallbackUsed: false, warnings: [] });
      else reject(new Error('offline'));
    });
    expect(screen.getByLabelText('확정 상담일지 (선택 사항)')).toHaveValue('');
    expect(await screen.findByRole('alert')).toHaveTextContent('다시 선택');
    expect(screen.queryByText('오래된 상담 응답')).not.toBeInTheDocument();
    expect(screen.queryByText(/코드 기반 대체 브리핑입니다/)).not.toBeInTheDocument();
    expect(api.compute.mock.calls.some(([input]) => input.previousSession)).toBe(false);
  });
}

test('invalidates unreadable legacy storage before generation instead of old-input fallback', async () => {
  api.notes = [{ id: 'legacy', metadata: { petName: '초코', trainerName: '김', sessionDate: '2026-09-25' }, draft: createDraft('초인종 때 짖었다.', 'trainer_summary_text'), approvedAt: '2026-09-25T00:00:00Z' }];
  render(<BriefWorkspace aiReady />);
  await userEvent.selectOptions(screen.getByLabelText('확정 상담일지 (선택 사항)'), 'legacy:legacy');
  await userEvent.click(screen.getByRole('checkbox'));
  api.notesError = new Error('저장된 기록을 읽을 수 없습니다.');
  api.compute.mockClear();
  await userEvent.click(screen.getByRole('button', { name: 'AI 브리핑 만들기' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('다시 선택');
  expect(screen.getByLabelText('확정 상담일지 (선택 사항)')).toHaveValue('');
  expect(api.generate).not.toHaveBeenCalled();
  expect(screen.queryByText(/코드 기반 대체 브리핑입니다/)).not.toBeInTheDocument();
  expect(api.compute.mock.calls.some(([input]) => input.previousSession)).toBe(false);
});
