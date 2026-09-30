// @vitest-environment node
import { expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from './app.ts';
import { readConfig } from './config.ts';

const origin = 'http://127.0.0.1:5173';
const make = (extra = {}) => {
  const config = readConfig({ AI_ENABLED: 'true', ...extra });
  const generate = vi.fn(async () => ({ draft: {}, fallbackUsed: false }));
  const transcribe = vi.fn(async () => '오늘 앉아를 관찰했습니다.');
  return { app: createApp(config, { generate, transcribe, status: async () => ({ configured: true, sttReady: true, statusMessage: 'Ready' }) }), generate, transcribe };
};
it('allows local text generation without any external API key', async () => {
  const { app, generate } = make();
  const session = await request(app).get('/api/session').expect(200);
  expect(session.body).toMatchObject({ provider: 'ollama', configured: true });
  await request(app).post('/api/notes').set('Origin', origin).send({ text: '관찰했습니다.', sourceKind: 'trainer_summary_text', consent: true }).expect(200);
  expect(generate).toHaveBeenCalledOnce();
});
it('reports actual local readiness instead of treating configuration as connectivity', async () => {
  const config = readConfig({ AI_ENABLED: 'true' });
  const app = createApp(config, { generate: async () => ({}), transcribe: async () => '', status: async () => ({ configured: false, sttReady: false, statusMessage: 'Ollama를 실행해 주세요.' }) });
  const session = await request(app).get('/api/session').expect(200);
  expect(session.body).toMatchObject({ configured: false, sttReady: false, statusMessage: 'Ollama를 실행해 주세요.' });
});
it('requires explicit consent and valid bounded source before contacting the local model', async () => {
  const { app, generate } = make();
  await request(app).post('/api/notes').set('Origin', origin).send({ text: '관찰했습니다.', sourceKind: 'trainer_summary_text' }).expect(400);
  await request(app).post('/api/notes').set('Origin', origin).send({ text: '가'.repeat(8001), sourceKind: 'trainer_summary_text', consent: true }).expect(400);
  expect(generate).not.toHaveBeenCalled();
});
it('rejects cross-origin and missing-origin browser mutations', async () => {
  const { app } = make();
  await request(app).post('/api/notes').set('Origin', 'https://evil.example').send({}).expect(403);
  await request(app).post('/api/session').send({}).expect(403);
});
it('does not report credentials and rejects disabled AI', async () => {
  const { app } = make({ AI_ENABLED: 'false' });
  const status = await request(app).get('/api/session').expect(200);
  expect(status.body).not.toHaveProperty('apiKey');
  expect(status.body.aiEnabled).toBe(false);
  await request(app).post('/api/notes').set('Origin', origin).send({ text: '관찰', sourceKind: 'trainer_summary_text', consent: true }).expect(503);
});
it('uses an expiring HttpOnly session and invalidates it on logout', async () => {
  const { app, generate } = make({ APP_ACCESS_PASSWORD: 'test-password-123456' });
  const body = { text: '관찰했습니다.', sourceKind: 'trainer_summary_text', consent: true };
  await request(app).post('/api/notes').set('Origin', origin).send(body).expect(401);
  await request(app).post('/api/session').set('Origin', origin).send({ password: 'wrong' }).expect(401);
  const login = await request(app).post('/api/session').set('Origin', origin).send({ password: 'test-password-123456' }).expect(200);
  const cookie = login.headers['set-cookie'][0];
  expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('SameSite=Strict');
  await request(app).post('/api/notes').set('Origin', origin).set('Cookie', cookie).send(body).expect(200);
  expect(generate).toHaveBeenCalledTimes(1);
  const logout = await request(app).delete('/api/session').set('Origin', origin).set('Cookie', cookie).expect(200);
  expect(logout.body).toMatchObject({ authenticated: false, requirePassword: true });
  await request(app).post('/api/notes').set('Origin', origin).set('Cookie', cookie).send(body).expect(401);
});

function wav(seconds: number) {
  const rate = 8000; const size = Math.round(seconds * rate) * 2;
  const buffer = Buffer.alloc(44 + size);
  buffer.write('RIFF'); buffer.writeUInt32LE(36 + size, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(size, 40);
  return buffer;
}

it.each([2.9, 60.51, 61])('rejects actual %s second audio despite a valid declared duration', async seconds => {
  const { app, transcribe } = make();
  await request(app).post('/api/transcribe').set('Origin', origin)
    .field('consent', 'true').field('duration', '4')
    .attach('audio', wav(seconds), { filename: 'audio.wav', contentType: 'audio/wav' }).expect(400);
  expect(transcribe).not.toHaveBeenCalled();
});

it.each([3, 60, 60.5])('accepts the %s second boundary including bounded encoder padding', async seconds => {
  const { app, transcribe } = make();
  await request(app).post('/api/transcribe').set('Origin', origin)
    .field('consent', 'true').field('duration', String(Math.min(seconds, 60)))
    .attach('audio', wav(seconds), { filename: 'audio.wav', contentType: 'audio/wav' }).expect(200);
  expect(transcribe).toHaveBeenCalledOnce();
});

it('accepts a real four-second WAV and wipes its buffer after transcription', async () => {
  const config = readConfig({ AI_ENABLED: 'true', });
  let uploaded: Buffer | undefined;
  const transcribe = vi.fn(async (buffer: Buffer) => { uploaded = buffer; return '관찰했습니다.'; });
  const app = createApp(config, { generate: async () => ({}), transcribe });
  await request(app).post('/api/transcribe').set('Origin', origin)
    .field('consent', 'true').field('duration', '4')
    .attach('audio', wav(4), { filename: 'audio.wav', contentType: 'audio/wav' }).expect(200);
  expect(transcribe).toHaveBeenCalledOnce();
  expect(uploaded?.every(value => value === 0)).toBe(true);
});

it('rejects corrupt audio even when its container signature looks valid', async () => {
  const { app, transcribe } = make();
  const buffer = Buffer.alloc(32); buffer.write('RIFF'); buffer.write('WAVE', 8);
  await request(app).post('/api/transcribe').set('Origin', origin)
    .field('consent', 'true').field('duration', '4')
    .attach('audio', buffer, { filename: 'audio.wav', contentType: 'audio/wav' }).expect(400);
  expect(transcribe).not.toHaveBeenCalled();
});
it('rejects fake audio and too short audio before transcription', async () => {
  const { app, transcribe } = make();
  await request(app).post('/api/transcribe').set('Origin', origin).field('consent', 'true').field('duration', '4').attach('audio', Buffer.from('not audio'), { filename: 'test.webm', contentType: 'audio/webm' }).expect(400);
  await request(app).post('/api/transcribe').set('Origin', origin).field('consent', 'true').field('duration', '2').attach('audio', Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2]), { filename: 'test.webm', contentType: 'audio/webm' }).expect(400);
  expect(transcribe).not.toHaveBeenCalled();
});
it('limits daily AI requests across clients', async () => {
  const { app, generate } = make({ AI_DAILY_LIMIT: '1' });
  const body = { text: '관찰', sourceKind: 'trainer_summary_text', consent: true };
  await request(app).post('/api/notes').set('Origin', origin).send(body).expect(200);
  await request(app).post('/api/notes').set('Origin', origin).send(body).expect(429);
  expect(generate).toHaveBeenCalledTimes(1);
});
it('rejects unsafe production startup configuration', () => {
  expect(() => readConfig({ NODE_ENV: 'production' })).toThrow();
  expect(() => readConfig({ HOST: '0.0.0.0' })).toThrow();
  expect(() => readConfig({ HOST: '0.0.0.0', APP_ACCESS_PASSWORD: 'long-password-123456', PUBLIC_ORIGIN: 'http://notes.example.com' })).toThrow();
  expect(() => readConfig({ NODE_ENV: 'production', APP_ACCESS_PASSWORD: 'long-password-123456', PUBLIC_ORIGIN: 'http://example.com' })).toThrow();
  expect(readConfig({ NODE_ENV: 'production', APP_ACCESS_PASSWORD: 'long-password-123456', PUBLIC_ORIGIN: 'https://notes.example.com' }).production).toBe(true);
});

it('defaults new features off and guards their routes before generation', async () => {
  const { app } = make();
  const status = await request(app).get('/api/session').expect(200);
  expect(status.body.features).toEqual({ ownerLog: false, brief: false, shelter: false });
  for (const route of ['owner-logs', 'briefs', 'shelter-profiles', 'owner-logs/', 'OWNER-LOGS', 'BRIEFS/', 'SHELTER-PROFILES/']) {
    const result = await request(app).post(`/api/${route}`).set('Origin', origin).send({ input: {}, consent: true }).expect(503);
    expect(result.body.code).toBe('FEATURE_DISABLED');
  }
});

it('requires consent and valid feature input, and shares the global AI quota', async () => {
  const config = readConfig({ AI_ENABLED: 'true', FEATURE_OWNER_LOG_ENABLED: 'true', FEATURE_BRIEF_ENABLED: 'true', FEATURE_SHELTER_ENABLED: 'true', AI_DAILY_LIMIT: '5' });
  const generateOwner = vi.fn(async (_input: unknown) => ({ draft: {}, fallbackUsed: false }));
  const app = createApp(config, { generate: async () => ({}), transcribe: async () => '', generateOwner });
  const input = { text: '초코가 짖었어요.', pets: [{ id: 'choco', name: '초코', nicknames: [] }], now: '2026-09-30T10:00:00+09:00', timeZone: 'Asia/Seoul', sourceKind: 'nl_log_text' };
  await request(app).post('/api/owner-logs').set('Origin', origin).send({ input }).expect(400);
  await request(app).post('/api/owner-logs').set('Origin', origin).send({ input: { ...input, timeZone: 'invalid-zone' }, consent: true }).expect(400);
  await request(app).post('/api/briefs').set('Origin', origin).send({ input: {}, consent: true }).expect(400);
  await request(app).post('/api/shelter-profiles').set('Origin', origin).send({ input: {}, consent: true }).expect(400);
  await request(app).post('/api/owner-logs').set('Origin', origin).send({ input, consent: true }).expect(200);
  await request(app).post('/api/notes').set('Origin', origin).send({ text: '관찰했습니다.', sourceKind: 'trainer_summary_text', consent: true }).expect(429);
  expect(generateOwner).toHaveBeenCalledOnce();
  expect(generateOwner.mock.calls[0][0]).toEqual(input);
});
