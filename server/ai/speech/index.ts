import type { Config } from '../../config.ts';
import { createLiveSpeech } from './live-speech.ts';
import type { SpeechProvider } from './types.ts';

export function createSpeechProvider(config: Config, hooks: { unloadTextModel?: () => Promise<void> } = {}): SpeechProvider {
  return createLiveSpeech(config, hooks);
}
