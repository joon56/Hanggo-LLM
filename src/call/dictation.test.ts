import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startDictation } from './dictation';

const tap = vi.hoisted(() => ({ listener: (_samples: Float32Array) => {}, stop: vi.fn() }));
vi.mock('./media-tools', () => ({ tapMicrophone: async (_track: unknown, listener: (samples: Float32Array) => void) => { tap.listener = listener; return { sampleRate: 16000, stop: tap.stop }; } }));

const voice = (ms: number) => Float32Array.from({ length: ms * 16 }, (_, index) => 0.1 * Math.sin(index / 5));
const flush = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };
beforeEach(() => { tap.stop.mockReset(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function open(transcribe: (bytes: Blob, order: number) => Promise<string>) {
  const stopTrack = vi.fn();
  const stream = { getAudioTracks: () => [{}], getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
  const onText = vi.fn(); const onError = vi.fn(); const onStopped = vi.fn();
  return { started: startDictation({ transcribe, onText, onError, onStopped, openMicrophone: async () => stream }), onText, onError, onStopped, stopTrack };
}

describe('startDictation', () => {
  it('sends speech and hands back the text, then lets go of the microphone', async () => {
    const { started, onText, onStopped, stopTrack } = open(async () => '오늘 산책했어요');
    const { stop } = await started;
    tap.listener(voice(1000));
    stop(); await flush();
    expect(onText).toHaveBeenCalledWith('오늘 산책했어요');
    expect(tap.stop).toHaveBeenCalled();
    expect(stopTrack).toHaveBeenCalled();
    expect(onStopped).toHaveBeenCalled();
  });
  it('keeps text in speaking order even when an early window answers late', async () => {
    const answers: ((text: string) => void)[] = [];
    const { started, onText } = open(() => new Promise(resolve => answers.push(resolve)));
    const { stop } = await started;
    tap.listener(voice(4000)); tap.listener(new Float32Array(16 * 400));
    tap.listener(voice(1000)); stop();
    expect(answers).toHaveLength(2);
    answers[1]('둘째'); await flush();
    expect(onText).not.toHaveBeenCalled();
    answers[0]('첫째'); await flush();
    expect(onText.mock.calls.map(call => call[0])).toEqual(['첫째', '둘째']);
  });
  it('ignores a window the model heard nothing in', async () => {
    const { started, onText } = open(async () => '');
    const { stop } = await started;
    tap.listener(voice(1000)); stop(); await flush();
    expect(onText).not.toHaveBeenCalled();
  });
  it('reports a failed window and keeps going', async () => {
    const answers = [Promise.reject(new Error('refused')), Promise.resolve('다음')];
    const { started, onText, onError } = open(() => answers.shift()!);
    const { stop } = await started;
    tap.listener(voice(4000)); tap.listener(new Float32Array(16 * 400));
    tap.listener(voice(1000)); stop(); await flush();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onText).toHaveBeenCalledWith('다음');
  });
  it('stops by itself after a minute, so a forgotten button cannot keep listening', async () => {
    const { started, onStopped } = open(async () => '');
    await started;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tap.stop).toHaveBeenCalled();
    expect(onStopped).toHaveBeenCalled();
  });
});
