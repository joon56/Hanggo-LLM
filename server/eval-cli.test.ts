// @vitest-environment node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import { createApp } from './app.ts';
import { readConfig } from './config.ts';
import { createDraft } from '../src/domain/notes.ts';

it('logs in before checking readiness when evaluating a password-protected local server', async () => {
  const password = 'synthetic-test-password';
  const generate = vi.fn(async (text: string) => ({ draft: { ...createDraft(text, 'trainer_summary_text'), mode: 'ollama' }, fallbackUsed: false }));
  const app = createApp(readConfig({ AI_ENABLED: 'true', APP_ACCESS_PASSWORD: password }), {
    generate, transcribe: async () => '', status: async () => ({ configured: true, sttReady: true, statusMessage: 'Ready' }),
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server port');
    const { stdout } = await promisify(execFile)(process.execPath, ['scripts/eval.ts', '--live', '--case', 'N01', '--base-url', `http://127.0.0.1:${address.port}`], {
      windowsHide: true, timeout: 10000, env: { ...process.env, APP_ACCESS_PASSWORD: password, PUBLIC_ORIGIN: 'http://127.0.0.1:5173' },
    });
    expect(stdout).toContain('N01: PASS');
    expect(generate).toHaveBeenCalledOnce();
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 15000);
