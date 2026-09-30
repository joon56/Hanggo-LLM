export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const production = env.NODE_ENV === 'production';
  const host = env.HOST || '127.0.0.1';
  if (!production && !['127.0.0.1', 'localhost', '::1'].includes(host))
    throw new Error('Public binding requires NODE_ENV=production.');
  const password = env.APP_ACCESS_PASSWORD || '';
  const publicOrigin = env.PUBLIC_ORIGIN || 'http://127.0.0.1:5173';
  const url = new URL(publicOrigin);
  if (url.origin !== publicOrigin || url.username || url.password) throw new Error('PUBLIC_ORIGIN must be an origin without path or credentials.');
  if ((production || !['127.0.0.1', 'localhost', '::1'].includes(host)) && password.length < 16)
    throw new Error('Public deployment requires APP_ACCESS_PASSWORD with at least 16 characters.');
  if (production && url.protocol !== 'https:') throw new Error('Production PUBLIC_ORIGIN must use HTTPS.');
  const number = (name: string, fallback: number, max: number) => {
    const n = Number(env[name] ?? fallback);
    if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`Invalid ${name}`);
    return n;
  };
  return { production, host, password, publicOrigin,
    port: number('PORT', 3001, 65535),
    aiEnabled: env.AI_ENABLED === 'true', apiKey: env.OPENAI_API_KEY || '',
    textModel: env.OPENAI_TEXT_MODEL || 'gpt-4.1-mini', sttModel: env.OPENAI_STT_MODEL || 'gpt-4o-mini-transcribe',
    ffprobePath: env.FFPROBE_PATH || 'ffprobe',
    timeoutMs: number('OPENAI_TIMEOUT_MS', 15000, 60000), dailyLimit: number('AI_DAILY_LIMIT', 200, 10000),
    trustProxy: env.TRUST_PROXY === '1' ? 1 : false as false | number,
  };
}
export type Config = ReturnType<typeof readConfig>;
