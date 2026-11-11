// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createClaudeClient } from './claude-client.ts';

const schema = z.object({ value: z.string().nullable() }).strict();
const message = (extra = {}) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"value":"ok"}' }], usage: { input_tokens: 12, output_tokens: 5 }, ...extra });

it('sends a JSON schema with the configured effort and no sampling or fallback parameters', async () => {
  const create = vi.fn(async () => message());
  const client = createClaudeClient('test-key', 1000, 'low', { create } as never);
  const signal = new AbortController().signal;
  await expect(client({ model: 'claude-haiku-5-5', system: 'rules', input: { sentences: [] }, schema, signal })).resolves.toEqual({ json: { value: 'ok' }, inputTokens: 12, outputTokens: 5 });
  const [body, options] = create.mock.calls[0] as unknown as [Record<string, any>, { signal: AbortSignal }];
  expect(body).toMatchObject({ model: 'claude-haiku-5-5', system: 'rules', output_config: { effort: 'low', format: { type: 'json_schema', schema: { type: 'object', additionalProperties: false } } } });
  expect(body).not.toHaveProperty('temperature'); expect(body).not.toHaveProperty('fallbacks');
  expect(body.messages).toEqual([{ role: 'user', content: '{"sentences":[]}' }]);
  expect(options.signal).toBe(signal);
});
it.each(['refusal', 'max_tokens'])('treats %s as a failed call', async stop => {
  const client = createClaudeClient('test-key', 1000, 'low', { create: vi.fn(async () => message({ stop_reason: stop })) } as never);
  await expect(client({ model: 'claude-sonnet-5-5', system: 's', input: {}, schema })).rejects.toThrow(`Claude stopped with ${stop}.`);
});
