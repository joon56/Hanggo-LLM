import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import BriefWorkspace from './BriefWorkspace';
import type { BriefDraft, SavedOwnerLog } from '../domain/workspace-types';
import { ApiError } from '../api';
import { createDraft } from '../domain/notes';

const api = vi.hoisted(() => ({ generate: vi.fn(), choices: vi.fn(), context: vi.fn(), notes: [] as unknown[] }));
vi.mock('../feature-api', () => ({ generateBrief: api.generate }));
vi.mock('../consultation-api', () => ({ listBriefConsultations: api.choices, getBriefConsultation: api.context }));

const records: SavedOwnerLog[] = [{
  id: 'log-1', savedAt: '2026-09-29T10:00:00.000Z', draft: {
    id: 'draft-1', sourceText: '초코가 5분 산책했어요.', sourceKind: 'nl_log_text', pets: [{ id: 'pet-1', name: '초코', nicknames: [] }], now: '2026-09-29T10:00:00.000Z', timeZone: 'Asia/Seoul',
    events: [{ id: 'event-1', petId: 'pet-1', type: 'walk', occurredAt: '2026-09-29T09:00:00.000Z', timeHint: null, durationMin: 5, trigger: null, intervention: null, outcome: null, details: { amountText: null, isTreat: null, excretionKinds: [], placeText: null }, sourceQuote: '초코가 5분 산책했어요.', edited: false }],
    safetyFlags: [], clarification: null, mode: 'manual',
  },
}];
const draft: BriefDraft = { id: 'brief-1', petId: 'pet-1', period: { from: '2026-09-17', to: '2026-09-30', daysWithRecords: 1 }, facts: [{ id: 'count:walk', label: '산책 횟수', value: 1, unit: '건', previousValue: null, refs: ['event-1'] }], summary: [{ text: '산책 횟수: 1건.', refs: ['count:walk'] }], changes: [], questionsForOwner: [], previousTasks: [], cautions: [], dataGaps: [], safetyFlags: [], mode: 'manual' };

vi.mock('../domain/owner-storage', () => ({ listPets: () => [{ id: 'pet-1', name: '초코', nicknames: [] }, { id: 'pet-2', name: '보리', nicknames: [] }], listOwnerLogs: () => records }));
vi.mock('../domain/storage', () => ({ listNotes: () => api.notes }));
vi.mock('../domain/brief', () => ({ computeBrief: () => draft }));

beforeEach(() => { vi.clearAllMocks(); api.notes = []; api.choices.mockResolvedValue({ consultations: [] }); });

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
test('invalid selected server consultation clears selection without stale-context fallback', async () => {
  api.choices.mockResolvedValue({ consultations: [{ id: 'server', petName: '초코', trainerName: '김', date: '2026-09-25', revision: 'r1', approvedAt: '2026-09-25T00:00:00Z' }] });
  api.context.mockResolvedValue({ id: 'server', petName: '초코', date: '2026-09-25', revision: 'r1', items: [] });
  api.generate.mockRejectedValue(new ApiError('상담일지가 변경되었습니다.', 'BRIEF_CONSULTATION_INVALID'));
  render(<BriefWorkspace aiReady />);
  await screen.findByRole('option', { name: /상세 상담.*2026-09-25/ });
  await userEvent.selectOptions(screen.getByLabelText('확정 상담일지 (선택 사항)'), 'server:server');
  await userEvent.click(screen.getByRole('checkbox'));
  await userEvent.click(screen.getByRole('button', { name: 'AI 브리핑 만들기' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('다시 선택');
  expect(screen.getByLabelText('확정 상담일지 (선택 사항)')).toHaveValue('');
  expect(api.generate.mock.calls[0][0].consultation).toEqual({ id: 'server', revision: 'r1' });
});
test('refreshes approved choices after a selected revision changes', async () => {
  const choice = { id: 'server', petName: '초코', trainerName: '김', date: '2026-09-25', revision: 'r1', approvedAt: '2026-09-25T00:00:00Z' };
  api.choices.mockResolvedValueOnce({ consultations: [choice] }).mockResolvedValue({ consultations: [{ ...choice, revision: 'r2' }] });
  api.context.mockRejectedValue(new ApiError('상담 내용 변경', 'BRIEF_CONSULTATION_INVALID'));
  render(<BriefWorkspace aiReady />);
  await screen.findByRole('option', { name: /상세 상담/ });
  await userEvent.selectOptions(screen.getByLabelText('확정 상담일지 (선택 사항)'), 'server:server');
  await userEvent.click(screen.getByRole('checkbox'));
  await userEvent.click(screen.getByRole('button', { name: 'AI 브리핑 만들기' }));
  await screen.findByRole('alert');
  expect(api.choices).toHaveBeenCalledTimes(2);
});
test('does not generate from consultation context arriving after selection cancellation', async () => {
  api.choices.mockResolvedValue({ consultations: [{ id: 'server', petName: '초코', trainerName: '김', date: '2026-09-25', revision: 'r1' }] });
  let complete!: (value: unknown) => void;
  api.context.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  render(<BriefWorkspace aiReady />);
  await screen.findByRole('option', { name: /상세 상담/ });
  await userEvent.selectOptions(screen.getByLabelText('확정 상담일지 (선택 사항)'), 'server:server');
  await userEvent.click(screen.getByRole('checkbox'));
  await userEvent.click(screen.getByRole('button', { name: 'AI 브리핑 만들기' }));
  await userEvent.selectOptions(screen.getByLabelText('확정 상담일지 (선택 사항)'), '');
  await act(async () => { complete({ id: 'server', revision: 'r1', petName: '초코', items: [] }); });
  expect(api.generate).not.toHaveBeenCalled();
});
