import type { Config } from './config.ts';
import { createOllamaServices } from './ollama.ts';
import { createLocalTranscriber } from './local-speech.ts';
import { getLocalStatus } from './local-status.ts';

export function createAIServices(config: Config) {
  return { ...createOllamaServices(config),
    status: () => getLocalStatus(config),
    transcribe: createLocalTranscriber({ executable: config.whisperExecutable, modelPath: config.whisperModelPath, ffmpegPath: config.ffmpegPath, timeoutMs: config.sttTimeoutMs }),
  };
}
