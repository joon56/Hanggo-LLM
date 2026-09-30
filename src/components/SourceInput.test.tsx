import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import SourceInput from './SourceInput';
import { transcribe, verifyAudibleAudio } from '../api';

vi.mock('../hooks/useRecorder', () => ({ useRecorder: () => ({ status: 'ready', duration: 4, audioUrl: 'blob:recording', audioBlob: new Blob(['audio'], { type: 'audio/webm' }), error: '', start: vi.fn(), stop: vi.fn(), reset: vi.fn() }) }));
vi.mock('../api', () => ({ verifyAudibleAudio: vi.fn(), transcribe: vi.fn() }));

test('revoking consent during audio inspection prevents transcription request', async () => {
  let finishInspection!: () => void;
  vi.mocked(verifyAudibleAudio).mockImplementation(() => new Promise<void>(resolve => { finishInspection = resolve; }));
  const onText = vi.fn();
  render(<SourceInput aiReady petName="초코" text="기존 원문" onText={onText} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '음성' }));
  await user.click(screen.getByRole('checkbox', { name: /AI 처리 서버/ }));
  await user.click(screen.getByRole('button', { name: '받아쓰기' }));
  await user.click(screen.getByRole('checkbox', { name: /AI 처리 서버/ }));
  finishInspection();
  await Promise.resolve();
  expect(transcribe).not.toHaveBeenCalled();
  expect(onText).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox', { name: '원문 또는 받아쓰기' })).toHaveValue('기존 원문');
});
