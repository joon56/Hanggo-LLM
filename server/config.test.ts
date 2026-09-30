// @vitest-environment node
import { expect, it } from 'vitest';
import { readConfig } from './config.ts';
it('preserves OpenAI defaults and supports a keyless local provider', () => {
  expect(readConfig({})).toMatchObject({ provider: 'openai', textModel: 'gpt-4.1-mini' });
  expect(readConfig({ AI_PROVIDER: 'ollama' })).toMatchObject({ provider: 'ollama', apiKey: '', textModel: 'qwen3.5:9b', timeoutMs: 120000 });
});
it.each(['https://evil.example', 'http://192.168.0.1:11434', 'http://127.0.0.1:11434/path', 'http://user:pw@127.0.0.1:11434', 'http://127.0.0.1:11434?x=1'])('rejects non-local or ambiguous Ollama URL %s', url => {
  expect(() => readConfig({ AI_PROVIDER: 'ollama', OLLAMA_BASE_URL: url })).toThrow();
});
it('rejects unknown providers and invalid local limits', () => {
  expect(() => readConfig({ AI_PROVIDER: 'typo' })).toThrow();
  expect(() => readConfig({ OLLAMA_CONTEXT_SIZE: '0' })).toThrow();
  expect(() => readConfig({ OLLAMA_TIMEOUT_MS: 'NaN' })).toThrow();
});
