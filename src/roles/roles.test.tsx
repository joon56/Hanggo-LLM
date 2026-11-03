import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallSnapshot } from '../call/call-session';
import { ApiError } from '../api';
import { CallStage } from './CallStage';
import { GuardianHome } from './GuardianHome';
import { GuardianJoin } from './GuardianJoin';
import { PreJoin } from './PreJoin';
import { TrainerHome } from './TrainerHome';
import { deviceAdvice, isInAppBrowser } from './copy';

const api = vi.hoisted(() => ({ getMe: vi.fn(), listCases: vi.fn(), getCase: vi.fn(), createCase: vi.fn(), reissueInvite: vi.fn(), joinWithInvite: vi.fn(), startConsultation: vi.fn(), setConsent: vi.fn() }));
vi.mock('../coaching-api', () => api);
const login = vi.hoisted(() => vi.fn());
vi.mock('../api', async original => ({ ...await original<typeof import('../api')>(), login }));

const aCase = { id: 'case-1', petName: '초코', guardianName: '가상 보호자', trainerName: '가상 훈련사', createdAt: '2026-11-03T00:00:00.000Z' };
const liveConsultation = { id: 'c1', caseId: 'case-1', createdAt: '2026-11-03T00:00:00.000Z', state: 'live', recording: false, consent: { guardian: false, trainer: false }, recordingGaps: [], errors: [] };
beforeEach(() => { for (const mock of Object.values(api)) mock.mockReset(); login.mockReset(); });
afterEach(cleanup);

describe('TrainerHome', () => {
  beforeEach(() => { api.getMe.mockResolvedValue({ role: 'trainer' }); api.listCases.mockResolvedValue({ cases: [aCase] }); api.getCase.mockResolvedValue({ ...aCase, consultations: [] }); });
  it('asks for the password when not signed in and retries after login', async () => {
    api.getMe.mockRejectedValueOnce(new ApiError('로그인이 필요합니다.', 'AUTH'));
    login.mockResolvedValue({});
    render(<TrainerHome navigate={vi.fn()} />);
    await userEvent.type(await screen.findByLabelText('접근 비밀번호'), 'long-test-password');
    await userEvent.click(screen.getByRole('button', { name: '로그인' }));
    expect(login).toHaveBeenCalledWith('long-test-password');
    expect(await screen.findByText('초코')).toBeInTheDocument();
  });
  it('shows a joinable invite link after creating a case', async () => {
    api.createCase.mockResolvedValue({ case: aCase, inviteToken: 'a'.repeat(64) });
    render(<TrainerHome navigate={vi.fn()} />);
    await userEvent.type(await screen.findByLabelText('반려동물 이름'), '초코');
    await userEvent.type(screen.getByLabelText('보호자 이름'), '가상 보호자');
    await userEvent.type(screen.getByLabelText('훈련사 이름'), '가상 훈련사');
    await userEvent.click(screen.getByRole('button', { name: '상담 사례 만들기' }));
    expect(api.createCase).toHaveBeenCalledWith({ petName: '초코', guardianName: '가상 보호자', trainerName: '가상 훈련사' });
    expect(await screen.findByLabelText('보호자 초대 링크')).toHaveValue(`${location.origin}/join/${'a'.repeat(64)}`);
  });
  it('warns that a loopback invite only opens on this PC', async () => {
    api.createCase.mockResolvedValue({ case: aCase, inviteToken: 'a'.repeat(64) });
    render(<TrainerHome navigate={vi.fn()} hostname="127.0.0.1" />);
    await userEvent.type(await screen.findByLabelText('반려동물 이름'), '초코');
    await userEvent.type(screen.getByLabelText('보호자 이름'), '가상');
    await userEvent.type(screen.getByLabelText('훈련사 이름'), '가상');
    await userEvent.click(screen.getByRole('button', { name: '상담 사례 만들기' }));
    expect(await screen.findByText(/이 PC에서만 열립니다/)).toBeInTheDocument();
  });
  it('starts a consultation and enters the room', async () => {
    const navigate = vi.fn();
    api.startConsultation.mockResolvedValue(liveConsultation);
    render(<TrainerHome navigate={navigate} />);
    await userEvent.click(await screen.findByRole('button', { name: '초코 상담 시작' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/room/c1'));
  });
  it('offers to re-enter a consultation already live instead of starting another', async () => {
    const navigate = vi.fn();
    api.getCase.mockResolvedValue({ ...aCase, consultations: [liveConsultation] });
    render(<TrainerHome navigate={navigate} />);
    await userEvent.click(await screen.findByRole('button', { name: '초코 상담 다시 입장' }));
    expect(navigate).toHaveBeenCalledWith('/room/c1');
    expect(api.startConsultation).not.toHaveBeenCalled();
  });
  it('shows the server message when a start conflicts', async () => {
    api.startConsultation.mockRejectedValue(new ApiError('Another consultation is live.', 'ACTIVE_CONSULTATION'));
    render(<TrainerHome navigate={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: '초코 상담 시작' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('진행 중인 상담');
  });
});

describe('GuardianJoin', () => {
  it('does not use the invite until the guardian presses the button, so link previews cannot consume it', async () => {
    const navigate = vi.fn();
    api.joinWithInvite.mockResolvedValue({ case: aCase });
    render(<GuardianJoin token="token" navigate={navigate} userAgent="Mozilla/5.0 Chrome/150" />);
    expect(api.joinWithInvite).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '상담 입장 준비' }));
    expect(api.joinWithInvite).toHaveBeenCalledWith('token');
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/guardian'));
  });
  it('guides in-app browsers to a real browser before spending the invite', () => {
    render(<GuardianJoin token="token" navigate={vi.fn()} userAgent="Mozilla/5.0 KAKAOTALK 10.0" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Chrome');
    expect(screen.queryByRole('button', { name: '상담 입장 준비' })).toBeNull();
  });
  it('explains an invalid invite', async () => {
    api.joinWithInvite.mockRejectedValue(new ApiError('Invite is invalid or expired.', 'INVITE'));
    render(<GuardianJoin token="token" navigate={vi.fn()} userAgent="Chrome" />);
    await userEvent.click(screen.getByRole('button', { name: '상담 입장 준비' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('훈련사에게 새 링크');
  });
});

describe('GuardianHome', () => {
  it('lets the guardian enter only while a consultation is live', async () => {
    const navigate = vi.fn();
    api.getMe.mockResolvedValue({ role: 'guardian', caseId: 'case-1' });
    api.getCase.mockResolvedValue({ ...aCase, consultations: [] });
    const { unmount } = render(<GuardianHome navigate={navigate} />);
    expect(await screen.findByText(/훈련사가 상담을 시작하면/)).toBeInTheDocument();
    unmount();
    api.getCase.mockResolvedValue({ ...aCase, consultations: [liveConsultation] });
    render(<GuardianHome navigate={navigate} />);
    await userEvent.click(await screen.findByRole('button', { name: '상담 입장' }));
    expect(navigate).toHaveBeenCalledWith('/room/c1');
  });
});

describe('deviceAdvice', () => {
  it('gives a different explanation per failure', () => {
    const messages = (['denied', 'not-found', 'busy', 'unsupported'] as const).map(reason => deviceAdvice({ device: 'camera', reason }));
    expect(new Set(messages).size).toBe(4);
    expect(deviceAdvice({ device: 'camera', reason: 'not-found' })).toContain('카메라');
    expect(deviceAdvice({ device: 'microphone', reason: 'not-found' })).toContain('마이크');
  });
});
it.each([['KAKAOTALK', true], ['NAVER(inapp; search)', true], ['Instagram 300', true], ['FBAN/FBIOS', true], ['Mozilla/5.0 Chrome/150 Safari/537', false]])('isInAppBrowser(%s)', (userAgent, expected) => {
  expect(isInAppBrowser(userAgent)).toBe(expected);
});

describe('PreJoin', () => {
  const stream = () => ({ getTracks: () => [], getVideoTracks: () => [], getAudioTracks: () => [] }) as unknown as MediaStream;
  it('explains missing devices and warns when no relay is configured, but still allows entry', async () => {
    const onJoin = vi.fn();
    render(<PreJoin petName="초코" role="trainer" relayAvailable={false} openPreview={async () => ({ stream: stream(), missing: [{ device: 'camera', reason: 'not-found' }] })} onJoin={onJoin} />);
    expect(await screen.findByText(/카메라를 찾지 못했습니다/)).toBeInTheDocument();
    expect(screen.getByText(/다른 네트워크에서 연결이 실패할 수 있습니다/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '입장' }));
    expect(onJoin).toHaveBeenCalledWith(expect.objectContaining({ consent: false }));
  });
  it('reports consent only when the box is checked', async () => {
    const onJoin = vi.fn();
    render(<PreJoin petName="초코" role="guardian" relayAvailable openPreview={async () => ({ stream: stream(), missing: [] })} onJoin={onJoin} />);
    await userEvent.click(await screen.findByLabelText(/AI 받아쓰기와 장면 저장에 동의합니다/));
    await userEvent.click(screen.getByRole('button', { name: '입장' }));
    expect(onJoin).toHaveBeenCalledWith(expect.objectContaining({ consent: true }));
  });
});

describe('CallStage', () => {
  const liveStream = (id: string) => ({ id, getTracks: () => [], getVideoTracks: () => [], getAudioTracks: () => [] }) as unknown as MediaStream;
  const snapshot = (change: Partial<CallSnapshot> = {}): CallSnapshot => ({ status: 'connected', peerOnline: true, peerMedia: { camera: true, microphone: true, screen: false }, stats: { inboundVideoFrames: 7, inboundAudioBytes: 90, inboundAudioEnergy: 0.5, roundTripMs: 40, relayed: false }, error: '',
    microphoneOn: true, cameraOn: true, hasCamera: true, hasMicrophone: true, localStream: liveStream('local'), localScreen: null, remoteStream: liveStream('remote'), remoteScreen: null, consent: { guardian: false, trainer: false }, recording: false, consultationState: 'live', ...change });
  const handlers = () => ({ onToggleMicrophone: vi.fn(), onToggleCamera: vi.fn(), onSwitchCamera: vi.fn(), onStartShare: vi.fn(), onStopShare: vi.fn(), onLeave: vi.fn(), onEnd: vi.fn(), onConsent: vi.fn() });
  const setup = (change: Partial<CallSnapshot> = {}, options: { canShare?: boolean; role?: 'trainer' | 'guardian' } = {}) => {
    const actions = handlers();
    const { container } = render(<CallStage role={options.role ?? 'trainer'} petName="초코" canShare={options.canShare ?? true} call={snapshot(change)} {...actions} />);
    return { actions, root: container.querySelector('[data-call-status]') as HTMLElement };
  };
  it('exposes connection numbers for inspection', () => {
    const { root } = setup();
    expect(root.dataset).toMatchObject({ callStatus: 'connected', inboundVideoFrames: '7', inboundAudioBytes: '90', relayed: 'false' });
  });
  it('names every control and calls its handler', () => {
    const { actions } = setup();
    fireEvent.click(screen.getByRole('button', { name: '마이크 끄기' })); expect(actions.onToggleMicrophone).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '카메라 끄기' })); expect(actions.onToggleCamera).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '화면 공유' })); expect(actions.onStartShare).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '상담 종료' })); expect(actions.onEnd).toHaveBeenCalled();
  });
  it('labels controls by current state', () => {
    setup({ microphoneOn: false, cameraOn: false });
    expect(screen.getByRole('button', { name: '마이크 켜기' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '카메라 켜기' })).toBeInTheDocument();
  });
  it('hides screen share where the browser cannot do it', () => {
    setup({}, { canShare: false });
    expect(screen.queryByRole('button', { name: '화면 공유' })).toBeNull();
  });
  it('disables controls for a device that does not exist', () => {
    setup({ hasCamera: false, cameraOn: false });
    expect(screen.getByRole('button', { name: '카메라 없음' })).toBeDisabled();
  });
  it('lets the guardian leave but not end the consultation', () => {
    setup({}, { role: 'guardian' });
    expect(screen.getByRole('button', { name: '나가기' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '상담 종료' })).toBeNull();
  });
  it('makes a shared screen the main view and keeps the person visible', () => {
    setup({ remoteScreen: liveStream('screen'), peerMedia: { camera: true, microphone: true, screen: true } });
    expect(screen.getByLabelText('상대 공유 화면').closest('[data-main]')).not.toBeNull();
    expect(screen.getByLabelText('상대 카메라').closest('[data-main]')).toBeNull();
  });
  it('ignores a stale screen stream once the peer stopped sharing', () => {
    setup({ remoteScreen: liveStream('screen'), peerMedia: { camera: true, microphone: true, screen: false } });
    expect(screen.queryByLabelText('상대 공유 화면')).toBeNull();
  });
  it('tells the participant when the other side is absent or reconnecting', () => {
    setup({ peerOnline: false, status: 'waiting' });
    expect(screen.getByRole('status')).toHaveTextContent('상대를 기다리고 있습니다');
    cleanup();
    setup({ status: 'reconnecting' });
    expect(screen.getByRole('status')).toHaveTextContent('다시 연결');
  });
  it('shows recording state and who has not consented', () => {
    setup({ consent: { guardian: true, trainer: false } }, { role: 'trainer' });
    expect(screen.getByText(/기록 꺼짐/)).toBeInTheDocument();
    cleanup();
    setup({ consent: { guardian: true, trainer: true }, recording: true });
    expect(screen.getByText(/AI 기록 중/)).toBeInTheDocument();
  });
  it('lets a participant change their own consent during the call', () => {
    const { actions } = setup({ consent: { guardian: true, trainer: true }, recording: true });
    fireEvent.click(screen.getByRole('button', { name: '기록 동의 철회' }));
    expect(actions.onConsent).toHaveBeenCalledWith(false);
  });
});
