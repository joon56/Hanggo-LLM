// Paths are relative to HANGGO_HOME and must match scripts/models.manifest.json.
export const LLM_MODELS = {
  'qwen38-27b': { file: 'models/llm/qwen38-27b/Qwen3.8-27B-Q4_K_M.gguf', mmproj: 'models/llm/qwen38-27b/mmproj-Qwen3.8-27B-bf16.gguf' },
  'qwen35-9b': { file: 'models/llm/qwen35-9b/Qwen3.5-9B-Q4_K_M.gguf', mmproj: 'models/llm/qwen35-9b/mmproj-BF16.gguf' },
  'qwen35-4b': { file: 'models/llm/qwen35-4b/Qwen3.5-4B-Q4_K_M.gguf' },
  'hcx-14b': { file: 'models/llm/hcx-14b/HyperCLOVAX-SEED-Think-14B-Q4_K_M.gguf' },
  'gemma4-12b': { file: 'models/llm/gemma4-12b/gemma-4-12b-it-qat-q4_0.gguf', mmproj: 'models/llm/gemma4-12b/mmproj-gemma-4-12b-it-qat-q4_0.gguf' },
  'gemma4-e4b': { file: 'models/llm/gemma4-e4b/gemma-4-E4B_q4_0-it.gguf', mmproj: 'models/llm/gemma4-e4b/gemma-4-E4B-it-mmproj.gguf' },
} as const satisfies Record<string, { file: string; mmproj?: string }>;
export type LlmModel = keyof typeof LLM_MODELS;
export const isLlmModel = (value: string): value is LlmModel => Object.hasOwn(LLM_MODELS, value);
