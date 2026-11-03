import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Config } from '../../config.ts';
import { createCohereTranscribe } from './cohere-transcribe.ts';
import { cohereModelPath, createLiveSpeech } from './live-speech.ts';
import type { SpeechProvider } from './types.ts';

export function createSpeechProvider(config: Config, hooks: { unloadTextModel?: () => Promise<void> } = {}): SpeechProvider {
  if (config.liveSpeechModel !== 'cohere') return createLiveSpeech(config, hooks);
  // Without the CUDA build the npm package's bundled CPU and Vulkan library is used.
  const hasCudaBuild = existsSync(path.join(config.transcribeNativeDir, 'transcribe.dll'));
  return createCohereTranscribe({ modelPath: cohereModelPath(config), nativeDir: hasCudaBuild ? path.resolve(config.transcribeNativeDir) : undefined,
    cudaRuntimeDir: hasCudaBuild ? path.resolve(path.dirname(config.llamaServer)) : undefined, timeoutMs: config.sttTimeoutMs, beforeLoad: hooks.unloadTextModel });
}
