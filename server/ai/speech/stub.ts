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
  let crossings = 0; let counted = 0;
  for (let start = 0; start + FRAME_SAMPLES <= samples.length; start += FRAME_SAMPLES) {
    const frame = samples.subarray(start, start + FRAME_SAMPLES);
    const level = Math.sqrt(frame.reduce((sum, sample) => sum + (sample / 32768) ** 2, 0) / frame.length);
    if (level < AUDIBLE) continue;
    for (let index = 1; index < frame.length; index++) if ((frame[index - 1] < 0) !== (frame[index] < 0)) crossings += 1;
    counted += frame.length;
  }
  return counted ? crossings / 2 / (counted / SAMPLE_RATE) : 0;
}

export type StubScript = { speaker: string; text: string }[];

/**
 * For automated runs only. It recognizes which test tone reached the server, so a run can prove that
 * each microphone gets the right speaker label. It is not speech recognition and says so in its text.
 * With a script it answers that speaker's next line, so a recorded demo has readable captions.
 */
export function createStubSpeech(script: StubScript = []): SpeechProvider {
  const next = { guardian: 0, trainer: 0 };
  const scripted = (speaker: 'guardian' | 'trainer') => {
    const lines = script.filter(line => line.speaker === speaker);
    return lines.length ? `[시험 전사] ${lines[next[speaker]++ % lines.length].text}` : STUB_TEXT[speaker];
  };
  return {
    async prepare() {},
    async transcribe(wav) {
      const pitch = pitchOf(wav);
      const text = Math.abs(pitch - 440) < 60 ? scripted('guardian') : Math.abs(pitch - 880) < 120 ? scripted('trainer') : STUB_TEXT.unknown;
      return { text, model: 'stub', latencyMs: 0 };
    },
    async release() {},
  };
}
