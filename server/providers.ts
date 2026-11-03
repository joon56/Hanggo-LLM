import path from 'node:path';
import type { Config } from './config.ts';
import { createAiServices } from './ai/services.ts';
import { createLlamaServer } from './ai/llm/llama-server.ts';
import { createStubLlm } from './ai/llm/stub.ts';
import { LLM_MODELS } from './ai/llm/models.ts';
import type { LlmProvider } from './ai/llm/types.ts';
import { getLocalStatus } from './local-status.ts';
import { createSpeechProvider } from './ai/speech/index.ts';
import { createUploadTranscriber } from './ai/speech/upload.ts';

export function createLlmProvider(config: Config): LlmProvider {
  if (config.aiProvider === 'stub') return createStubLlm();
  const model: { file: string; mmproj?: string } = LLM_MODELS[config.llmModel];
  return createLlamaServer({ executable: path.resolve(config.llamaServer), model: path.resolve(config.home, model.file),
    mmproj: model.mmproj ? path.resolve(config.home, model.mmproj) : undefined, contextSize: config.contextSize });
}

export function createAIServices(config: Config) {
  const llm = createLlmProvider(config);
  const speech = createSpeechProvider(config, { unloadTextModel: () => llm.release() });
  return { ...createAiServices(config, llm), llm,
    liveSpeech: speech,
    status: () => getLocalStatus(config),
    transcribe: createUploadTranscriber({ speech, ffmpegPath: config.ffmpegPath, timeoutMs: config.sttTimeoutMs }),
  };
}
