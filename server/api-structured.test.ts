// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { readConfig } from './config.ts';
import { createStructuredClient } from './api-structured.ts';

it('routes by model prefix and rejects unknown vendors', async () => {
  const gemini = vi.fn(async () => ({ json: 'g', inputTokens: 1, outputTokens: 1 })), claude = vi.fn(async () => ({ json: 'c', inputTokens: 1, outputTokens: 1 }));
  const client = createStructuredClient(readConfig({}), { gemini, claude });
  const schema = z.object({}).strict();
  await expect(client({ model: 'gemini-3.8-flash', system: '', input: {}, schema })).resolves.toMatchObject({ json: 'g' });
  await expect(client({ model: 'claude-haiku-5-5', system: '', input: {}, schema })).resolves.toMatchObject({ json: 'c' });
  await expect(client({ model: 'gpt-6', system: '', input: {}, schema })).rejects.toThrow('No API client for gpt-6.');
});
