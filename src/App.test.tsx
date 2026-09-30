import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import App from './App';
import { approveDraft, createDraft } from './domain/notes';
import { saveNote } from './domain/storage';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(), login: vi.fn(), logout: vi.fn(), generateNote: vi.fn(), transcribe: vi.fn(), verifyAudibleAudio: vi.fn(),
  recorder: { status: 'idle', duration: 0, audioUrl: null as string | null, audioBlob: null as Blob | null, error: '', start: vi.fn(), stop: vi.fn(), reset: vi.fn() },
}));
vi.mock('./api', () => ({ getSession: mocks.getSession, login: mocks.login, logout: mocks.logout, generateNote: mocks.generateNote, transcribe: mocks.transcribe, verifyAudibleAudio: mocks.verifyAudibleAudio }));
vi.mock('./hooks/useRecorder', () => ({ useRecorder: () => mocks.recorder }));

const demoSession = { authenticated: true, requirePassword: false, aiEnabled: false, configured: false, textModel: '', sttModel: '' };
const aiSession = { ...demoSession, aiEnabled: true, configured: true, textModel: 'text-test', sttModel: 'stt-test' };
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks(); mocks.getSession.mockResolvedValue(demoSession); mocks.verifyAudibleAudio.mockResolvedValue(undefined);
  Object.assign(mocks.recorder, { status: 'idle', duration: 0, audioUrl: null, audioBlob: null, error: '' });
});
async function ready() { await screen.findByRole('button', { name: '예시 불러오기' }); }
async function example() { await ready(); fireEvent.click(screen.getByRole('button', { name: '예시 불러오기' })); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(a => { resolve = a; }); return { promise, resolve }; }

it('requires session before mounting saved history and accepts password login', async () => {
  const locked = { ...aiSession, authenticated: false, requirePassword: true };
  mocks.getSession.mockResolvedValue(locked); mocks.login.mockResolvedValue({ ...locked, authenticated: true });
  render(<App />);
  expect(screen.queryByText('저장한 기록')).not.toBeInTheDocument();
  fireEvent.change(await screen.findByLabelText('운영자 비밀번호'), { target: { value: 'secret' } });
  fireEvent.click(screen.getByRole('button', { name: '로그인' }));
  await ready(); expect(mocks.login).toHaveBeenCalledWith('secret');
});

it('hides saved history and editor after logout', async () => {
  const session = { ...aiSession, requirePassword: true };
  mocks.getSession.mockResolvedValue(session);
  mocks.logout.mockResolvedValue({ ...session, authenticated: false });
  saveNote(approveDraft(createDraft('보호자는 짖는다고 말했습니다.', 'trainer_summary_text'), { petName: '보리', trainerName: '김훈련', sessionDate: '2026-09-30' }, true));
  render(<App />); await screen.findByRole('button', { name: /보리 .* 기록 열기/ });
  fireEvent.click(screen.getByRole('button', { name: '로그아웃' }));
  await screen.findByLabelText('운영자 비밀번호');
  expect(screen.queryByText('저장한 기록')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /보리 .* 기록 열기/ })).not.toBeInTheDocument();
});

it('shows connection error before explicit local demo in development', async () => {
  mocks.getSession.mockRejectedValue(new Error('offline'));
  render(<App />);
  await screen.findByRole('alert');
  expect(screen.queryByText('저장한 기록')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '로컬 데모 사용' }));
  await ready();
  expect(screen.getByText('저장한 기록')).toBeInTheDocument();
  expect(mocks.generateNote).not.toHaveBeenCalled();
});

it('asks for consent before text reaches AI and renders model metadata', async () => {
  mocks.getSession.mockResolvedValue(aiSession);
  const draft = { ...createDraft('보호자는 짖는다고 말했습니다.', 'trainer_summary_text'), mode: 'openai', generation: { requestId: 'req-1', model: 'text-test', promptVersion: 'v1', latencyMs: 43, fallbackUsed: false } };
  mocks.generateNote.mockResolvedValue({ draft, fallbackUsed: false, requestId: 'req-1', latencyMs: 43, model: 'text-test', warnings: [] });
  render(<App />); await example();
  expect(screen.getByRole('button', { name: '일지 초안 만들기' })).toBeDisabled();
  expect(mocks.generateNote).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('checkbox', { name: /외부 AI/ }));
  fireEvent.click(screen.getByRole('button', { name: '일지 초안 만들기' }));
  await waitFor(() => expect(screen.getByText('AI 초안')).toBeInTheDocument());
  expect(screen.getByText(/req-1/)).toBeInTheDocument();
});

it('ignores pending AI answer after source edit', async () => {
  mocks.getSession.mockResolvedValue(aiSession);
  const pending = deferred<unknown>(); mocks.generateNote.mockReturnValue(pending.promise);
  render(<App />); await example();
  fireEvent.click(screen.getByRole('checkbox', { name: /외부 AI/ }));
  fireEvent.click(screen.getByRole('button', { name: '일지 초안 만들기' }));
  fireEvent.change(screen.getByLabelText('상담 요약 원문'), { target: { value: '수정된 원문입니다.' } });
  pending.resolve({ draft: createDraft('이전 원문입니다.', 'trainer_summary_text'), fallbackUsed: false, requestId: 'old', latencyMs: 1, model: 'test', warnings: [] });
  await waitFor(() => expect(screen.queryByRole('button', { name: '승인하고 저장' })).not.toBeInTheDocument());
});

it('invalidates old draft immediately when replacing it with an AI request', async () => {
  mocks.getSession.mockResolvedValue(aiSession);
  const pending = deferred<unknown>(); mocks.generateNote.mockReturnValue(pending.promise);
  render(<App />); await example();
  fireEvent.click(screen.getByRole('button', { name: '로컬 데모 사용' }));
  fireEvent.click(screen.getByRole('button', { name: '일지 초안 만들기' }));
  expect(screen.getByRole('button', { name: '승인하고 저장' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'AI 사용' }));
  fireEvent.click(screen.getByRole('checkbox', { name: /외부 AI/ }));
  fireEvent.click(screen.getByRole('button', { name: '일지 초안 만들기' }));
  expect(screen.queryByRole('button', { name: '승인하고 저장' })).not.toBeInTheDocument();
});

it('preserves source and makes all items follow-up after AI failure', async () => {
  mocks.getSession.mockResolvedValue(aiSession); mocks.generateNote.mockRejectedValue(new Error('provider unavailable'));
  render(<App />); await example();
  fireEvent.click(screen.getByRole('checkbox', { name: /외부 AI/ }));
  fireEvent.click(screen.getByRole('button', { name: '일지 초안 만들기' }));
  await waitFor(() => expect(screen.getByText('수동 검토 필요')).toBeInTheDocument());
  expect((screen.getByLabelText('상담 요약 원문') as HTMLTextAreaElement).value).toContain('보호자는 초코가');
  expect(screen.queryByLabelText('합의한 과제 내용')).not.toBeInTheDocument();
});

it('keeps source and recording after transcription error', async () => {
  mocks.getSession.mockResolvedValue(aiSession);
  Object.assign(mocks.recorder, { status: 'ready', audioUrl: 'blob:demo', audioBlob: new Blob(['audio'], { type: 'audio/webm' }), duration: 5 });
  mocks.transcribe.mockRejectedValue(new Error('STT unavailable'));
  render(<App />); await ready();
  fireEvent.change(screen.getByLabelText('상담 요약 원문'), { target: { value: '기존 원문' } });
  fireEvent.click(screen.getByRole('checkbox', { name: /외부 AI/ }));
  fireEvent.click(screen.getByRole('button', { name: '음성 받아쓰기' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('STT unavailable'));
  expect(screen.getByLabelText('상담 요약 원문')).toHaveValue('기존 원문');
  expect(screen.getByLabelText('상담 요약 녹음 재생')).toBeInTheDocument();
});

it('requires fresh transcript confirmation after edits', async () => {
  mocks.getSession.mockResolvedValue(aiSession);
  Object.assign(mocks.recorder, { status: 'ready', audioUrl: 'blob:demo', audioBlob: new Blob(['audio'], { type: 'audio/webm' }), duration: 5 });
  mocks.transcribe.mockResolvedValue({ text: '초코가 앉았습니다.', requestId: 'stt-1', latencyMs: 10, model: 'stt-test' });
  render(<App />); await ready();
  fireEvent.click(screen.getByRole('checkbox', { name: /외부 AI/ }));
  fireEvent.click(screen.getByRole('button', { name: '음성 받아쓰기' }));
  await screen.findByRole('checkbox', { name: /받아쓰기 내용을/ });
  expect(screen.getByRole('button', { name: '일지 초안 만들기' })).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', { name: /받아쓰기 내용을/ }));
  expect(screen.getByRole('button', { name: '일지 초안 만들기' })).toBeEnabled();
  fireEvent.change(screen.getByLabelText('상담 요약 원문'), { target: { value: '초코가 앉았습니다. 수정' } });
  expect(screen.getByRole('button', { name: '일지 초안 만들기' })).toBeDisabled();
});

it('ignores stale transcription after source edit and preserves the edit', async () => {
  mocks.getSession.mockResolvedValue(aiSession);
  Object.assign(mocks.recorder, { status: 'ready', audioUrl: 'blob:demo', audioBlob: new Blob(['audio'], { type: 'audio/webm' }), duration: 5 });
  const pending = deferred<unknown>(); mocks.transcribe.mockReturnValue(pending.promise);
  render(<App />); await ready();
  fireEvent.click(screen.getByRole('checkbox', { name: /외부 AI/ }));
  fireEvent.click(screen.getByRole('button', { name: '음성 받아쓰기' }));
  fireEvent.change(screen.getByLabelText('상담 요약 원문'), { target: { value: '훈련사가 수정한 원문' } });
  pending.resolve({ text: '이전 받아쓰기', requestId: 'old', latencyMs: 1, model: 'test' });
  await waitFor(() => expect(screen.getByLabelText('상담 요약 원문')).toHaveValue('훈련사가 수정한 원문'));
  expect(screen.queryByRole('checkbox', { name: /받아쓰기 내용을/ })).not.toBeInTheDocument();
});

it('does not upload audio when consent is revoked during audio inspection', async () => {
  mocks.getSession.mockResolvedValue(aiSession);
  Object.assign(mocks.recorder, { status: 'ready', audioUrl: 'blob:demo', audioBlob: new Blob(['audio'], { type: 'audio/webm' }), duration: 5 });
  const inspection = deferred<void>(); mocks.verifyAudibleAudio.mockReturnValue(inspection.promise);
  render(<App />); await ready();
  fireEvent.click(screen.getByRole('checkbox', { name: /외부 AI/ }));
  fireEvent.click(screen.getByRole('button', { name: '음성 받아쓰기' }));
  await waitFor(() => expect(mocks.verifyAudibleAudio).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('checkbox', { name: /외부 AI/ }));
  await act(async () => inspection.resolve());
  await waitFor(() => expect(screen.getByRole('button', { name: '음성 받아쓰기' })).toBeDisabled());
  expect(mocks.transcribe).not.toHaveBeenCalled();
});

it('keeps transcript provenance when a new recording starts', async () => {
  mocks.getSession.mockResolvedValue(aiSession);
  Object.assign(mocks.recorder, { status: 'ready', audioUrl: 'blob:demo', audioBlob: new Blob(['audio'], { type: 'audio/webm' }), duration: 5 });
  mocks.transcribe.mockResolvedValue({ text: '초코가 앉았습니다.', requestId: 'stt-1', latencyMs: 10, model: 'stt-test' });
  mocks.generateNote.mockResolvedValue({ draft: { ...createDraft('초코가 앉았습니다.', 'trainer_summary_voice'), mode: 'openai' }, fallbackUsed: false, requestId: 'n-1', latencyMs: 10, model: 'text-test', warnings: [] });
  render(<App />); await ready();
  fireEvent.click(screen.getByRole('checkbox', { name: /외부 AI/ }));
  fireEvent.click(screen.getByRole('button', { name: '음성 받아쓰기' }));
  await screen.findByRole('checkbox', { name: /받아쓰기 내용을/ });
  fireEvent.click(screen.getByRole('checkbox', { name: /받아쓰기 내용을/ }));
  fireEvent.click(screen.getByRole('button', { name: '녹음 시작' }));
  expect(screen.getByRole('checkbox', { name: /받아쓰기 내용을/ })).not.toBeChecked();
  fireEvent.click(screen.getByRole('checkbox', { name: /받아쓰기 내용을/ }));
  fireEvent.click(screen.getByRole('button', { name: '일지 초안 만들기' }));
  await waitFor(() => expect(mocks.generateNote).toHaveBeenCalled());
  expect(mocks.generateNote.mock.calls[0][1]).toBe('trainer_summary_voice');
});
