import { apiVendor, type Config } from './config.ts';
import { createClaudeClient } from './claude-client.ts';
import { createGeminiClient } from './gemini-client.ts';
import type { ApiVendor, StructuredClient } from './api-types.ts';

export function createStructuredClient(config: Config, clients: Partial<Record<ApiVendor, StructuredClient>> = {}): StructuredClient {
  const gemini = clients.gemini ?? (config.geminiApiKey ? createGeminiClient(config.geminiApiKey, config.apiTimeoutMs, config.apiEffort) : undefined);
  const claude = clients.claude ?? (config.anthropicApiKey ? createClaudeClient(config.anthropicApiKey, config.apiTimeoutMs, config.apiEffort) : undefined);
  return request => {
    const vendor = apiVendor(request.model), client = vendor === 'gemini' ? gemini : vendor === 'claude' ? claude : undefined;
    return client ? client(request) : Promise.reject(new Error(`No API client for ${request.model}.`));
  };
}
