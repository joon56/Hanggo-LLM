import type { Config } from './config.ts';
import { createOllamaServices } from './ollama.ts';
import { createApiServices } from './api-services.ts';
import { createLocalTranscriber } from './local-speech.ts';
import { getProviderStatus } from './local-status.ts';
import { createLiveSpeech } from './live-speech.ts';

export function createAIServices(config: Config) {
  // Usage logs carry the model, token counts and latency, never record text.
  const text = config.provider === 'api' ? createApiServices(config, { onUsage: usage => console.info(JSON.stringify({ event: 'ai_usage', ...usage })),
    // No message and no input: vendor error text can echo request content.
    onError: ({ model, latencyMs, error, status }) => console.warn(JSON.stringify({ event: 'ai_error', model, latencyMs, error, status })) }) : createOllamaServices(config);
  return { ...text,
    liveSpeech: createLiveSpeech(config),
    status: () => getProviderStatus(config),
    transcribe: createLocalTranscriber({ executable: config.whisperExecutable, modelPath: config.whisperModelPath, ffmpegPath: config.ffmpegPath, timeoutMs: config.sttTimeoutMs }),
  };
}
