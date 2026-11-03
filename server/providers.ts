import path from 'node:path';
import type { Config } from './config.ts';
import { createAiServices } from './ai/services.ts';
import { createLlamaServer } from './ai/llm/llama-server.ts';
import { LLM_MODELS } from './ai/llm/models.ts';
import type { LlmProvider } from './ai/llm/types.ts';
import { createConsultationVision } from './consultation-vision.ts';
import { createLocalTranscriber } from './local-speech.ts';
import { getLocalStatus } from './local-status.ts';
import { createLiveSpeech } from './live-speech.ts';

export function createLlmProvider(config: Config): LlmProvider {
  const model: { file: string; mmproj?: string } = LLM_MODELS[config.llmModel];
  return createLlamaServer({ executable: path.resolve(config.llamaServer), model: path.resolve(config.home, model.file),
    mmproj: model.mmproj ? path.resolve(config.home, model.mmproj) : undefined, contextSize: config.contextSize });
}

export function createAIServices(config: Config) {
  const llm = createLlmProvider(config);
  return { ...createAiServices(config, llm), llm,
    vision: createConsultationVision(config, llm),
    liveSpeech: createLiveSpeech(config, { unloadTextModel: () => llm.release() }),
    status: () => getLocalStatus(config),
    transcribe: createLocalTranscriber({ executable: config.whisperExecutable, modelPath: config.whisperModelPath, ffmpegPath: config.ffmpegPath, timeoutMs: config.sttTimeoutMs }),
  };
}
