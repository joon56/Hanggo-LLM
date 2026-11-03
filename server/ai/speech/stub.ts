import type { SpeechProvider } from './types.ts';

const AUDIBLE = 0.001;
const HEADER = 44;
const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 800;

export const STUB_TEXT = {
  // Different wording on purpose: lines this alike within three seconds would be flagged as an echo.
  guardian: '[시험 전사] 초인종이 울리면 현관으로 뛰어가 짖어요',
  trainer: '[시험 전사] 매트로 가서 앉으면 바로 간식을 주세요',
  unknown: '[시험 전사] 알 수 없는 신호입니다',
};

/** Zero crossings over the audible parts only, because a pause holds no pitch to measure. */
function pitchOf(wav: Buffer) {
  const samples = new Int16Array(wav.buffer, wav.byteOffset + HEADER, Math.floor((wav.length - HEADER) / 2));
  let crossings = 0; let counted = 0; let previous: number | undefined;
  for (let start = 0; start + FRAME_SAMPLES <= samples.length; start += FRAME_SAMPLES) {
    const frame = samples.subarray(start, start + FRAME_SAMPLES);
    const level = Math.sqrt(frame.reduce((sum, sample) => sum + (sample / 32768) ** 2, 0) / frame.length);
    if (level < AUDIBLE) { previous = undefined; continue; }
    for (const sample of frame) {
      if (previous !== undefined && (previous < 0) !== (sample < 0)) crossings += 1;
      previous = sample;
    }
    counted += frame.length;
  }
  return counted ? crossings / 2 / (counted / SAMPLE_RATE) : 0;
}

export type StubScript = { speaker: string; text: string }[];
type Speaker = 'guardian' | 'trainer';
const SPEAKER_TONE: Record<Speaker, { hz: number; band: number; step: number }> = { guardian: { hz: 440, band: 60, step: 10 }, trainer: { hz: 880, band: 120, step: 20 } };
const LINE_BASE_HZ = { guardian: 400, trainer: 780 };

/** The tone that means one speaker's line of a script, so a recorded demo can say which line it is playing. */
export const scriptTone = (speaker: Speaker, line: number) => LINE_BASE_HZ[speaker] + SPEAKER_TONE[speaker].step * line;

/**
 * For automated runs only. It recognizes which test tone reached the server, so a run can prove that
 * each microphone gets the right speaker label. It is not speech recognition and says so in its text.
 * With a script, each tone stands for one line, so a recorded demo has readable captions in the right order,
 * even when a window is lost or one tone is cut into two windows.
 */
export function createStubSpeech(script: StubScript = []): SpeechProvider {
  const last: Partial<Record<Speaker, number>> = {};
  const scripted = (speaker: Speaker, pitch: number) => {
    const lines = script.filter(line => line.speaker === speaker);
    const line = Math.round((pitch - LINE_BASE_HZ[speaker]) / SPEAKER_TONE[speaker].step);
    if (!lines[line]) return STUB_TEXT[speaker];
    if (last[speaker] === line) return '';
    last[speaker] = line;
    return `[시험 전사] ${lines[line].text}`;
  };
  return {
    async prepare() {},
    async transcribe(wav) {
      const pitch = pitchOf(wav);
      const speaker = (['guardian', 'trainer'] as const).find(name => Math.abs(pitch - SPEAKER_TONE[name].hz) < SPEAKER_TONE[name].band);
      const text = speaker ? scripted(speaker, pitch) : STUB_TEXT.unknown;
      return { text, model: 'stub', latencyMs: 0 };
    },
    async release() {},
  };
}
