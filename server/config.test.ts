// @vitest-environment node
import { expect, it } from 'vitest';
import { readConfig } from './config.ts';
it('defaults to local models without an API credential field', () => {
  const config = readConfig({});
  expect(config).toMatchObject({ provider: 'ollama', textModel: 'qwen3.5:9b', timeoutMs: 120000 });
  expect(config).not.toHaveProperty('apiKey');
});
it('cannot select a paid provider through obsolete environment settings', () => {
  const config = readConfig({ AI_PROVIDER: 'openai', OPENAI_API_KEY: 'obsolete-test-value', OPENAI_TEXT_MODEL: 'old-model' });
  expect(config).toMatchObject({ provider: 'ollama', textModel: 'qwen3.5:9b' });
  expect(config).not.toHaveProperty('apiKey');
});
it.each(['https://evil.example', 'http://192.168.0.1:11434', 'http://127.0.0.1:11434/path', 'http://user:pw@127.0.0.1:11434', 'http://127.0.0.1:11434?x=1'])('rejects non-local or ambiguous Ollama URL %s', url => {
  expect(() => readConfig({ OLLAMA_BASE_URL: url })).toThrow();
});
it('rejects invalid local limits', () => {
  expect(() => readConfig({ OLLAMA_CONTEXT_SIZE: '0' })).toThrow();
  expect(() => readConfig({ OLLAMA_TIMEOUT_MS: 'NaN' })).toThrow();
});
