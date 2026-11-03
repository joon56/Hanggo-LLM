import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import type { Consultation } from '../domain/coaching';
import type { CoachingNote, Evidence } from '../domain/coaching-note';
import { GuardianDelivery } from './GuardianDelivery';
import { ReviewRoom } from './ReviewRoom';

const api = vi.hoisted(() => ({ getMe: vi.fn(), getConsultation: vi.fn(), getCase: vi.fn(), saveNote: vi.fn(), approveConsultation: vi.fn(), regenerateNote: vi.fn(), setSegment: vi.fn(), setObservation: vi.fn(), getDelivery: vi.fn(), listTaskLogs: vi.fn(), addTaskLog: vi.fn(), transcribeVoice: vi.fn(), frameUrl: (consultation: string, frame: string) => `/frames/${consultation}/${frame}` }));
vi.mock('../coaching-api', () => api);

const said: Evidence = { kind: 'segment', id: 'a', quote: '초인종에 짖어요', startMs: 12000, endMs: 15000, speaker: 'guardian' };
const note = (change: Partial<CoachingNote> = {}): CoachingNote => ({ version: 2, summary: [{ id: 'c1', text: '초인종에 짖는다', evidence: [said] }], concerns: [], behaviors: [], guardianReports: [], trainerObservations: [], aiObservations: [], guidance: [],
  tasks: [{ id: 't1', text: '매트 연습', who: '보호자', frequency: null, until: null, successCriteria: null, evidence: [] }], followUps: [], safetyFlags: [], methodReview: false, uncitedSegmentIds: ['b'], createdAt: '2026-11-04T00:00:00.000Z', warnings: [], ...change });
const consultation = (change: Partial<Consultation> = {}): Consultation => ({ id: 'c', caseId: 'k', createdAt: '2026-11-04T00:00:00.000Z', state: 'review', recording: false, consent: { guardian: true, trainer: true }, recordingGaps: [], errors: [],
  segments: [{ id: 'a', speaker: 'guardian', startMs: 12000, endMs: 15000, text: '초인종에 짖어요', originalText: '초인종에 짖어요', state: 'complete' }, { id: 'b', speaker: 'trainer', startMs: 16000, endMs: 18000, text: '매트로 보내세요', originalText: '매트로 보내세요', state: 'complete' }],
  moments: [], frames: [], scenes: [], note: note(), ...change });

beforeEach(() => {
  for (const mock of Object.values(api)) if ('mockReset' in mock) mock.mockReset();
  api.getMe.mockResolvedValue({ role: 'trainer' });
  api.getCase.mockResolvedValue({ petName: '초코' });
  api.getConsultation.mockResolvedValue(consultation());
  api.listTaskLogs.mockResolvedValue({ logs: [] });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const open = async () => { render(<ReviewRoom consultationId="c" navigate={vi.fn()} />); await screen.findByRole('heading', { name: '초코 상담 검토' }); };

describe('ReviewRoom', () => {
  it('sends a guardian away, because this screen is for the trainer', async () => {
    api.getMe.mockResolvedValue({ role: 'guardian', caseId: 'k' });
    const navigate = vi.fn();
    render(<ReviewRoom consultationId="c" navigate={navigate} />);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/guardian'));
    expect(api.getConsultation).not.toHaveBeenCalled();
  });
  it('sends someone without a session to the login', async () => {
    api.getMe.mockRejectedValue(new ApiError('로그인이 필요합니다.', 'AUTH'));
    const navigate = vi.fn();
    render(<ReviewRoom consultationId="c" navigate={navigate} />);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/coaching'));
  });
  it('waits while the consultation is being organized, then shows the draft by itself', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      api.getConsultation.mockResolvedValueOnce(consultation({ state: 'processing', note: undefined }));
      render(<ReviewRoom consultationId="c" navigate={vi.fn()} />);
      expect(await screen.findByText(/상담을 정리하고 있습니다/)).toBeInTheDocument();
      await vi.advanceTimersByTimeAsync(3100);
      expect(await screen.findByDisplayValue('초인종에 짖는다')).toBeInTheDocument();
    } finally { vi.useRealTimers(); }
  });
  it('says which part it is on during a long wait', async () => {
    api.getConsultation.mockResolvedValue(consultation({ state: 'processing', note: undefined, organizing: { stage: 'note', done: 1, total: 4 } }));
    render(<ReviewRoom consultationId="c" navigate={vi.fn()} />);
    expect(await screen.findByText(/상담을 정리하고 있습니다/)).toHaveTextContent('일지 2/4 작성 중');
  });
  it('highlights the evidence for a sentence, with speaker and time', async () => {
    await open();
    const line = document.querySelector('[data-segment="a"]')!;
    expect(line.getAttribute('data-selected')).toBe('false');
    await userEvent.click(screen.getByRole('button', { name: '보호자 00:12' }));
    expect(line.getAttribute('data-selected')).toBe('true');
  });
  it('points out speech the note did not use', async () => {
    await open();
    const unused = document.querySelector<HTMLElement>('[data-segment="b"]')!;
    expect(within(unused).getByText('일지에 쓰이지 않음')).toBeInTheDocument();
    expect(within(document.querySelector<HTMLElement>('[data-segment="a"]')!).queryByText('일지에 쓰이지 않음')).toBeNull();
  });
  it('saves edited sentences with the next save', async () => {
    api.saveNote.mockResolvedValue(consultation());
    await open();
    fireEvent.change(screen.getByLabelText('핵심 요약 문장'), { target: { value: '초인종 소리에 짖는다' } });
    await userEvent.click(screen.getByRole('button', { name: '임시 저장' }));
    await waitFor(() => expect(api.saveNote).toHaveBeenCalled());
    expect(api.saveNote.mock.calls[0][1].summary[0].text).toBe('초인종 소리에 짖는다');
  });
  it('lets the trainer add and delete sentences', async () => {
    api.saveNote.mockResolvedValue(consultation());
    await open();
    await userEvent.click(screen.getByRole('button', { name: '고민 문장 추가' }));
    fireEvent.change(screen.getByLabelText('고민 문장'), { target: { value: '훈련사가 쓴 문장' } });
    expect(screen.getAllByText('근거 없음 · 훈련사 작성').length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: '핵심 요약 문장 삭제' }));
    await userEvent.click(screen.getByRole('button', { name: '임시 저장' }));
    await waitFor(() => expect(api.saveNote).toHaveBeenCalled());
    const saved: CoachingNote = api.saveNote.mock.calls[0][1];
    expect(saved.summary).toEqual([]);
    expect(saved.concerns[0].text).toBe('훈련사가 쓴 문장');
  });
  it('shows missing task details as unknown, and treats a cleared field as unknown', async () => {
    api.saveNote.mockResolvedValue(consultation());
    await open();
    expect(screen.getByLabelText('횟수')).toHaveAttribute('placeholder', '미확인');
    expect(screen.getByLabelText('횟수')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('담당'), { target: { value: ' ' } });
    fireEvent.change(screen.getByLabelText('횟수'), { target: { value: '하루 두 번' } });
    await userEvent.click(screen.getByRole('button', { name: '임시 저장' }));
    await waitFor(() => expect(api.saveNote).toHaveBeenCalled());
    expect(api.saveNote.mock.calls[0][1].tasks[0]).toMatchObject({ who: null, frequency: '하루 두 번' });
  });
  it('saves unsaved changes before approving, and asks first', async () => {
    api.saveNote.mockResolvedValue(consultation());
    api.approveConsultation.mockResolvedValue(consultation({ state: 'approved', note: note({ approvedAt: 'x' }) }));
    await open();
    fireEvent.change(screen.getByLabelText('핵심 요약 문장'), { target: { value: '고친 문장' } });
    await userEvent.click(screen.getByRole('button', { name: '확정하고 보호자에게 전달' }));
    expect(await screen.findByText('확정해 보호자에게 전달했습니다.')).toBeInTheDocument();
    expect(window.confirm).toHaveBeenCalled();
    expect(api.saveNote.mock.invocationCallOrder[0]).toBeLessThan(api.approveConsultation.mock.invocationCallOrder[0]);
  });
  it('keeps unsaved edits when regenerating is refused', async () => {
    api.regenerateNote.mockRejectedValue(new ApiError('다른 상담을 기록하는 중에는 일지를 다시 만들 수 없습니다.', 'GPU_BUSY'));
    api.saveNote.mockResolvedValue(consultation());
    await open();
    fireEvent.change(screen.getByLabelText('핵심 요약 문장'), { target: { value: '고친 문장' } });
    await userEvent.click(screen.getByRole('button', { name: '일지 다시 만들기' }));
    await screen.findByRole('alert');
    await userEvent.click(screen.getByRole('button', { name: '임시 저장' }));
    await waitFor(() => expect(api.saveNote).toHaveBeenCalled());
    expect(api.saveNote.mock.calls[0][1].summary[0].text).toBe('고친 문장');
  });
  it('keeps what was typed while a save was on its way', async () => {
    let finishSave!: (value: Consultation) => void;
    api.saveNote.mockReturnValueOnce(new Promise(resolve => { finishSave = resolve; }));
    await open();
    const field = () => screen.getByLabelText('핵심 요약 문장');
    fireEvent.change(field(), { target: { value: '첫 수정' } });
    await userEvent.click(screen.getByRole('button', { name: '임시 저장' }));
    fireEvent.change(field(), { target: { value: '저장 중에 더 고침' } });
    finishSave(consultation({ note: note({ summary: [{ id: 'c1', text: '첫 수정', evidence: [said] }] }) }));
    await screen.findByText('저장했습니다.');
    expect(field()).toHaveValue('저장 중에 더 고침');
    api.saveNote.mockResolvedValue(consultation());
    await userEvent.click(screen.getByRole('button', { name: '임시 저장' }));
    await waitFor(() => expect(api.saveNote).toHaveBeenCalledTimes(2));
    expect(api.saveNote.mock.calls[1][1].summary[0].text).toBe('저장 중에 더 고침');
  });
  it('shows what was delivered after approving, even if someone typed while it went through', async () => {
    let finish!: (value: Consultation) => void;
    api.approveConsultation.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    api.saveNote.mockResolvedValue(consultation());
    await open();
    await userEvent.click(screen.getByRole('button', { name: '확정하고 보호자에게 전달' }));
    await waitFor(() => expect(api.approveConsultation).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('핵심 요약 문장'), { target: { value: '확정 중에 친 글자' } });
    finish(consultation({ state: 'approved', note: note({ approvedAt: 'x' }) }));
    await waitFor(() => expect(screen.queryByText('확정 중에 친 글자')).toBeNull());
    expect(screen.queryByDisplayValue('확정 중에 친 글자')).toBeNull();
  });
  it('lets the trainer mark a safety flag as not applying, and undo it', async () => {
    api.getConsultation.mockResolvedValue(consultation({ note: note({ safetyFlags: ['통증', '구토'] }) }));
    api.saveNote.mockResolvedValue(consultation());
    await open();
    await userEvent.click(screen.getByRole('button', { name: '통증 해당 없음' }));
    expect(screen.getByRole('alert')).not.toHaveTextContent('통증');
    expect(screen.getByRole('alert')).toHaveTextContent('구토');
    await userEvent.click(screen.getByRole('button', { name: '통증 되돌리기' }));
    expect(screen.getByRole('alert')).toHaveTextContent('통증');
    await userEvent.click(screen.getByRole('button', { name: '통증 해당 없음' }));
    await userEvent.click(screen.getByRole('button', { name: '임시 저장' }));
    await waitFor(() => expect(api.saveNote).toHaveBeenCalled());
    expect(api.saveNote.mock.calls[0][1].dismissedFlags).toEqual(['통증']);
  });
  it('stays editable and shows why when approval is blocked', async () => {
    api.approveConsultation.mockRejectedValue(new ApiError('금지 표현을 고쳐 주세요: 치료', 'NOTE_BLOCKED'));
    await open();
    await userEvent.click(screen.getByRole('button', { name: '확정하고 보호자에게 전달' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('치료');
    expect(screen.getByLabelText('핵심 요약 문장')).toBeInTheDocument();
  });
  it('does not approve when the trainer backs out', async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    await open();
    await userEvent.click(screen.getByRole('button', { name: '확정하고 보호자에게 전달' }));
    expect(api.approveConsultation).not.toHaveBeenCalled();
  });
  it('becomes read-only once approved', async () => {
    api.getConsultation.mockResolvedValue(consultation({ state: 'approved', note: note({ approvedAt: 'x' }) }));
    await open();
    expect(screen.getByText('초인종에 짖는다')).toBeInTheDocument();
    expect(screen.queryByLabelText('핵심 요약 문장')).toBeNull();
    expect(screen.queryByRole('button', { name: '확정하고 보호자에게 전달' })).toBeNull();
    expect(screen.queryByRole('button', { name: '전사 수정' })).toBeNull();
  });
  it('regenerates only after asking, because it replaces edits', async () => {
    api.regenerateNote.mockResolvedValue(consultation({ noteGenerating: true }));
    await open();
    await userEvent.click(screen.getByRole('button', { name: '일지 다시 만들기' }));
    await waitFor(() => expect(api.regenerateNote).toHaveBeenCalledWith('c'));
    expect(await screen.findByText('일지 다시 만드는 중')).toBeInTheDocument();
  });
  it('edits the transcript and keeps the original visible as changed', async () => {
    const changed = consultation();
    changed.segments[0] = { ...changed.segments[0], text: '초인종 소리에 짖어요' };
    api.setSegment.mockResolvedValue(changed);
    await open();
    await userEvent.click(within(document.querySelector<HTMLElement>('[data-segment="a"]')!).getByRole('button', { name: '전사 수정' }));
    fireEvent.change(screen.getByLabelText('전사 수정'), { target: { value: '초인종 소리에 짖어요' } });
    await userEvent.click(screen.getByRole('button', { name: '전사 저장' }));
    await waitFor(() => expect(api.setSegment).toHaveBeenCalledWith('c', 'a', { text: '초인종 소리에 짖어요' }));
    expect(await within(document.querySelector<HTMLElement>('[data-segment="a"]')!).findByText('원문과 다름')).toHaveAttribute('title', '받아쓴 원문: 초인종에 짖어요');
  });
  it('lets the trainer clear an echo suspicion', async () => {
    const base = consultation();
    base.segments[1] = { ...base.segments[1], echoSuspect: true };
    api.getConsultation.mockResolvedValue(base);
    api.setSegment.mockResolvedValue(consultation());
    await open();
    expect(screen.getByText('상대 소리가 들어온 것으로 보임')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '실제 발화로 표시' }));
    await waitFor(() => expect(api.setSegment).toHaveBeenCalledWith('c', 'b', { echoSuspect: false }));
  });
  it('shows scene photos and lets the trainer confirm an observation', async () => {
    const scene = { id: 's1', atMs: 3000, frameIds: ['f1'], state: 'complete' as const, observations: [{ id: 'o1', text: '개가 매트에 앉아 있다', originalText: '개가 매트에 앉아 있다', reviewed: false }] };
    api.getConsultation.mockResolvedValue(consultation({ scenes: [scene] }));
    api.setObservation.mockResolvedValue(consultation({ scenes: [{ ...scene, observations: [{ ...scene.observations[0], reviewed: true }] }] }));
    await open();
    expect(screen.getByRole('img', { name: '상담 00:03 장면' })).toHaveAttribute('src', '/frames/c/f1');
    await userEvent.click(screen.getByRole('checkbox', { name: '확인한 관찰만 일지에 넣기' }));
    await waitFor(() => expect(api.setObservation).toHaveBeenCalledWith('c', 's1', 'o1', { reviewed: true }));
    expect(await screen.findByRole('checkbox', { name: '확인한 관찰만 일지에 넣기' })).toBeChecked();
  });
  it('checks the box at once, and puts it back if saving fails', async () => {
    const scene = { id: 's1', atMs: 3000, frameIds: [], state: 'complete' as const, observations: [{ id: 'o1', text: '개가 서 있다', originalText: '개가 서 있다', reviewed: false }] };
    api.getConsultation.mockResolvedValue(consultation({ scenes: [scene] }));
    let refuse!: (error: Error) => void;
    api.setObservation.mockReturnValue(new Promise((_resolve, reject) => { refuse = reject; }));
    await open();
    const box = screen.getByRole('checkbox', { name: '확인한 관찰만 일지에 넣기' });
    await userEvent.click(box);
    expect(box).toBeChecked();
    refuse(new ApiError('저장하지 못했습니다.', 'UPSTREAM'));
    expect(await screen.findByRole('alert')).toHaveTextContent('저장하지 못했습니다.');
    await waitFor(() => expect(screen.getByRole('checkbox', { name: '확인한 관찰만 일지에 넣기' })).not.toBeChecked());
  });
  it('saves an edited observation when the field loses focus', async () => {
    const scene = { id: 's1', atMs: 3000, frameIds: [], state: 'complete' as const, observations: [{ id: 'o1', text: '개가 서 있다', originalText: '개가 서 있다', reviewed: false }] };
    api.getConsultation.mockResolvedValue(consultation({ scenes: [scene] }));
    api.setObservation.mockResolvedValue(consultation({ scenes: [scene] }));
    await open();
    const field = screen.getByLabelText('장면 관찰');
    fireEvent.change(field, { target: { value: '개가 앉아 있다' } });
    fireEvent.blur(field);
    await waitFor(() => expect(api.setObservation).toHaveBeenCalledWith('c', 's1', 'o1', { text: '개가 앉아 있다' }));
  });
  it('states everything the trainer must not miss', async () => {
    api.getConsultation.mockResolvedValue(consultation({
      recordingGaps: [{ startMs: 60000, endMs: 90000 }], errors: [{ code: 'POST_PROCESS', message: '상담 정리 중 문제가 생겼습니다.' }],
      segments: [...consultation().segments, { id: 'x', speaker: 'trainer', startMs: 20000, endMs: 21000, text: '', originalText: '', state: 'failed' }],
      note: note({ safetyFlags: ['구토'], methodReview: true, warnings: ['일지에서 뺐습니다: "문장"'], fallbackUsed: true }),
    }));
    await open();
    expect(screen.getByText(/안전 신호: 구토/)).toBeInTheDocument();
    expect(screen.getByText(/체벌이나 강압적 방법/)).toBeInTheDocument();
    expect(screen.getByText(/기록이 멈춘 구간: 01:00~01:30/)).toBeInTheDocument();
    expect(screen.getByText(/받아쓰지 못한 구간이 1개/)).toBeInTheDocument();
    expect(screen.getByText('상담 정리 중 문제가 생겼습니다.')).toBeInTheDocument();
    expect(screen.getByText(/자동 검사에서 뺀 내용 1건/)).toBeInTheDocument();
    expect(screen.getByText(/빈 양식입니다/)).toBeInTheDocument();
  });
  it('does not offer approval for an interrupted consultation', async () => {
    api.getConsultation.mockResolvedValue(consultation({ state: 'interrupted', note: undefined }));
    await open();
    expect(screen.getByText(/상담이 중단되었습니다/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '확정하고 보호자에게 전달' })).toBeNull();
  });
});

describe('GuardianDelivery', () => {
  it('offers a printout or PDF of what was delivered', async () => {
    api.getDelivery.mockResolvedValue(delivery());
    const print = vi.spyOn(window, 'print').mockImplementation(() => {});
    render(<GuardianDelivery caseId="k" consultationId="c" />);
    await userEvent.click(await screen.findByRole('button', { name: '인쇄·PDF 저장' }));
    expect(print).toHaveBeenCalledOnce();
  });
  const delivery = (change: Partial<CoachingNote> = {}, scenes: { id: string; atMs: number; frameIds: string[] }[] = []) => ({ note: { ...note({ approvedAt: 'x', ...change }), uncitedSegmentIds: undefined }, scenes });
  it('shows the confirmed note with missing task details as unknown', async () => {
    api.getDelivery.mockResolvedValue(delivery());
    render(<GuardianDelivery caseId="k" consultationId="c" />);
    const article = await screen.findByRole('article', { name: '확정된 상담일지' });
    expect(within(article).getByText('초인종에 짖는다')).toBeInTheDocument();
    expect(within(article).getByText('매트 연습')).toBeInTheDocument();
    expect(within(article).getByText('보호자')).toBeInTheDocument();
    expect(within(article).getAllByText('미확인')).toHaveLength(3);
  });
  it('puts the vet notice ahead of the tasks when there is a safety flag', async () => {
    api.getDelivery.mockResolvedValue(delivery({ safetyFlags: ['구토'] }));
    render(<GuardianDelivery caseId="k" consultationId="c" />);
    const notice = await screen.findByRole('alert');
    expect(notice).toHaveTextContent('동물병원');
    const task = screen.getByText('매트 연습');
    expect(notice.compareDocumentPosition(task) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it('says so when no task was agreed', async () => {
    api.getDelivery.mockResolvedValue(delivery({ tasks: [] }));
    render(<GuardianDelivery caseId="k" consultationId="c" />);
    expect(await screen.findByText('정한 과제가 없습니다.')).toBeInTheDocument();
  });
  it('shows only the photos the confirmed note cites', async () => {
    const observation = { id: 'o1', text: '개가 매트에 앉아 있다', evidence: [{ kind: 'scene' as const, id: 's1', quote: '개가 매트에 앉아 있다', startMs: 3000, endMs: 3000 }] };
    api.getDelivery.mockResolvedValue(delivery({ aiObservations: [observation] }, [{ id: 's1', atMs: 3000, frameIds: ['f1'] }]));
    render(<GuardianDelivery caseId="k" consultationId="c" />);
    expect(await screen.findByRole('img', { name: '상담 00:03 장면' })).toHaveAttribute('src', '/frames/c/f1');
  });
  it('records how a task went, with a note, and shows the history', async () => {
    api.getDelivery.mockResolvedValue(delivery());
    const saved = { id: 'l1', caseId: 'k', consultationId: 'c', taskId: 't1', at: '2026-11-04T01:00:00.000Z', status: 'partial', text: '소리를 줄였어요' };
    api.addTaskLog.mockResolvedValue(saved);
    render(<GuardianDelivery caseId="k" consultationId="c" />);
    await userEvent.type(await screen.findByLabelText('매트 연습 메모'), '소리를 줄였어요');
    api.listTaskLogs.mockResolvedValue({ logs: [saved] });
    await userEvent.click(screen.getByRole('button', { name: '일부만 했어요' }));
    expect(api.addTaskLog).toHaveBeenCalledWith('k', { consultationId: 'c', taskId: 't1', status: 'partial', text: '소리를 줄였어요' });
    expect(await screen.findByRole('list', { name: '매트 연습 수행 기록' })).toHaveTextContent('일부 · 소리를 줄였어요');
    expect(screen.getByLabelText('매트 연습 메모')).toHaveValue('');
  });
  it('keeps the note when a record cannot be saved', async () => {
    api.getDelivery.mockResolvedValue(delivery());
    api.addTaskLog.mockRejectedValue(new ApiError('기록할 수 없습니다.', 'NOT_FOUND'));
    render(<GuardianDelivery caseId="k" consultationId="c" />);
    await userEvent.type(await screen.findByLabelText('매트 연습 메모'), '메모');
    await userEvent.click(screen.getByRole('button', { name: '했어요' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('기록할 수 없습니다.');
    expect(screen.getByLabelText('매트 연습 메모')).toHaveValue('메모');
  });
  it('reports a failed load', async () => {
    api.getDelivery.mockRejectedValue(new ApiError('상담일지를 볼 수 없습니다.', 'NOT_FOUND'));
    render(<GuardianDelivery caseId="k" consultationId="c" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('상담일지를 볼 수 없습니다.');
  });
});
