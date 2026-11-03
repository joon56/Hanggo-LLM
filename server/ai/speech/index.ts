import { readFileSync } from 'node:fs';
import type { Config } from '../../config.ts';
import { createLiveSpeech } from './live-speech.ts';
import { createStubSpeech } from './stub.ts';
import type { SpeechProvider } from './types.ts';

export function createSpeechProvider(config: Config, hooks: { unloadTextModel?: () => Promise<void> } = {}): SpeechProvider {
  if (config.aiProvider !== 'stub') return createLiveSpeech(config, hooks);
  return createStubSpeech(config.stubScript ? JSON.parse(readFileSync(config.stubScript, 'utf8')).segments : []);
}
