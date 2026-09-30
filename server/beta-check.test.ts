// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { readConfig } from '../server/config.ts';
import { checkBeta } from '../scripts/beta-check.ts';

vi.mock('../server/local-status.ts', () => ({ getLocalStatus: vi.fn(async () => ({ configured: true, sttReady: true, statusMessage: 'Ready' })) }));
const config = () => readConfig({ AI_ENABLED: 'true', FEATURE_OWNER_LOG_ENABLED: 'true', FEATURE_BRIEF_ENABLED: 'true', FEATURE_SHELTER_ENABLED: 'true' });
const session = { authenticated: true, aiEnabled: true, configured: true, provider: 'ollama', textModel: 'qwen3.5:9b', sttReady: true, features: { ownerLog: true, brief: true, shelter: true } };
afterEach(() => vi.unstubAllGlobals());
it('checks local readiness without generating or saving a record by default', async () => {
  const fetcher = vi.fn(async () => Response.json(session)); vi.stubGlobal('fetch', fetcher);
  const result = await checkBeta(config());
  expect(result.some(line => line.includes('준비 완료'))).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls.every(call => !((call as unknown[])[1] as RequestInit)?.method)).toBe(true);
});
it('refuses a remote UI before making any request', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  await expect(checkBeta({ ...config(), publicOrigin: 'https://example.com' })).rejects.toThrow('이 PC');
  expect(fetcher).not.toHaveBeenCalled();
});
it('does not pass warmup when the model falls back to rules', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(session)).mockResolvedValueOnce(Response.json(session))
    .mockResolvedValueOnce(Response.json({ fallbackUsed: true, draft: { mode: 'rule' } }));
  vi.stubGlobal('fetch', fetcher);
  await expect(checkBeta(config(), true)).rejects.toThrow('규칙');
  expect(JSON.parse(fetcher.mock.calls[2][1].body)).toMatchObject({ consent: true, sourceKind: 'trainer_summary_text' });
});
it('fails if the browser proxy cannot reach the same enabled features', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(session)).mockResolvedValueOnce(Response.json({ ...session, features: {} })));
  await expect(checkBeta(config())).rejects.toThrow('네 기능');
});
it('detects a server still running with an old model configuration', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...session, textModel: 'qwen2.5:3b' })));
  await expect(checkBeta(config())).rejects.toThrow('모델 설정');
});
it('closes only its own password session after a failed warmup', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ ...session, authenticated: false }))
    .mockResolvedValueOnce(Response.json({ ...session, authenticated: false }))
    .mockResolvedValueOnce(Response.json(session, { headers: { 'Set-Cookie': 'hanggo_session=synthetic; HttpOnly' } }))
    .mockResolvedValueOnce(Response.json({ fallbackUsed: true, draft: { mode: 'manual' } }))
    .mockResolvedValueOnce(Response.json({ authenticated: false }));
  vi.stubGlobal('fetch', fetcher);
  await expect(checkBeta({ ...config(), password: 'synthetic-password' }, true)).rejects.toThrow('규칙');
  expect(fetcher.mock.calls[4][1]).toMatchObject({ method: 'DELETE', headers: { Cookie: 'hanggo_session=synthetic' } });
});
