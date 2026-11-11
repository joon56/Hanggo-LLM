// @vitest-environment node
import { expect, it } from 'vitest';
import { activeTextModel, readConfig } from './config.ts';
it('defaults to local models without an API credential field', () => {
  const config = readConfig({});
  expect(config).toMatchObject({ provider: 'ollama', textModel: 'qwen3.5:9b', timeoutMs: 120000 });
  expect(config).not.toHaveProperty('apiKey');
});
it('cannot select a paid provider through obsolete environment settings', () => {
  expect(() => readConfig({ AI_PROVIDER: 'openai', OPENAI_API_KEY: 'obsolete-test-value' })).toThrow('AI_PROVIDER must be local or api.');
  const config = readConfig({ OPENAI_API_KEY: 'obsolete-test-value', OPENAI_TEXT_MODEL: 'old-model' });
  expect(config).toMatchObject({ provider: 'ollama', textModel: 'qwen3.5:9b' });
  expect(config).not.toHaveProperty('apiKey');
});
it('defaults to the local provider with API settings ready but unused', () => {
  expect(readConfig({ AI_PROVIDER: 'local' })).toMatchObject({ provider: 'ollama', apiTextModel: 'gemini-3.8-flash', apiShortModel: 'gemini-3.8-flash', apiEffort: 'low', apiTimeoutMs: 60000 });
});
it('requires the key of every vendor an API model needs', () => {
  expect(() => readConfig({ AI_PROVIDER: 'api', ANTHROPIC_API_KEY: 'test-a' })).toThrow('GEMINI_API_KEY is required for gemini-3.8-flash.');
  expect(() => readConfig({ AI_PROVIDER: 'api', GEMINI_API_KEY: 'test-g', API_SHORT_MODEL: 'claude-haiku-5-5' })).toThrow('ANTHROPIC_API_KEY is required for claude-haiku-5-5.');
  expect(readConfig({ AI_PROVIDER: 'api', GEMINI_API_KEY: 'test-g' })).toMatchObject({ provider: 'api', apiTextModel: 'gemini-3.8-flash', apiShortModel: 'gemini-3.8-flash' });
  expect(readConfig({ AI_PROVIDER: 'api', API_TEXT_MODEL: 'claude-sonnet-5-5', API_SHORT_MODEL: 'claude-haiku-5-5', ANTHROPIC_API_KEY: 'test-a' })).toMatchObject({ apiTextModel: 'claude-sonnet-5-5' });
});
it('rejects unknown API models and effort levels', () => {
  expect(() => readConfig({ AI_PROVIDER: 'api', API_TEXT_MODEL: 'gpt-6', GEMINI_API_KEY: 'test-g', ANTHROPIC_API_KEY: 'test-a' })).toThrow('Unsupported API model: gpt-6');
  expect(() => readConfig({ API_EFFORT: 'max' })).toThrow('API_EFFORT must be low, medium or high.');
});
it('reports the active text model for the session', () => {
  expect(activeTextModel(readConfig({}))).toBe('qwen3.5:9b');
  expect(activeTextModel(readConfig({ AI_PROVIDER: 'api', GEMINI_API_KEY: 'test-g', ANTHROPIC_API_KEY: 'test-a' }))).toBe('gemini-3.8-flash');
});
it.each(['https://evil.example', 'http://192.168.0.1:11434', 'http://127.0.0.1:11434/path', 'http://user:pw@127.0.0.1:11434', 'http://127.0.0.1:11434?x=1'])('rejects non-local or ambiguous Ollama URL %s', url => {
  expect(() => readConfig({ OLLAMA_BASE_URL: url })).toThrow();
});
it('rejects invalid local limits', () => {
  expect(() => readConfig({ OLLAMA_CONTEXT_SIZE: '0' })).toThrow();
  expect(() => readConfig({ OLLAMA_TIMEOUT_MS: 'NaN' })).toThrow();
});
