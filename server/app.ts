import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { ErrorRequestHandler, Request } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { z } from 'zod';
import type { Config } from './config.ts';
import type { SourceKind } from '../src/domain/notes.ts';
import { AudioValidationError, validateAudioDuration } from './audio.ts';

type Services = {
  generate: (text: string, sourceKind: SourceKind, signal?: AbortSignal) => Promise<unknown>;
  transcribe: (buffer: Buffer, filename: string, petName: string, signal?: AbortSignal) => Promise<string>;
};
const NoteInput = z.object({ text: z.string().min(1).max(8000).refine(value => !!value.trim()),
  sourceKind: z.enum(['trainer_summary_text', 'trainer_summary_voice']), consent: z.literal(true) }).strict();
const AudioInput = z.object({ duration: z.coerce.number().min(3).max(60), petName: z.string().max(40).default(''), consent: z.literal('true') }).strict();

export function createApp(config: Config, services: Services) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(helmet({ contentSecurityPolicy: { directives: { 'media-src': ["'self'", 'blob:'], 'connect-src': ["'self'"], 'upgrade-insecure-requests': config.production ? [] : null } }, strictTransportSecurity: config.production ? undefined : false }));
  const sessions = new Map<string, number>();
  const cookieName = 'hanggo_session';
  const cookieOptions = { httpOnly: true, secure: config.production, sameSite: 'strict' as const, path: '/api', maxAge: 8 * 60 * 60 * 1000 };
  const token = (req: Request) => req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1) || '';
  const authenticated = (req: Request) => !config.password || (sessions.get(token(req)) || 0) > Date.now();
  const origins = new Set([config.publicOrigin, ...(!config.production ? ['http://127.0.0.1:5173', `http://127.0.0.1:${config.port}`, 'http://localhost:5173'] : [])]);
  const hosts = new Set([...origins].map(origin => new URL(origin).hostname));
  hosts.add('127.0.0.1'); hosts.add('localhost');
  app.use((req, res, next) => {
    if (!hosts.has(req.hostname)) { res.status(403).json({ error: '허용하지 않는 접속 주소입니다.', code: 'HOST' }); return; }
    next();
  });
  app.use('/api', (req, res, next) => {
    res.locals.requestId = randomUUID();
    res.set('Cache-Control', 'no-store');
    res.set('X-Request-Id', res.locals.requestId);
    if (!['GET', 'HEAD'].includes(req.method) && (!req.headers.origin || !origins.has(req.headers.origin))) {
      res.status(403).json({ error: '허용된 앱 화면에서 다시 요청해 주세요.', code: 'ORIGIN', requestId: res.locals.requestId }); return;
    }
    next();
  });
  app.use('/api', express.json({ limit: '64kb' }));
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  const sessionInfo = (req: Request) => ({ authenticated: authenticated(req), requirePassword: !!config.password,
    aiEnabled: config.aiEnabled, configured: !!config.apiKey, textModel: config.textModel, sttModel: config.sttModel });
  app.get('/api/session', (req, res) => res.json(sessionInfo(req)));
  const loginLimit = rateLimit({ windowMs: 60_000, limit: 10, keyGenerator: () => 'login', standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: '잠시 후 다시 로그인해 주세요.', code: 'RATE_LIMIT' } });
  app.post('/api/session', loginLimit, (req, res) => {
    const supplied = typeof req.body?.password === 'string' && req.body.password.length <= 256 ? req.body.password : '';
    const hash = (value: string) => createHash('sha256').update(value).digest();
    if (config.password && !timingSafeEqual(hash(supplied), hash(config.password))) {
      res.status(401).json({ error: '접근 비밀번호를 확인해 주세요.', code: 'AUTH', requestId: res.locals.requestId }); return;
    }
    for (const [key, expires] of sessions) if (expires <= Date.now()) sessions.delete(key);
    if (sessions.size >= 100) sessions.delete(sessions.keys().next().value!);
    const value = randomBytes(32).toString('hex');
    sessions.set(value, Date.now() + cookieOptions.maxAge);
    res.cookie(cookieName, value, cookieOptions).json({ ...sessionInfo(req), authenticated: true });
  });
  app.delete('/api/session', (req, res) => { sessions.delete(token(req)); res.clearCookie(cookieName, cookieOptions).json(sessionInfo(req)); });
  app.use('/api', (req, res, next) => {
    if (!authenticated(req)) { res.status(401).json({ error: '로그인이 필요합니다.', code: 'AUTH', requestId: res.locals.requestId }); return; }
    next();
  });
  const aiLimit = rateLimit({ windowMs: 60_000, limit: 30, keyGenerator: () => 'ai', standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: '요청이 많습니다. 잠시 후 다시 시도해 주세요.', code: 'RATE_LIMIT' } });
  let day = ''; let calls = 0; let active = 0;
  app.use(['/api/notes', '/api/transcribe'], aiLimit, (_req, res, next) => {
    if (!config.aiEnabled || !config.apiKey) { res.status(503).json({ error: '서버에서 AI 기능과 API 키를 설정해 주세요. 로컬 규칙 모드는 계속 사용할 수 있습니다.', code: 'AI_DISABLED', requestId: res.locals.requestId }); return; }
    const today = new Date().toISOString().slice(0, 10);
    if (today !== day) { day = today; calls = 0; }
    if (calls >= config.dailyLimit || active >= 2) { res.status(429).json({ error: 'AI 사용 한도에 도달했습니다. 잠시 후 또는 다음 날 다시 시도해 주세요.', code: 'AI_LIMIT', requestId: res.locals.requestId }); return; }
    calls++; active++;
    let released = false;
    const release = () => { if (!released) { released = true; active--; } };
    res.once('finish', release); res.once('close', release);
    next();
  });
  const withSignal = (res: express.Response) => {
    const controller = new AbortController();
    res.once('close', () => { if (!res.writableEnded) controller.abort(); });
    return controller.signal;
  };
  app.post('/api/notes', async (req, res) => {
    const input = NoteInput.safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: '원문은 1~8,000자이며 외부 AI 처리 동의가 필요합니다.', code: 'INPUT', requestId: res.locals.requestId }); return; }
    res.json(await services.generate(input.data.text, input.data.sourceKind, withSignal(res)));
  });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 3, fieldSize: 200, parts: 4 } });
  app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
    const input = AudioInput.safeParse(req.body);
    const file = req.file;
    // Never trust a client-provided filename for filesystem paths or content identification.
    const buffer = file?.buffer;
    const ext = buffer && buffer.length >= 12 ? (
      buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) ? 'webm' :
      buffer.toString('ascii', 4, 8) === 'ftyp' ? 'mp4' :
      buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE' ? 'wav' :
      buffer.toString('ascii', 0, 3) === 'ID3' || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) ? 'mp3' : null) : null;
    if (!input.success || !buffer || !ext) { res.status(400).json({ error: '동의한 3~60초 녹음 파일을 확인해 주세요. WebM, MP4, WAV, MP3를 지원합니다.', code: 'AUDIO_INPUT', requestId: res.locals.requestId }); return; }
    const started = Date.now();
    try {
      const signal = withSignal(res);
      await validateAudioDuration(buffer, config.ffprobePath, signal);
      const text = (await services.transcribe(buffer, `recording.${ext}`, input.data.petName, signal)).trim();
      if (!text || text.length > 8000) { res.status(422).json({ error: '받아쓰기를 확인할 수 없습니다. 다시 녹음하거나 직접 입력해 주세요.', code: 'EMPTY_TRANSCRIPT', requestId: res.locals.requestId }); return; }
      res.json({ text, requestId: res.locals.requestId, latencyMs: Date.now() - started, model: config.sttModel });
    } catch (error) {
      if (!(error instanceof AudioValidationError)) throw error;
      if (!res.destroyed) res.status(400).json({ error: error.message, code: 'AUDIO_INPUT', requestId: res.locals.requestId });
    } finally { buffer.fill(0); }
  });
  app.use('/api', (_req, res) => { res.status(404).json({ error: '요청한 기능이 없습니다.', code: 'NOT_FOUND', requestId: res.locals.requestId }); });
  const dist = path.resolve('dist');
  if (existsSync(path.join(dist, 'index.html'))) {
    app.use(express.static(dist, { index: false, dotfiles: 'deny', setHeaders: (res, file) => res.setHeader('Cache-Control', file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache') }));
    app.get('/', (_req, res) => { res.set('Cache-Control', 'no-cache').sendFile(path.join(dist, 'index.html')); });
  }
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (res.headersSent || res.destroyed) return;
    const large = error?.code === 'LIMIT_FILE_SIZE' || error?.type === 'entity.too.large';
    const malformed = error instanceof multer.MulterError || error?.type === 'entity.parse.failed';
    res.status(large ? 413 : malformed ? 400 : 502).json({ error: large ? '파일은 10MB 이하, 텍스트는 8,000자 이하로 입력해 주세요.' : malformed ? '요청 형식을 확인해 주세요.' : 'AI 요청을 완료하지 못했습니다. 입력은 유지됩니다. 잠시 후 다시 시도해 주세요.', code: large ? 'TOO_LARGE' : malformed ? 'INPUT' : 'UPSTREAM', requestId: res.locals.requestId });
  };
  app.use(errors);
  return app;
}
