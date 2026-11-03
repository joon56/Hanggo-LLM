// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { loadLocalEnv, readConfig } from './config.ts';
it('requires a long password outside the local profile even on loopback', () => {
  expect(() => readConfig({ HANGGO_PROFILE: 'tunnel' })).toThrow(/APP_ACCESS_PASSWORD/);
  expect(() => readConfig({ HANGGO_PROFILE: 'tunnel', APP_ACCESS_PASSWORD: 'short' })).toThrow(/APP_ACCESS_PASSWORD/);
  expect(readConfig({ HANGGO_PROFILE: 'tunnel', APP_ACCESS_PASSWORD: 'long-test-password-1234' }).profile).toBe('tunnel');
  expect(readConfig({}).profile).toBe('local');
});
it('rejects an unknown profile', () => {
  expect(() => readConfig({ HANGGO_PROFILE: 'public' })).toThrow(/HANGGO_PROFILE/);
});
it('derives runtime and data paths from HANGGO_HOME', () => {
  const home = path.join('D:', 'hanggo');
  const config = readConfig({ HANGGO_HOME: home });
  expect(config.home).toBe(home);
  expect(config.consultationDirectory).toBe(path.join(home, 'data', 'consultations'));
  expect(config.llamaServer).toBe(path.join(home, 'runtime', 'llama-cpp', 'llama-server.exe'));
  expect(config.whisperServer).toBe(path.join(home, 'runtime', 'whisper-cpp', 'Release', 'whisper-server.exe'));
  expect(config.liveModelDirectory).toBe(path.join(home, 'models', 'stt'));
});
it('selects the stub AI provider only by its exact name', () => {
  expect(readConfig({ AI_PROVIDER: 'stub' }).aiProvider).toBe('stub');
  expect(readConfig({ AI_PROVIDER: 'openai' }).aiProvider).toBe('local');
});
it('loads settings and secrets from the home pointer without overriding set values', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'hanggo-env-'));
  try {
    const pointer = path.join(directory, '.hanggo-home');
    writeFileSync(pointer, `${directory}\n`);
    writeFileSync(path.join(directory, 'settings.env'), 'AI_ENABLED=true\nPORT=4000\n');
    writeFileSync(path.join(directory, 'secrets.env'), 'APP_ACCESS_PASSWORD=from-secrets-file\nTURN_USERNAME=\n');
    const env: NodeJS.ProcessEnv = { PORT: '5000', APP_ACCESS_PASSWORD: '' };
    loadLocalEnv(env, pointer);
    expect(env).toMatchObject({ HANGGO_HOME: directory, AI_ENABLED: 'true', PORT: '5000', APP_ACCESS_PASSWORD: 'from-secrets-file' });
    expect(env.TURN_USERNAME).toBeFalsy();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
it('leaves the environment alone when no home is configured', () => {
  const env: NodeJS.ProcessEnv = {};
  loadLocalEnv(env, path.join(tmpdir(), 'hanggo-missing-pointer'));
  expect(env).toEqual({});
});
it('defaults to local models without an API credential field', () => {
  const config = readConfig({});
  expect(config).toMatchObject({ provider: 'local', llmModel: 'gemma4-12b', textModel: 'gemma4-12b', contextSize: 8192, timeoutMs: 300000 });
  expect(config).not.toHaveProperty('apiKey');
});
it('cannot select a paid provider through obsolete environment settings', () => {
  const config = readConfig({ AI_PROVIDER: 'openai', OPENAI_API_KEY: 'obsolete-test-value', OPENAI_TEXT_MODEL: 'old-model' });
  expect(config).toMatchObject({ provider: 'local', aiProvider: 'local', textModel: 'gemma4-12b' });
  expect(config).not.toHaveProperty('apiKey');
});
it('accepts known local models and rejects others', () => {
  expect(readConfig({ LLM_MODEL: 'qwen38-27b' }).llmModel).toBe('qwen38-27b');
  expect(() => readConfig({ LLM_MODEL: 'gpt-5' })).toThrow(/LLM_MODEL/);
  expect(() => readConfig({ LLM_MODEL: 'constructor' })).toThrow(/LLM_MODEL/);
});
it('rejects invalid local limits', () => {
  expect(() => readConfig({ LLM_CONTEXT_SIZE: '0' })).toThrow();
  expect(() => readConfig({ LLM_TIMEOUT_MS: 'NaN' })).toThrow();
});
