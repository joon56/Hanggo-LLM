import { GoogleGenAI } from '@google/genai';
import type { ApiEffort } from './config.ts';
import { toWireSchema, type StructuredClient } from './api-types.ts';

type Interactions = Pick<GoogleGenAI['interactions'], 'create'>;
export function createGeminiClient(apiKey: string, timeoutMs: number, effort: ApiEffort, interactions: Interactions = new GoogleGenAI({ apiKey }).interactions): StructuredClient {
  return async ({ model, system, input, schema, signal }) => {
    const interaction = await interactions.create({ model, system_instruction: system, input: JSON.stringify(input), store: false,
      response_format: { type: 'text', mime_type: 'application/json', schema: toWireSchema(schema, 'gemini') }, generation_config: { thinking_level: effort } },
      { timeout_ms: timeoutMs, retries: { strategy: 'attempt-count-backoff', maxRetries: 1 }, fetch_options: { signal } });
    if (interaction.status !== 'completed' || !interaction.output_text) throw new Error(`Gemini returned ${interaction.status}.`);
    const usage = interaction.usage;
    return { json: JSON.parse(interaction.output_text), inputTokens: usage?.total_input_tokens ?? 0, outputTokens: (usage?.total_output_tokens ?? 0) + (usage?.total_thought_tokens ?? 0) };
  };
}
