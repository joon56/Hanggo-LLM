import Anthropic from '@anthropic-ai/sdk';
import type { ApiEffort } from './config.ts';
import { toWireSchema, type StructuredClient } from './api-types.ts';

type Messages = Pick<Anthropic['messages'], 'create'>;
// No server-side model fallback: a model comparison must know which model answered.
export function createClaudeClient(apiKey: string, timeoutMs: number, effort: ApiEffort, messages: Messages = new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 1 }).messages): StructuredClient {
  return async ({ model, system, input, schema, signal }) => {
    const response = await messages.create({ model, max_tokens: 16000, system, messages: [{ role: 'user', content: JSON.stringify(input) }],
      output_config: { effort, format: { type: 'json_schema', schema: toWireSchema(schema, 'claude') } } }, { signal });
    if (response.stop_reason !== 'end_turn') throw new Error(`Claude stopped with ${response.stop_reason}.`);
    const text = response.content.find(block => block.type === 'text');
    if (!text || text.type !== 'text') throw new Error('Claude returned no text.');
    return { json: JSON.parse(text.text), inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
  };
}
