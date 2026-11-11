// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createGeminiClient } from './gemini-client.ts';

const schema = z.object({ value: z.string().nullable() }).strict();

it('requests JSON with the configured thinking level and without storage, counting thought tokens as output', async () => {
  const create = vi.fn(async () => ({ status: 'completed', output_text: '{"value":null}', usage: { total_input_tokens: 20, total_output_tokens: 4, total_thought_tokens: 6 } }));
  const client = createGeminiClient('test-key', 1000, 'low', { create } as never);
  const signal = new AbortController().signal;
  await expect(client({ model: 'gemini-3.8-flash', system: 'rules', input: { a: 1 }, schema, signal })).resolves.toEqual({ json: { value: null }, inputTokens: 20, outputTokens: 10 });
  const [body, options] = create.mock.calls[0] as unknown as [Record<string, any>, Record<string, any>];
  expect(body).toMatchObject({ model: 'gemini-3.8-flash', system_instruction: 'rules', input: '{"a":1}', store: false, generation_config: { thinking_level: 'low' }, response_format: { type: 'text', mime_type: 'application/json' } });
  expect(body.response_format.schema.properties.value).toEqual({ type: ['string', 'null'] });
  expect(options).toMatchObject({ timeout_ms: 1000, retries: { strategy: 'attempt-count-backoff', maxRetries: 1 }, fetch_options: { signal } });
});
it('treats an unfinished interaction as a failed call', async () => {
  const client = createGeminiClient('test-key', 1000, 'low', { create: vi.fn(async () => ({ status: 'incomplete', output_text: '{}' })) } as never);
  await expect(client({ model: 'gemini-3.8-flash', system: 's', input: {}, schema })).rejects.toThrow('Gemini returned incomplete.');
});
