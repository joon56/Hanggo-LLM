import { describe, expect, it } from 'vitest';
import { SpeechWindows, type SpeechWindow } from './speech-windows';

const RATE = 16000;
const voice = (ms: number, amplitude = 0.1) => Float32Array.from({ length: ms * RATE / 1000 }, (_, index) => amplitude * Math.sin(2 * Math.PI * 200 * index / RATE));
const quiet = (ms: number) => new Float32Array(ms * RATE / 1000);
function run(...parts: Float32Array[]) {
  const windows: SpeechWindow[] = [];
  const speech = new SpeechWindows(RATE, window => windows.push(window));
  for (const part of parts) speech.push(part);
  return { speech, windows };
}
const lengthMs = ({ startMs, endMs }: SpeechWindow) => endMs - startMs;

describe('cut points', () => {
  it('cuts at a pause once three seconds have passed', () => {
    const { windows } = run(voice(4000), quiet(400));
    expect(windows).toHaveLength(1);
    expect(windows[0].startMs).toBe(0);
    expect(windows[0].endMs).toBeGreaterThanOrEqual(4000);
    expect(windows[0].endMs).toBeLessThanOrEqual(4400);
  });
  it('holds a pause before three seconds so a short reply stays with what follows', () => {
    const { windows } = run(voice(1000), quiet(500), voice(1000));
    expect(windows).toHaveLength(0);
  });
  it('falls back to the last brief pause after eight seconds', () => {
    const { windows } = run(voice(5000), quiet(100), voice(3000));
    expect(windows).toHaveLength(1);
    expect(windows[0].endMs).toBe(5100);
  });
  it('never exceeds fifteen seconds of unbroken speech and does not cut early', () => {
    const { windows } = run(voice(31000));
    expect(windows.length).toBeGreaterThanOrEqual(2);
    for (const window of windows) {
      expect(lengthMs(window)).toBeGreaterThanOrEqual(8000);
      expect(lengthMs(window)).toBeLessThanOrEqual(15000);
    }
  });
  it('finds a pause under the level of a loud speaker, not only true silence', () => {
    const { windows } = run(voice(4000, 0.2), voice(400, 0.01));
    expect(windows).toHaveLength(1);
  });
});

describe('silence', () => {
  it('sends nothing for silence, however long', () => {
    const { speech, windows } = run(quiet(40000));
    speech.flush();
    expect(windows).toEqual([]);
  });
  it('sends nothing for a brief click', () => {
    const { speech, windows } = run(quiet(1000), voice(100), quiet(5000));
    speech.flush();
    expect(windows).toEqual([]);
  });
  it('starts just before the speech instead of including the silence ahead of it', () => {
    const { windows } = run(quiet(5000), voice(4000), quiet(400));
    expect(windows).toHaveLength(1);
    expect(windows[0].startMs).toBeGreaterThanOrEqual(4600);
    expect(windows[0].startMs).toBeLessThanOrEqual(5000);
  });
});

describe('timing and format', () => {
  it('continues the clock across windows', () => {
    const { windows } = run(voice(4000), quiet(300), voice(4000), quiet(300));
    expect(windows).toHaveLength(2);
    expect(windows[1].startMs).toBe(windows[0].endMs);
  });
  it('reports how much audio it has received', () => {
    const { speech } = run(voice(1200), quiet(800));
    expect(speech.durationMs).toBe(2000);
  });
  it('emits 16kHz mono PCM whose size matches the reported times, whatever the input rate', () => {
    const windows: SpeechWindow[] = [];
    const speech = new SpeechWindows(48000, window => windows.push(window));
    speech.push(Float32Array.from({ length: 48000 * 4 }, (_, index) => 0.1 * Math.sin(2 * Math.PI * 200 * index / 48000)));
    speech.push(new Float32Array(48000 / 2));
    expect(windows).toHaveLength(1);
    expect(windows[0].bytes.type).toBe('audio/wav');
    expect((windows[0].bytes.size - 44) / 32).toBe(lengthMs(windows[0]));
  });
  it('flushes speech still in the buffer when the call ends', () => {
    const { speech, windows } = run(voice(1050));
    speech.flush();
    expect(windows).toHaveLength(1);
    expect(windows[0].endMs).toBe(1050);
    speech.flush();
    expect(windows).toHaveLength(1);
  });
});
