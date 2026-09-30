import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import BriefWorkspace from './BriefWorkspace';
import type { BriefDraft, SavedOwnerLog } from '../domain/workspace-types';

const records: SavedOwnerLog[] = [{
  id: 'log-1', savedAt: '2026-09-29T10:00:00.000Z', draft: {
    id: 'draft-1', sourceText: '초코가 5분 산책했어요.', sourceKind: 'nl_log_text', pets: [{ id: 'pet-1', name: '초코', nicknames: [] }], now: '2026-09-29T10:00:00.000Z', timeZone: 'Asia/Seoul',
    events: [{ id: 'event-1', petId: 'pet-1', type: 'walk', occurredAt: '2026-09-29T09:00:00.000Z', timeHint: null, durationMin: 5, trigger: null, intervention: null, outcome: null, details: { amountText: null, isTreat: null, excretionKinds: [], placeText: null }, sourceQuote: '초코가 5분 산책했어요.', edited: false }],
    safetyFlags: [], clarification: null, mode: 'manual',
  },
}];
const draft: BriefDraft = { id: 'brief-1', petId: 'pet-1', period: { from: '2026-09-17', to: '2026-09-30', daysWithRecords: 1 }, facts: [{ id: 'count:walk', label: '산책 횟수', value: 1, unit: '건', previousValue: null, refs: ['event-1'] }], summary: [{ text: '산책 횟수: 1건.', refs: ['count:walk'] }], changes: [], questionsForOwner: [], previousTasks: [], cautions: [], dataGaps: [], safetyFlags: [], mode: 'manual' };

vi.mock('../domain/owner-storage', () => ({ listPets: () => [{ id: 'pet-1', name: '초코', nicknames: [] }], listOwnerLogs: () => records }));
vi.mock('../domain/storage', () => ({ listNotes: () => [] }));
vi.mock('../domain/brief', () => ({ computeBrief: () => draft }));

beforeEach(() => { vi.clearAllMocks(); });

test('summary fact reference opens original owner event quote', async () => {
  render(<BriefWorkspace aiReady={false} />);
  const section = screen.getByRole('heading', { name: '요약' }).closest('section')!;
  await userEvent.click(within(section).getByRole('button', { name: '근거 보기' }));
  expect(screen.getByRole('status')).toHaveTextContent('초코가 5분 산책했어요.');
});
