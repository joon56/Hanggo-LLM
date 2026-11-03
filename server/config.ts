import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';

/** Real environment and .env win. An empty value counts as unset so a blank .env line cannot hide a secret. */
export function loadLocalEnv(env: NodeJS.ProcessEnv = process.env, pointer = '.hanggo-home') {
  if (!env.HANGGO_HOME && existsSync(pointer)) env.HANGGO_HOME = readFileSync(pointer, 'utf8').trim();
  if (!env.HANGGO_HOME) return;
  for (const name of ['settings.env', 'secrets.env']) {
    const file = path.join(env.HANGGO_HOME, name);
    if (!existsSync(file)) continue;
    for (const [key, value] of Object.entries(parseEnv(readFileSync(file, 'utf8')))) if (!env[key] && value) env[key] = value;
  }
}

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
  const home = env.HANGGO_HOME || '.hanggo';
  const profile = env.HANGGO_PROFILE || 'local';
  if (profile !== 'local' && profile !== 'tunnel' && profile !== 'cloud') throw new Error('Invalid HANGGO_PROFILE');
  // A tunnel reaches a loopback bind from the internet, so the bind address alone proves nothing.
  if ((production || profile !== 'local' || !['127.0.0.1', 'localhost', '::1'].includes(host)) && password.length < 16)
    throw new Error('Public deployment requires APP_ACCESS_PASSWORD with at least 16 characters.');
  if (production && url.protocol !== 'https:') throw new Error('Production PUBLIC_ORIGIN must use HTTPS.');
  const number = (name: string, fallback: number, max: number) => {
    const n = Number(env[name] ?? fallback);
    if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`Invalid ${name}`);
    return n;
  };
  const ollamaTimeoutMs = number('OLLAMA_TIMEOUT_MS', 120000, 600000);
  const liveSpeechModel = env.LIVE_SPEECH_MODEL || '';
  if (!['', 'whisper-turbo', 'whisper-large', 'qwen-asr'].includes(liveSpeechModel)) throw new Error('Invalid LIVE_SPEECH_MODEL');
  const liveConsultationEnabled = env.FEATURE_LIVE_CONSULTATION_ENABLED === 'true';
  if (liveConsultationEnabled && !liveSpeechModel) throw new Error('Select LIVE_SPEECH_MODEL before enabling live consultation.');
  return { home, profile, aiProvider: env.AI_PROVIDER === 'stub' ? 'stub' as const : 'local' as const,
    production, host, password, publicOrigin, provider: 'ollama' as const,
    liveConsultationEnabled, liveSpeechModel: liveSpeechModel as '' | 'whisper-turbo' | 'whisper-large' | 'qwen-asr',
    consultationDirectory: env.CONSULTATION_DIRECTORY || path.join(home, 'data', 'consultations'),
    liveModelDirectory: env.LIVE_MODEL_DIRECTORY || path.join(home, 'models', 'stt'),
    whisperServer: env.WHISPER_SERVER || path.join(home, 'runtime', 'whisper-cpp', 'Release', 'whisper-server.exe'),
    llamaServer: env.LLAMA_SERVER || path.join(home, 'runtime', 'llama-cpp', 'llama-server.exe'),
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
