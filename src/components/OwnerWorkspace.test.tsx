import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import OwnerWorkspace from './OwnerWorkspace';
import { generateOwnerLog } from '../feature-api';
import { createManualOwnerDraft } from '../domain/owner-log';
import { saveOwnerLog, savePets } from '../domain/owner-storage';

vi.mock('../feature-api', () => ({ generateOwnerLog: vi.fn() }));

beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });

test('manual owner record cannot be saved until an ambiguous pet is resolved', async () => {
  const user = userEvent.setup();
  render(<OwnerWorkspace aiReady={false} />);
  for (const name of ['초코', '두부']) {
    await user.type(screen.getByRole('textbox', { name: '이름' }), name);
    await user.click(screen.getByRole('button', { name: '등록' }));
  }
  await user.type(screen.getByRole('textbox', { name: '원문 또는 받아쓰기' }), '오늘 산책했어요.');
  await user.click(screen.getByRole('button', { name: '수동 검토 초안 만들기' }));
  const save = screen.getByRole('button', { name: '검토 후 저장' });
  await user.click(screen.getByRole('checkbox', { name: /원문과 사건 내용을 확인했습니다/ }));
  expect(save).toBeDisabled();
  await user.selectOptions(screen.getByRole('combobox', { name: '반려동물' }), '초코');
  await user.click(screen.getByRole('checkbox', { name: /원문과 사건 내용을 확인했습니다/ }));
  expect(save).toBeEnabled();
  await user.click(save);
  expect(screen.getByRole('status')).toHaveTextContent('이 브라우저에 저장했습니다.');
});

test('opening a saved record clears prior AI consent before another request', async () => {
  vi.mocked(generateOwnerLog).mockImplementation(async input => ({ draft: createManualOwnerDraft(input), fallbackUsed: true, requestId: 'request-1', latencyMs: 1, model: 'test', warnings: [] }));
  const user = userEvent.setup();
  render(<OwnerWorkspace aiReady />);
  await user.type(screen.getByRole('textbox', { name: '이름' }), '초코');
  await user.click(screen.getByRole('button', { name: '등록' }));
  await user.type(screen.getByRole('textbox', { name: '원문 또는 받아쓰기' }), '초코가 산책했어요.');
  await user.click(screen.getByRole('checkbox', { name: /AI 처리 서버/ }));
  await user.click(screen.getByRole('button', { name: 'AI 사건 초안 만들기' }));
  await screen.findByRole('button', { name: '검토 후 저장' });
  await user.click(screen.getByRole('checkbox', { name: /원문과 사건 내용을 확인했습니다/ }));
  await user.click(screen.getByRole('button', { name: '검토 후 저장' }));
  await user.click(screen.getByRole('button', { name: '열기' }));
  expect(screen.getByRole('checkbox', { name: /AI 처리 서버/ })).not.toBeChecked();
  await user.click(screen.getByRole('button', { name: 'AI 사건 초안 만들기' }));
  expect(generateOwnerLog).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('alert')).toHaveTextContent('AI 처리 동의가 필요합니다.');
});

test('editing reopened voice transcript retains voice source provenance', async () => {
  const pets = [{ id: 'pet-1', name: '초코', nicknames: [] }];
  savePets(pets);
  saveOwnerLog(createManualOwnerDraft({ text: '초코가 산책했어요.', pets, now: new Date().toISOString(), timeZone: 'Asia/Seoul', sourceKind: 'nl_log_voice' }), true);
  vi.mocked(generateOwnerLog).mockImplementation(async input => ({ draft: createManualOwnerDraft(input), fallbackUsed: true, requestId: 'request-2', latencyMs: 1, model: 'test', warnings: [] }));
  const user = userEvent.setup();
  render(<OwnerWorkspace aiReady />);
  await user.click(screen.getByRole('button', { name: '열기' }));
  await user.type(screen.getByRole('textbox', { name: '원문 또는 받아쓰기' }), ' 천천히 걸었어요.');
  await user.click(screen.getByRole('checkbox', { name: /AI 처리 서버/ }));
  await user.click(screen.getByRole('button', { name: 'AI 사건 초안 만들기' }));
  expect(generateOwnerLog).toHaveBeenCalledWith(expect.objectContaining({ sourceKind: 'nl_log_voice' }), expect.any(AbortSignal));
});
