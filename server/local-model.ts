import type { Config } from './config.ts';

export function supportsLocalGuards(version: unknown): boolean {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:$|-)/.test(version)) return false;
  const [major, minor, patch] = version.split('.').map(Number.parseFloat);
  return major > 0 || (minor > 34 || (minor === 34 && patch >= 4));
}

// An Ollama model name can alias cloud inference. Check metadata before sending
// any record contents, not merely whether its name ends in ':cloud'.
export async function assertLocalModel(config: Config, signal: AbortSignal): Promise<void> {
  const version = await fetch(`${config.ollamaBaseUrl}/api/version`, { signal, redirect: 'error' });
  if (!version.ok || !supportsLocalGuards((await version.json()).version)) throw new Error('Ollama 0.34.4 or newer is required.');
  const response = await fetch(`${config.ollamaBaseUrl}/api/show`, {
    method: 'POST', redirect: 'error', signal, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.textModel }),
  });
  if (!response.ok) throw new Error('Local model metadata unavailable.');
  const model = await response.json();
  if (model.remote_host || model.remote_model || model.details?.format !== 'gguf' || !model.capabilities?.includes('completion'))
    throw new Error('Only downloaded local completion models are allowed.');
}
