import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { isLlmModel } from './ai/llm/models.ts';
import { readTurn } from './turn.ts';

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
  const llmModel = env.LLM_MODEL || 'qwen35-9b';
  if (!isLlmModel(llmModel)) throw new Error('Invalid LLM_MODEL');
  const liveSpeechModel = env.SPEECH_MODEL || env.LIVE_SPEECH_MODEL || 'whisper-turbo';
  if (!['whisper-turbo', 'qwen-asr', 'cohere'].includes(liveSpeechModel)) throw new Error('Invalid SPEECH_MODEL');
  const liveConsultationEnabled = env.FEATURE_LIVE_CONSULTATION_ENABLED === 'true';
  return { home, profile, aiProvider: env.AI_PROVIDER === 'stub' ? 'stub' as const : 'local' as const,
    production, host, password, publicOrigin, provider: 'local' as const,
    liveConsultationEnabled, liveSpeechModel: liveSpeechModel as 'whisper-turbo' | 'qwen-asr' | 'cohere',
    turn: readTurn(env), coachingDirectory: path.join(home, 'data', 'coaching'),
    consultationDirectory: env.CONSULTATION_DIRECTORY || path.join(home, 'data', 'consultations'),
    liveModelDirectory: env.LIVE_MODEL_DIRECTORY || path.join(home, 'models', 'stt'),
    whisperServer: env.WHISPER_SERVER || path.join(home, 'runtime', 'whisper-cpp', 'Release', 'whisper-server.exe'),
    llamaServer: env.LLAMA_SERVER || path.join(home, 'runtime', 'llama-cpp', 'llama-server.exe'),
    transcribeNativeDir: path.join(home, 'runtime', 'transcribe-cpp', 'transcribe-native-windows-x86_64-cuda'),
    llmModel, contextSize: number('LLM_CONTEXT_SIZE', 8192, 262144),
    ffmpegPath: env.FFMPEG_PATH || 'ffmpeg', sttTimeoutMs: number('LOCAL_STT_TIMEOUT_MS', 180000, 600000),
    port: number('PORT', 3001, 65535),
    aiEnabled: env.AI_ENABLED === 'true',
    features: { ownerLog: env.FEATURE_OWNER_LOG_ENABLED === 'true', brief: env.FEATURE_BRIEF_ENABLED === 'true', shelter: env.FEATURE_SHELTER_ENABLED === 'true' },
    textModel: llmModel,
    sttModel: liveSpeechModel,
    ffprobePath: env.FFPROBE_PATH || 'ffprobe',
    lessonCatalogPath: env.LESSON_CATALOG_PATH || '',
    timeoutMs: number('LLM_TIMEOUT_MS', 300000, 1800000), dailyLimit: number('AI_DAILY_LIMIT', 200, 10000),
    trustProxy: env.TRUST_PROXY === '1' ? 1 : false as false | number,
  };
}
export type Config = ReturnType<typeof readConfig>;
