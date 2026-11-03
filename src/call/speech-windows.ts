export type SpeechWindow = { bytes: Blob; startMs: number; endMs: number };

const RATE = 16000;
const SAMPLES_PER_MS = RATE / 1000;
const FRAME = 1600;
const MIN_FRAMES = 30;
const PREFERRED_FRAMES = 80;
const MAX_FRAMES = 150;
const PAUSE_FRAMES = 3;
const LEAD_IN_FRAMES = 3;
const MIN_VOICED_FRAMES = 3;
const AUDIBLE = 0.003;
const PAUSE_RATIO = 0.1;

export function encodeWav(samples: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2); const view = new DataView(buffer);
  const text = (at: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, RATE, true); view.setUint32(28, RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) { const sample = Math.max(-1, Math.min(1, samples[i])); view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true); }
  return buffer;
}

/** Cuts a microphone stream at pauses, because fixed windows split words and silence makes speech models invent text. */
export class SpeechWindows {
  private readonly buffer = new Float32Array(MAX_FRAMES * FRAME);
  private length = 0;
  /** Loudness of each whole 100ms frame in the buffer. */
  private levels: number[] = [];
  private windowStart = 0;
  private received = 0;
  private weighted = 0;
  private weight = 0;
  private readonly ratio: number;
  private readonly emit: (window: SpeechWindow) => void;
  constructor(sampleRate: number, emit: (window: SpeechWindow) => void) { this.ratio = sampleRate / RATE; this.emit = emit; }

  get durationMs() { return Math.round(this.received / SAMPLES_PER_MS); }

  /** Streaming resampling keeps the fractional position across worklet blocks. */
  push(samples: Float32Array) {
    for (const sample of samples) {
      let remaining = 1;
      while (remaining > 1e-9) {
        const part = Math.min(remaining, this.ratio - this.weight); this.weighted += sample * part; this.weight += part; remaining -= part;
        if (this.weight >= this.ratio - 1e-9) { this.append(this.weighted / this.ratio); this.weighted = 0; this.weight = 0; }
      }
    }
  }

  flush() {
    if (this.voiced(this.levels.length)) this.output(this.length);
    this.windowStart += this.length; this.length = 0; this.levels = [];
  }

  private append(sample: number) {
    this.buffer[this.length++] = sample; this.received += 1;
    if (this.length % FRAME) return;
    let squares = 0;
    for (let index = this.length - FRAME; index < this.length; index++) squares += this.buffer[index] ** 2;
    this.levels.push(Math.sqrt(squares / FRAME));
    this.trimLeadingSilence();
    const cut = this.chooseCut();
    if (cut) this.cut(cut);
  }

  private trimLeadingSilence() {
    if (this.levels.length <= LEAD_IN_FRAMES || this.levels.some(level => level >= AUDIBLE)) return;
    this.drop(1);
  }

  private chooseCut() {
    const count = this.levels.length;
    if (count < MIN_FRAMES) return 0;
    // A loud speaker's pause still carries room noise, so a pause is relative to this window's loudest frame.
    const pause = Math.max(AUDIBLE, Math.max(...this.levels) * PAUSE_RATIO);
    if (this.levels.slice(-PAUSE_FRAMES).every(level => level < pause)) return count;
    if (count < PREFERRED_FRAMES) return 0;
    for (let index = count - 1; index >= MIN_FRAMES; index--) if (this.levels[index] < pause) return index + 1;
    if (count < MAX_FRAMES) return 0;
    let quietest = PREFERRED_FRAMES;
    for (let index = PREFERRED_FRAMES; index < count; index++) if (this.levels[index] < this.levels[quietest]) quietest = index;
    return quietest + 1;
  }

  private voiced(frames: number) { return this.levels.slice(0, frames).filter(level => level >= AUDIBLE).length >= MIN_VOICED_FRAMES; }

  private output(samples: number) {
    const startMs = Math.round(this.windowStart / SAMPLES_PER_MS);
    const endMs = Math.max(startMs + 1, Math.round((this.windowStart + samples) / SAMPLES_PER_MS));
    this.emit({ bytes: new Blob([encodeWav(this.buffer.slice(0, samples))], { type: 'audio/wav' }), startMs, endMs });
  }

  private cut(frames: number) {
    if (this.voiced(frames)) this.output(frames * FRAME);
    this.drop(frames);
  }

  private drop(frames: number) {
    const samples = frames * FRAME;
    this.buffer.copyWithin(0, samples, this.length);
    this.length -= samples; this.windowStart += samples;
    this.levels = this.levels.slice(frames);
  }
}
