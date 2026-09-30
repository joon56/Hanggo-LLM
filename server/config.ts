import path from 'node:path';

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const ollamaUrl = new URL(env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434');
  if (ollamaUrl.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(ollamaUrl.hostname) || ollamaUrl.username || ollamaUrl.password || ollamaUrl.pathname !== '/' || ollamaUrl.search || ollamaUrl.hash)
    throw new Error('OLLAMA_BASE_URL must be a loopback HTTP origin (127.0.0.1 or [::1]).');
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
  const ollamaTimeoutMs = number('OLLAMA_TIMEOUT_MS', 120000, 600000);
  return { production, host, password, publicOrigin, provider: 'ollama' as const,
    ollamaBaseUrl: ollamaUrl.origin, ollamaContextSize: number('OLLAMA_CONTEXT_SIZE', 8192, 32768),
    whisperExecutable: env.WHISPER_EXECUTABLE || '.local-ai/whisper/whisper-cli.exe',
    whisperModelPath: env.WHISPER_MODEL_PATH || '.local-ai/models/ggml-medium-q5_0.bin',
    ffmpegPath: env.FFMPEG_PATH || 'ffmpeg', sttTimeoutMs: number('LOCAL_STT_TIMEOUT_MS', 180000, 600000),
    port: number('PORT', 3001, 65535),
    aiEnabled: env.AI_ENABLED === 'true',
    features: { ownerLog: env.FEATURE_OWNER_LOG_ENABLED === 'true', brief: env.FEATURE_BRIEF_ENABLED === 'true', shelter: env.FEATURE_SHELTER_ENABLED === 'true' },
    textModel: env.OLLAMA_MODEL || 'qwen3.5:9b',
    sttModel: `${path.basename(env.WHISPER_MODEL_PATH || 'ggml-medium-q5_0.bin')} (CPU)`,
    ffprobePath: env.FFPROBE_PATH || 'ffprobe',
    lessonCatalogPath: env.LESSON_CATALOG_PATH || '',
    timeoutMs: ollamaTimeoutMs, dailyLimit: number('AI_DAILY_LIMIT', 200, 10000),
    trustProxy: env.TRUST_PROXY === '1' ? 1 : false as false | number,
  };
}
export type Config = ReturnType<typeof readConfig>;
