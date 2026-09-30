import { act, renderHook } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { useRecorder } from './useRecorder';

const stopTrack = vi.fn();
const getUserMedia = vi.fn();
class RecorderMock {
  static isTypeSupported = () => true;
  state = 'inactive';
  mimeType = 'audio/webm';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  start() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['sample'], { type: 'audio/webm' }) });
    this.onstop?.();
  }
}

describe('녹음 수명주기', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stopTrack.mockReset();
    getUserMedia.mockReset().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] });
    vi.stubGlobal('MediaRecorder', RecorderMock);
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    URL.createObjectURL = vi.fn(() => 'blob:local-audio');
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('정지하면 마이크를 해제하고 재생 주소를 제공한다', async () => {
    const { result, unmount } = renderHook(() => useRecorder());
    await act(() => result.current.start());
    act(() => vi.advanceTimersByTime(4000));
    act(() => result.current.stop());
    expect(result.current.status).toBe('ready');
    expect(result.current.audioUrl).toBe('blob:local-audio');
    expect(stopTrack).toHaveBeenCalled();
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-audio');
  });

  it('권한 거부를 알리고 텍스트 입력을 안내한다', async () => {
    getUserMedia.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    const { result } = renderHook(() => useRecorder());
    await act(() => result.current.start());
    expect(result.current.status).toBe('idle');
    expect(result.current.error).toContain('텍스트');
  });

  it('60초에 자동 정지한다', async () => {
    const { result } = renderHook(() => useRecorder());
    await act(() => result.current.start());
    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current.status).toBe('ready');
    expect(result.current.duration).toBe(60);
    expect(stopTrack).toHaveBeenCalled();
  });

  it('3초 미만 녹음을 버린다', async () => {
    const { result } = renderHook(() => useRecorder());
    await act(() => result.current.start());
    act(() => vi.advanceTimersByTime(1000));
    act(() => result.current.stop());
    expect(result.current.audioUrl).toBeNull();
    expect(result.current.error).toContain('3초');
  });

  it('권한 대기 중 초기화하면 뒤늦게 도착한 마이크를 해제한다', async () => {
    let resolvePermission!: (value: unknown) => void;
    getUserMedia.mockReturnValue(new Promise(resolve => { resolvePermission = resolve; }));
    const { result } = renderHook(() => useRecorder());
    let pending!: Promise<void>;
    act(() => { pending = result.current.start(); });
    act(() => result.current.reset());
    await act(async () => {
      resolvePermission({ getTracks: () => [{ stop: stopTrack }] });
      await pending;
    });
    expect(stopTrack).toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
  });
});
