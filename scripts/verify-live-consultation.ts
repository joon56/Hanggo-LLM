import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createApp } from '../server/app.ts';
import { readConfig } from '../server/config.ts';
import { createAIServices } from '../server/providers.ts';
import type { ConsultationSession } from '../src/domain/consultation.ts';

// Accelerated 60-minute fixture, real disk/API/FFmpeg/GPU/LLM. Not a wall-clock browser capture test.
// Requires .tmp/speech-samples/{01,03,04}.wav (the documented synthetic comparison clips).
const root = resolve('.tmp/live-validation'); await mkdir(root, { recursive: true });
const config = readConfig({ ...process.env, AI_ENABLED: 'true', FEATURE_LIVE_CONSULTATION_ENABLED: 'true', LIVE_SPEECH_MODEL: 'whisper-turbo',
  CONSULTATION_DIRECTORY: `${root}/sessions`, AI_DAILY_LIMIT: '10000' });
const services = createAIServices(config);
const app = createApp(config, services);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>(done => server.once('listening', done));
const address = server.address() as { port: number }; const base = `http://127.0.0.1:${address.port}`;
const headers = { Origin: config.publicOrigin };
let cookie = '';
async function request(path: string, init?: RequestInit) {
  const response = await fetch(`${base}${path}`, { ...init, headers: { ...headers, Cookie: cookie, ...init?.headers } });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response;
}
const json = (value: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
function wav(pcm: Buffer) {
  const result = Buffer.alloc(44 + pcm.length); result.write('RIFF'); result.writeUInt32LE(result.length - 8, 4); result.write('WAVEfmt ', 8);
  result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20); result.writeUInt16LE(1, 22); result.writeUInt32LE(16000, 24);
  result.writeUInt32LE(32000, 28); result.writeUInt16LE(2, 32); result.writeUInt16LE(16, 34); result.write('data', 36); result.writeUInt32LE(pcm.length, 40); pcm.copy(result, 44); return result;
}
const started = performance.now();
try {
  if (config.password) { const response = await request('/api/session', json({ password: config.password })); cookie = response.headers.get('set-cookie')?.split(';')[0] || ''; }
  const fixturePath = `${root}/hour.webm`;
  const inputs = ['01', '03', '04'].map(value => resolve(`.tmp/speech-samples/${value}.wav`));
  execFileSync(config.ffmpegPath, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=black:s=160x90:r=1', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono',
    ...inputs.flatMap(file => ['-i', file]), '-filter_complex', '[2:a]adelay=0[a];[3:a]adelay=1800000[b];[4:a]adelay=3590000[c];[1:a][a][b][c]amix=inputs=4:duration=first:normalize=0[out]',
    '-map', '0:v', '-map', '[out]', '-t', '3600', '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-b:a', '16k', fixturePath], { windowsHide: true, timeout: 180000 });
  const media = await readFile(fixturePath);
  const voice = new Map<number, Buffer>();
  for (const [index, sequence] of [0, 180, 359].entries()) {
    const pcm = execFileSync(config.ffmpegPath, ['-v', 'error', '-i', inputs[index], '-af', 'apad', '-t', '10', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'], { windowsHide: true, maxBuffer: 1024 * 1024 });
    voice.set(sequence, wav(pcm));
  }
  const silence = wav(Buffer.alloc(320000));
  const session = await (await request('/api/consultations', json({ metadata: { petName: '합성검증', trainerName: '검증', sessionDate: new Date().toISOString().slice(0, 10) }, consent: true }))).json() as ConsultationSession;
  console.info(`Validation session: ${session.id}`);
  let mediaSequence = 0;
  for (let offset = 0; offset < media.length; offset += 512 * 1024) {
    await request(`/api/consultations/${session.id}/media/${mediaSequence++}`, { method: 'PUT', headers: { 'Content-Type': 'video/webm' }, body: media.subarray(offset, offset + 512 * 1024) });
  }
  for (let sequence = 0; sequence < 360; sequence++) {
    const path = `/api/consultations/${session.id}/audio/${sequence}?startMs=${sequence * 10000}&endMs=${(sequence + 1) * 10000}`;
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(`${base}${path}`, { method: 'PUT', headers: { ...headers, Cookie: cookie, 'Content-Type': 'audio/wav' }, body: new Uint8Array(voice.get(sequence) ?? silence) });
      if (response.ok) { await response.body?.cancel(); break; }
      if (response.status !== 429 || attempt >= 90) throw new Error(`${path}: ${response.status} ${await response.text()}`);
      await response.body?.cancel(); await new Promise(done => setTimeout(done, 1000));
    }
    if (sequence % 60 === 59) console.info(`Stored ${(sequence + 1) * 10 / 60} minutes of fixture audio.`);
  }
  await request(`/api/consultations/${session.id}/bookmarks`, json({ atMs: 1800000, text: '합성 검증: 중간 발언 확인' }));
  const finished = await (await request(`/api/consultations/${session.id}/finish`, json({ durationMs: 3600000 }))).json() as ConsultationSession;
  if (finished.state !== 'ready' || finished.segments.length !== 360 || finished.errors.length) throw new Error(`Incomplete validation capture: ${JSON.stringify(finished.errors)}`);
  const note = await (await request(`/api/consultations/${session.id}/note`, json({}))).json() as ConsultationSession;
  for (const sequence of [0, 180, 359]) {
    const segment = note.segments.find(item => item.sequence === sequence)!;
    if (!segment.text || !note.note?.coveredSegmentIds.includes(segment.id)) throw new Error(`Missing source coverage at sequence ${sequence}.`);
  }
  const range = await request(`/api/consultations/${session.id}/recording`, { headers: { Range: 'bytes=0-127' } });
  if (range.status !== 206 || (await range.arrayBuffer()).byteLength !== 128) throw new Error('Recording range failed.');
  const approved = await (await request(`/api/consultations/${session.id}/approve`, json({ reviewed: true, noteRevision: note.noteRevision }))).json() as ConsultationSession;
  const report = { createdAt: new Date().toISOString(), testKind: 'accelerated-60-minute-fixture', realTimeCaptureTest: false,
    elapsedMs: Math.round(performance.now() - started), model: config.liveSpeechModel, sessionId: session.id,
    audioSegments: approved.segments.length, durationMs: approved.durationMs, recordingBytes: media.length,
    state: approved.state, voicedSegments: approved.segments.filter(s => s.text).map(s => ({ sequence: s.sequence, text: s.text, latencyMs: s.latencyMs })),
    noteItems: approved.note?.items.length, noteFallback: approved.note?.fallbackUsed, approved: !!approved.note?.approvedAt, rangePlayback: true };
  await writeFile(`${root}/report.json`, JSON.stringify(report, null, 2)); console.info(JSON.stringify(report));
} finally { await services.liveSpeech.release(); await new Promise<void>(done => server.close(() => done())); }
