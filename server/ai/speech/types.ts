export type SpeechResult = { text: string; model: string; latencyMs: number };
export type SpeechProvider = {
  prepare(): Promise<void>;
  transcribe(wav: Buffer, signal?: AbortSignal): Promise<SpeechResult>;
  release(): Promise<void>;
};
