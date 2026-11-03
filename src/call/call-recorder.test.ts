import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallRecorder } from './call-recorder';

const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const voice = (ms: number) => Float32Array.from({ length: ms * 16 }, (_, index) => 0.1 * Math.sin(index / 5));
const silence = (ms: number) => new Float32Array(ms * 16);

function build(role: 'guardian' | 'trainer' = 'guardian', options: { hasMicrophone?: boolean; hasCamera?: boolean; tapError?: Error; transcribes?: () => boolean } = {}) {
  const audio = { getAudioTracks: () => options.hasMicrophone === false ? [] : [{ kind: 'audio' }], getVideoTracks: () => options.hasCamera === false ? [] : [{ kind: 'video' }] };
  let onSamples: (samples: Float32Array) => void = () => {};
  const tap = { sampleRate: 16000, stop: vi.fn() };
  const tapMicrophone = vi.fn(async (_track: MediaStreamTrack, listener: (samples: Float32Array) => void) => { if (options.tapError) throw options.tapError; onSamples = listener; return tap; });
  const grabbers: { stream: unknown; close: ReturnType<typeof vi.fn> }[] = [];
  const createGrabber = vi.fn((stream: MediaStream) => { const close = vi.fn(); grabbers.push({ stream, close }); return { grab: async () => new Blob(['jpeg']), close }; });
  const uploadAudio = vi.fn(async (_window: { startMs: number; endMs: number }) => {});
  const uploadFrame = vi.fn(async (_frame: { atMs: number; source: string; id: string }, _moment?: string) => {});
  const onLost = vi.fn();
  let nextId = 0;
  const recorder = new CallRecorder({ role, localStream: audio as unknown as MediaStream, tapMicrophone, createGrabber, uploadAudio, uploadFrame, isPermanent: () => true, onLost, transcribes: options.transcribes, createId: () => `frame-${nextId++}` });
  let time = 100000;
  const clock = () => time;
  return { recorder, tap, tapMicrophone, createGrabber, grabbers, uploadAudio, uploadFrame, onLost, clock, speak: (samples: Float32Array) => onSamples(samples), advance: async (ms: number) => { for (let elapsed = 0; elapsed < ms; elapsed += 100) { time += 100; await vi.advanceTimersByTimeAsync(100); } }, setTime: (value: number) => { time = value; } };
}

describe('nothing before recording', () => {
  it('touches no microphone, grabs no frame and sends nothing until started', async () => {
    const { tapMicrophone, createGrabber, uploadFrame, advance } = build();
    await advance(5000);
    expect(tapMicrophone).not.toHaveBeenCalled();
    expect(createGrabber).not.toHaveBeenCalled();
    expect(uploadFrame).not.toHaveBeenCalled();
  });
  it('starts once however many state messages repeat it', async () => {
    const { recorder, clock, tapMicrophone, createGrabber } = build();
    recorder.start(clock); recorder.start(clock); await flush();
    expect(tapMicrophone).toHaveBeenCalledTimes(1);
    expect(createGrabber).toHaveBeenCalledTimes(1);
  });
});

describe('speech', () => {
  it('uploads windows on the recording clock', async () => {
    const { recorder, clock, speak, uploadAudio, setTime } = build();
    recorder.start(clock); await flush();
    speak(voice(4000)); setTime(104000); speak(silence(400)); await flush();
    expect(uploadAudio).toHaveBeenCalledTimes(1);
    expect(uploadAudio.mock.calls[0][0]).toMatchObject({ startMs: 100000 });
  });
  it('starts the audio clock at the first sample, because the audio graph takes a moment to run after it opens', async () => {
    const { recorder, clock, speak, uploadAudio, setTime } = build();
    recorder.start(clock); await flush();
    setTime(100850);
    speak(voice(4000)); setTime(104850); speak(silence(400)); await flush();
    expect(uploadAudio.mock.calls[0][0]).toMatchObject({ startMs: 100850 });
  });
  it('does not produce negative times when the clock estimate is slightly early', async () => {
    const { recorder, clock, speak, uploadAudio, setTime } = build();
    setTime(-40);
    recorder.start(clock); await flush();
    speak(voice(1000)); recorder.stop({ flush: true }); await flush();
    expect(uploadAudio.mock.calls[0][0].startMs).toBe(0);
  });
  it('catches up with real time after audio stopped flowing for a while', async () => {
    const { recorder, clock, speak, uploadAudio, setTime } = build();
    recorder.start(clock); await flush();
    speak(voice(1000));
    setTime(160000);
    speak(voice(4000)); speak(silence(400)); await flush();
    expect(uploadAudio.mock.calls.at(-1)?.[0].endMs).toBeGreaterThanOrEqual(160000);
  });
  it('keeps recording scenes when a microphone is missing', async () => {
    const { recorder, clock, tapMicrophone, uploadFrame, advance } = build('guardian', { hasMicrophone: false });
    recorder.start(clock); await advance(1100);
    expect(tapMicrophone).not.toHaveBeenCalled();
    expect(uploadFrame).toHaveBeenCalled();
  });
  it('reports a microphone it cannot read without ending anything', async () => {
    const { recorder, clock, onLost, uploadFrame, advance } = build('guardian', { tapError: new Error('no worklet') });
    recorder.start(clock); await advance(1100);
    expect(onLost).toHaveBeenCalled();
    expect(uploadFrame).toHaveBeenCalled();
  });
  it('sends no speech when the server has no speech model, and does not call that a loss', async () => {
    const { recorder, clock, speak, uploadAudio, onLost } = build('guardian', { transcribes: () => false });
    recorder.start(clock); await flush();
    speak(voice(1000)); recorder.stop({ flush: true }); await flush();
    expect(uploadAudio).not.toHaveBeenCalled();
    expect(onLost).not.toHaveBeenCalled();
  });
  it('sends what is still buffered when the call ends', async () => {
    const { recorder, clock, speak, tap, uploadAudio } = build();
    recorder.start(clock); await flush();
    speak(voice(1000));
    recorder.stop({ flush: true }); await flush();
    expect(tap.stop).toHaveBeenCalled();
    expect(uploadAudio).toHaveBeenCalledTimes(1);
  });
  it('discards what is still buffered when consent is withdrawn', async () => {
    const { recorder, clock, speak, tap, uploadAudio } = build();
    recorder.start(clock); await flush();
    speak(voice(1000));
    recorder.stop({ flush: false }); await flush();
    expect(tap.stop).toHaveBeenCalled();
    expect(uploadAudio).not.toHaveBeenCalled();
  });
  it('closes a microphone that opened after recording already stopped', async () => {
    const { recorder, clock, tap } = build();
    recorder.start(clock);
    recorder.stop({ flush: false }); await flush();
    expect(tap.stop).toHaveBeenCalled();
  });
});

describe('scenes', () => {
  it('uploads the guardian camera every thirty seconds', async () => {
    const { recorder, clock, uploadFrame, advance } = build('guardian');
    recorder.start(clock);
    await advance(1100);
    expect(uploadFrame).toHaveBeenCalledTimes(1);
    expect(uploadFrame.mock.calls[0][0].source).toBe('camera');
    expect(uploadFrame.mock.calls[0][1]).toBeUndefined();
    await advance(25000);
    expect(uploadFrame).toHaveBeenCalledTimes(1);
    await advance(5100);
    expect(uploadFrame).toHaveBeenCalledTimes(2);
  });
  it('never uploads the trainer camera without a moment', async () => {
    const { recorder, clock, uploadFrame, advance } = build('trainer');
    recorder.start(clock); await advance(40000);
    expect(uploadFrame).not.toHaveBeenCalled();
  });
  it('uploads frames from at least five seconds before to two seconds after a moment', async () => {
    const { recorder, clock, uploadFrame, advance } = build('trainer');
    recorder.start(clock); await advance(8000);
    const atMs = clock();
    recorder.moment({ id: 'moment-1', atMs });
    await advance(1000);
    expect(uploadFrame).not.toHaveBeenCalled();
    await advance(1200);
    const times = uploadFrame.mock.calls.map(call => call[0].atMs);
    expect(uploadFrame.mock.calls.every(call => call[1] === 'moment-1')).toBe(true);
    expect(times).toHaveLength(8);
    expect(Math.min(...times)).toBeLessThanOrEqual(atMs - 5000);
    expect(Math.min(...times)).toBeGreaterThanOrEqual(atMs - 6000);
    expect(Math.max(...times)).toBeGreaterThanOrEqual(atMs + 1000);
    expect(Math.max(...times)).toBeLessThanOrEqual(atMs + 2000);
  });
  it('stores a shared screen only for a moment', async () => {
    const { recorder, clock, uploadFrame, advance, grabbers } = build('trainer');
    const screen = { getVideoTracks: () => [{}] } as unknown as MediaStream;
    recorder.start(clock); recorder.setScreen(screen);
    expect(grabbers[1].stream).toBe(screen);
    await advance(40000);
    expect(uploadFrame).not.toHaveBeenCalled();
    recorder.moment({ id: 'moment-1', atMs: clock() });
    await advance(2200);
    expect(new Set(uploadFrame.mock.calls.map(call => call[0].source))).toEqual(new Set(['camera', 'screen']));
    recorder.setScreen(null);
    expect(grabbers[1].close).toHaveBeenCalled();
  });
  it('starts capturing a screen that was already being shared when recording begins', async () => {
    const { recorder, clock, createGrabber } = build('trainer');
    const screen = { getVideoTracks: () => [{}] } as unknown as MediaStream;
    recorder.setScreen(screen);
    expect(createGrabber).not.toHaveBeenCalled();
    recorder.start(clock);
    expect(createGrabber).toHaveBeenCalledTimes(2);
  });
  it('skips the camera grabber when there is no camera', async () => {
    const { recorder, clock, createGrabber } = build('guardian', { hasCamera: false });
    recorder.start(clock);
    expect(createGrabber).not.toHaveBeenCalled();
  });
  it('sends a moment immediately when the call ends before its two seconds pass', async () => {
    const { recorder, clock, uploadFrame, advance } = build('trainer');
    recorder.start(clock); await advance(6000);
    recorder.moment({ id: 'moment-1', atMs: clock() });
    recorder.stop({ flush: true }); await flush();
    expect(uploadFrame.mock.calls.filter(call => call[1] === 'moment-1').length).toBeGreaterThan(0);
  });
  it('drops frames and pending moments when consent is withdrawn', async () => {
    const { recorder, clock, uploadFrame, grabbers, advance } = build('trainer');
    recorder.start(clock); await advance(6000);
    recorder.moment({ id: 'moment-1', atMs: clock() });
    recorder.stop({ flush: false });
    await advance(5000);
    expect(uploadFrame).not.toHaveBeenCalled();
    expect(grabbers[0].close).toHaveBeenCalled();
  });
  it('holds no frames from before a withdrawal once recording resumes', async () => {
    const { recorder, clock, uploadFrame, advance } = build('trainer');
    recorder.start(clock); await advance(6000);
    const withdrawnAt = clock();
    recorder.stop({ flush: false });
    await advance(1000);
    recorder.start(clock); await advance(1100);
    recorder.moment({ id: 'moment-1', atMs: clock() });
    await advance(2100);
    expect(uploadFrame.mock.calls.every(call => call[0].atMs > withdrawnAt)).toBe(true);
    expect(uploadFrame).toHaveBeenCalled();
  });
  it('ignores a moment that arrives while not recording', async () => {
    const { recorder, uploadFrame, advance } = build('trainer');
    recorder.moment({ id: 'moment-1', atMs: 0 });
    await advance(3000);
    expect(uploadFrame).not.toHaveBeenCalled();
  });
  it('reports frames that could not be delivered', async () => {
    const { recorder, clock, uploadFrame, onLost, advance } = build('guardian');
    uploadFrame.mockRejectedValue(new Error('refused'));
    recorder.start(clock); await advance(1100);
    expect(onLost).toHaveBeenCalled();
  });
});
