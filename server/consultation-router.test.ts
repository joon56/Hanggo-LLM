// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from './app.ts';
import { readConfig } from './config.ts';
import { createDraft } from '../src/domain/notes.ts';
import { ConsultationStore } from './consultation-store.ts';
import { consultationSections } from '../src/domain/consultation.ts';

const origin = 'http://127.0.0.1:5173';
const metadata = { petName: 'Choco', trainerName: 'Kim', sessionDate: '2026-10-07' };
const directories: string[] = [];
async function make(extra = {}, transcribe = async (_wav: Buffer, _signal?: AbortSignal) => ({ text: 'Exact source', model: 'fake', latencyMs: 1 })) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'consultation-router-')); directories.push(directory);
  const liveSpeech = { prepare: vi.fn(async () => {}), transcribe: vi.fn(transcribe), release: vi.fn(async () => {}) };
  const generate = vi.fn(async (text: string) => ({ draft: createDraft(text, 'trainer_summary_voice') }));
  const config = { ...readConfig({ AI_ENABLED: 'true', ...extra }), liveConsultationEnabled: true, consultationDirectory: directory };
  const app = createApp(config, { generate, transcribe: async () => '', liveSpeech });
  const post = (route: string, body = {}) => request(app).post(`/api/consultations${route}`).set('Origin', origin).send(body);
  const start = () => post('', { metadata, consent: true });
  const upload = (id: string, sequence = 0, startMs = 0, endMs = 5000, seconds = 5) => request(app).put(`/api/consultations/${id}/audio/${sequence}?startMs=${startMs}&endMs=${endMs}`).set('Origin', origin).set('Content-Type', 'audio/wav').send(wav(seconds));
  return { app, directory, liveSpeech, generate, post, start, upload };
}
function wav(seconds: number, amplitude = 256) { const size = Math.round(seconds * 16000) * 2; const buffer = Buffer.alloc(44 + size); buffer.write('RIFF'); buffer.writeUInt32LE(36 + size, 4); buffer.write('WAVEfmt ', 8); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(16000, 24); buffer.writeUInt32LE(32000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(size, 40); for (let offset = 44; offset < buffer.length; offset += 2) buffer.writeInt16LE(amplitude, offset); return buffer; }
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

it('requires authentication, allowed Origin, feature availability and explicit capture consent', async () => {
  const { app, start, liveSpeech } = await make({ APP_ACCESS_PASSWORD: 'test-password-123456' });
  await start().expect(401); await request(app).post('/api/consultations').send({ metadata, consent: true }).expect(403);
  const login = await request(app).post('/api/session').set('Origin', origin).send({ password: 'test-password-123456' }).expect(200);
  await request(app).post('/api/consultations').set('Origin', origin).set('Cookie', login.headers['set-cookie'][0]).send({ metadata }).expect(400);
  expect(liveSpeech.prepare).not.toHaveBeenCalled();
  const config = readConfig({ AI_ENABLED: 'true' });
  const disabled = createApp(config, { generate: async () => ({}), transcribe: async () => '' });
  await request(disabled).get('/api/consultations').expect(503);
});

it('captures ordered chunks, drains speech, persists evidence notes and invalidates approval after edit', async () => {
  const { app, directory, start, post, upload, liveSpeech } = await make(); const created = await start().expect(201); const id = created.body.id;
  await start().expect(409);
  await request(app).post('/api/notes').set('Origin', origin).send({ text: 'Other AI', sourceKind: 'trainer_summary_text', consent: true }).expect(429);
  await request(app).put(`/api/consultations/${id}/media/0`).set('Origin', origin).set('Content-Type', 'video/webm').send(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1])).expect(200);
  await upload(id).expect(202); await upload(id).expect(202);
  await post(`/${id}/bookmarks`, { atMs: 2000, text: 'Manual observation' }).expect(200);
  const finished = await post(`/${id}/finish`, { durationMs: 5000 }).expect(200);
  expect(finished.body.state).toBe('ready'); expect(finished.body.segments[0].text).toBe('Exact source');
  expect(liveSpeech.transcribe).toHaveBeenCalledOnce(); expect(liveSpeech.release).toHaveBeenCalledOnce();
  const generated = await post(`/${id}/note`).expect(200); expect(generated.body.note.coveredSegmentIds).toHaveLength(1);
  await post(`/${id}/approve`, { reviewed: true, noteRevision: generated.body.noteRevision }).expect(200);
  const edited = await request(app).patch(`/api/consultations/${id}/segments/${finished.body.segments[0].id}`).set('Origin', origin).send({ text: 'Corrected source' }).expect(200);
  expect(edited.body.note).toBeUndefined(); expect(edited.body.segments[0].originalText).toBe('Exact source');
  const exportResult = await request(app).get(`/api/consultations/${id}/export`).expect(200); expect(exportResult.body.segments[0].text).toBe('Corrected source');
  expect((await new ConsultationStore(directory).recording(id)).length).toBeGreaterThan(0);
});

it('keeps a browser-reported capture failure incomplete even when uploaded chunks are complete', async () => {
  const { app, start, upload, post } = await make(); const { body: { id } } = await start().expect(201);
  await request(app).put(`/api/consultations/${id}/media/0`).set('Origin', origin).set('Content-Type', 'video/webm').send(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1])).expect(200);
  await upload(id).expect(202);
  const finished = await post(`/${id}/finish`, { durationMs: 5000, captureError: '  Audio worklet stopped unexpectedly.  ' }).expect(200);
  expect(finished.body.state).toBe('incomplete');
  expect(finished.body.errors).toContainEqual({ code: 'CAPTURE_INTERRUPTED', message: 'Audio worklet stopped unexpectedly.' });
  const generated = await post(`/${id}/note`).expect(200);
  await post(`/${id}/approve`, { reviewed: true, noteRevision: generated.body.noteRevision }).expect(409);
});

it('checks byte-derived PCM duration, allows short tail and rejects conflicting retry times', async () => {
  const { start, upload, post } = await make(); const { body: { id } } = await start().expect(201);
  await upload(id, 1).expect(400); await upload(id, 0, 0, 4000).expect(400);
  await upload(id, 0, 0, 100, 0.1).expect(202);
  await upload(id, 0, 1, 101, 0.1).expect(409);
  await post(`/${id}/finish`, { durationMs: 3600001 }).expect(400);
  await post(`/${id}/finish`, { durationMs: 100 }).expect(200);
});

it('preserves recording and reports incomplete capture after transcription failure', async () => {
  const { start, upload, post, liveSpeech } = await make({}, async () => { throw new Error('Speech failed'); }); const { body: { id } } = await start().expect(201);
  await upload(id).expect(202); const finished = await post(`/${id}/finish`, { durationMs: 5000 }).expect(200);
  expect(finished.body.state).toBe('incomplete'); expect(finished.body.segments[0].state).toBe('failed'); expect(finished.body.errors[0].code).toBe('TRANSCRIPTION');
  expect(liveSpeech.release).toHaveBeenCalledOnce(); await post(`/${id}/approve`, { reviewed: true, noteRevision: 'missing-note' }).expect(409);
});

it('deletes active session only after aborting its work and releasing speech', async () => {
  let began!: () => void; const started = new Promise<void>(resolve => { began = resolve; });
  const { app, start, upload, liveSpeech } = await make({}, async (_wav, signal) => { began(); await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); return { text: '', model: '', latencyMs: 0 }; });
  const { body: { id } } = await start().expect(201); await upload(id).expect(202); await started;
  await request(app).delete(`/api/consultations/${id}`).set('Origin', origin).expect(204);
  expect(liveSpeech.release).toHaveBeenCalledOnce(); await request(app).get(`/api/consultations/${id}`).expect(404);
  await start().expect(201);
});

it('suppresses zero PCM hallucination while preserving quiet audible windows', async () => {
  const { app, start, post, liveSpeech } = await make(); const { body: { id } } = await start().expect(201);
  await request(app).put(`/api/consultations/${id}/audio/0?startMs=0&endMs=5000`).set('Origin', origin).set('Content-Type', 'audio/wav').send(wav(5, 0)).expect(202);
  await request(app).put(`/api/consultations/${id}/audio/1?startMs=5000&endMs=10000`).set('Origin', origin).set('Content-Type', 'audio/wav').send(wav(5, 160)).expect(202);
  const finished = await post(`/${id}/finish`, { durationMs: 10000 }).expect(200);
  expect(finished.body.segments[0]).toMatchObject({ text: '', state: 'complete', model: 'silence-filter' });
  expect(finished.body.segments[1].text).toBe('Exact source'); expect(liveSpeech.transcribe).toHaveBeenCalledOnce();
});

it('bounds queue without losing accepted audio and drains accepted work serially', async () => {
  let resolveSpeech!: () => void;
  const speechReady = new Promise<void>(resolve => { resolveSpeech = resolve; });
  const { app, start, upload, post, liveSpeech } = await make({}, async () => { await speechReady; return { text: 'Exact source', model: 'fake', latencyMs: 1 }; }); const { body: { id } } = await start().expect(201);
  await request(app).put(`/api/consultations/${id}/media/0`).set('Origin', origin).set('Content-Type', 'video/webm').send(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1])).expect(200);
  for (let index = 0; index < 12; index++) await upload(id, index, index * 5000, (index + 1) * 5000).expect(202);
  await upload(id, 12, 60000, 65000).expect(429); resolveSpeech();
  const finished = await post(`/${id}/finish`, { durationMs: 60000 }).expect(200);
  expect(finished.body.segments).toHaveLength(12); expect(liveSpeech.transcribe).toHaveBeenCalledTimes(12); expect(finished.body.state).toBe('ready');
});

it('marks missing recording chunks incomplete and re-prepares speech after a failed window', async () => {
  let attempts = 0;
  const { start, upload, post, liveSpeech } = await make({}, async () => { if (++attempts === 1) throw new Error('Timeout'); return { text: 'Recovered speech', model: 'fake', latencyMs: 1 }; }); const { body: { id } } = await start().expect(201);
  await upload(id).expect(202); await upload(id, 1, 5000, 10000).expect(202); const finished = await post(`/${id}/finish`, { durationMs: 10000 }).expect(200);
  expect(finished.body.state).toBe('incomplete'); expect(finished.body.errors.map((error: { code: string }) => error.code)).toContain('MISSING_RECORDING');
  expect(finished.body.segments[1].text).toBe('Recovered speech'); expect(liveSpeech.prepare).toHaveBeenCalledTimes(3);
});

it('allows final uploads a watchdog grace period while keeping capture timestamp bounds', async () => {
  const timeout = vi.spyOn(globalThis, 'setTimeout'); const { start, upload, post } = await make(); const { body: { id } } = await start().expect(201);
  expect(timeout.mock.calls.some(call => call[1] === 3660000)).toBe(true);
  await upload(id, 0, 3596000, 3601000).expect(400); await post(`/${id}/finish`, { durationMs: 0 }).expect(200);
});

it('rejects new uploads while deletion is stopping active transcription', async () => {
  let began!: () => void; const running = new Promise<void>(resolve => { began = resolve; });
  let aborted!: () => void; const abortion = new Promise<void>(resolve => { aborted = resolve; });
  let stopped!: () => void; const shutdown = new Promise<void>(resolve => { stopped = resolve; });
  const { app, start, upload } = await make({}, async (_wav, signal) => { began(); await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true })); aborted(); await shutdown; throw new Error('aborted'); });
  const { body: { id } } = await start().expect(201); await upload(id).expect(202); await running;
  const deletion = request(app).delete(`/api/consultations/${id}`).set('Origin', origin).then(result => result);
  await abortion;
  try { await upload(id, 1, 5000, 10000).expect(409); }
  finally { stopped(); expect((await deletion).status).toBe(204); }
});

it('retries segment registration when chunk persistence succeeded before a transient metadata failure', async () => {
  const original = ConsultationStore.prototype.putChunk; let failed = false;
  vi.spyOn(ConsultationStore.prototype, 'putChunk').mockImplementation(async function (this: ConsultationStore, id, kind, sequence, bytes, segment) {
    if (!failed && kind === 'audio') { failed = true; await original.call(this, id, kind, sequence, bytes); throw new Error('Historic manifest-only commit'); }
    return original.call(this, id, kind, sequence, bytes, segment);
  });
  const { start, upload, post, liveSpeech } = await make(); const { body: { id } } = await start().expect(201);
  await upload(id).expect(502); const retry = await upload(id).expect(202); expect(retry.body.segments).toHaveLength(1);
  await post(`/${id}/finish`, { durationMs: 5000 }).expect(200); expect(liveSpeech.transcribe).toHaveBeenCalledOnce();
});

it('validates finish duration after preceding in-flight uploads commit', async () => {
  const originalPut = ConsultationStore.prototype.putChunk; const originalGet = ConsultationStore.prototype.get;
  let paused = false; let entered!: () => void; const waiting = new Promise<void>(resolve => { entered = resolve; });
  let resume!: () => void; const gate = new Promise<void>(resolve => { resume = resolve; });
  let read!: () => void; const snapshotRead = new Promise<void>(resolve => { read = resolve; });
  vi.spyOn(ConsultationStore.prototype, 'putChunk').mockImplementation(async function (this: ConsultationStore, ...args) { if (args[1] === 'audio') { paused = true; entered(); await gate; } return originalPut.apply(this, args); });
  vi.spyOn(ConsultationStore.prototype, 'get').mockImplementation(async function (this: ConsultationStore, id) { const result = await originalGet.call(this, id); if (paused) read(); return result; });
  const { start, upload, post } = await make(); const { body: { id } } = await start().expect(201);
  const uploading = upload(id).then(result => result); await waiting;
  const finishing = post(`/${id}/finish`, { durationMs: 0 }).then(result => result); await snapshotRead; resume();
  expect((await uploading).status).toBe(202); expect((await finishing).status).toBe(400);
  await post(`/${id}/finish`, { durationMs: 5000 }).expect(200);
});

it('keeps later queue jobs running after a transient failure saving an ASR error', async () => {
  const original = ConsultationStore.prototype.update; let failed = false; let calls = 0;
  vi.spyOn(ConsultationStore.prototype, 'update').mockImplementation(async function (this: ConsultationStore, id, change) { const current = await this.get(id); change(current); if (!failed && current.errors.some(error => error.code === 'TRANSCRIPTION')) { failed = true; throw new Error('Transient error save'); } return original.call(this, id, change); });
  const { start, upload, post, liveSpeech } = await make({}, async () => { if (++calls === 1) throw new Error('ASR failed'); return { text: 'Next window', model: 'fake', latencyMs: 1 }; });
  const { body: { id } } = await start().expect(201); await upload(id).expect(202); await upload(id, 1, 5000, 10000).expect(202);
  const finished = await post(`/${id}/finish`, { durationMs: 10000 }).expect(200);
  expect(liveSpeech.transcribe).toHaveBeenCalledTimes(2); expect(finished.body.state).toBe('incomplete'); expect(finished.body.segments[0].state).toBe('failed'); expect(finished.body.segments[1].state).toBe('complete');
});

it('rejects forged note evidence and clears forged approvedAt when saving edits', async () => {
  const { app, start, upload, post } = await make(); const { body: { id } } = await start().expect(201); await upload(id).expect(202); await post(`/${id}/finish`, { durationMs: 5000 }).expect(200);
  const result = await post(`/${id}/note`).expect(200); const note = result.body.note; note.approvedAt = new Date().toISOString();
  const saved = await request(app).patch(`/api/consultations/${id}/note`).set('Origin', origin).send({ note }).expect(200); expect(saved.body.note.approvedAt).toBeUndefined();
  note.items[0].evidence[0].quote = 'Invented source'; await request(app).patch(`/api/consultations/${id}/note`).set('Origin', origin).send({ note }).expect(400);
});

it('rejects approval from another tab after note edits and same-text source regeneration', async () => {
  const { app, start, upload, post } = await make(); const { body: { id } } = await start().expect(201);
  await request(app).put(`/api/consultations/${id}/media/0`).set('Origin', origin).set('Content-Type', 'video/webm').send(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1])).expect(200);
  await upload(id).expect(202); await post(`/${id}/finish`, { durationMs: 5000 }).expect(200);
  const reviewed = (await post(`/${id}/note`).expect(200)).body;
  const editedNote = structuredClone(reviewed.note); editedNote.items[0].section = 'purpose';
  editedNote.missingSections = consultationSections.filter(section => !editedNote.items.some((item: { section: string }) => item.section === section));
  const edited = (await request(app).patch(`/api/consultations/${id}/note`).set('Origin', origin).send({ note: editedNote }).expect(200)).body;
  const stale = await post(`/${id}/approve`, { reviewed: true, noteRevision: reviewed.noteRevision ?? 'missing-revision' }).expect(409);
  expect(stale.body.code).toBe('NOTE_CHANGED'); expect(edited.noteRevision).not.toBe(reviewed.noteRevision);
  expect((await request(app).get(`/api/consultations/${id}`)).body.note.approvedAt).toBeUndefined();
  const identical = (await request(app).patch(`/api/consultations/${id}/note`).set('Origin', origin).send({ note: editedNote }).expect(200)).body;
  expect(identical.note).toEqual(edited.note); expect(identical.noteRevision).not.toBe(edited.noteRevision);
  await post(`/${id}/approve`, { reviewed: true, noteRevision: edited.noteRevision }).expect(409);
  await post(`/${id}/approve`, { reviewed: true, noteRevision: identical.noteRevision }).expect(200);
  await request(app).patch(`/api/consultations/${id}/segments/${reviewed.segments[0].id}`).set('Origin', origin).send({ text: reviewed.segments[0].text }).expect(200);
  const regenerated = (await post(`/${id}/note`).expect(200)).body;
  expect(regenerated.noteRevision).not.toBe(edited.noteRevision);
  await post(`/${id}/approve`, { reviewed: true, noteRevision: edited.noteRevision }).expect(409);
  await post(`/${id}/approve`, { reviewed: true, noteRevision: regenerated.noteRevision }).expect(200);
});

it('loads and approves legacy persisted notes with a stable source fingerprint', async () => {
  const { app, directory, start, upload, post, liveSpeech } = await make(); const { body: { id } } = await start().expect(201);
  await request(app).put(`/api/consultations/${id}/media/0`).set('Origin', origin).set('Content-Type', 'video/webm').send(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1])).expect(200);
  await upload(id).expect(202); await post(`/${id}/finish`, { durationMs: 5000 }).expect(200); await post(`/${id}/note`).expect(200);
  const filename = path.join(directory, id, 'session.json'); const stored = JSON.parse(await readFile(filename, 'utf8')); delete stored.noteRevision; await writeFile(filename, JSON.stringify(stored));
  const recovered = createApp({ ...readConfig({ AI_ENABLED: 'true' }), liveConsultationEnabled: true, consultationDirectory: directory }, { liveSpeech, generate: async () => ({}), transcribe: async () => '' });
  const reviewed = (await request(recovered).get(`/api/consultations/${id}`).expect(200)).body;
  expect(reviewed.noteRevision).toMatch(/^[0-9a-f]{64}$/); expect((await request(recovered).get(`/api/consultations/${id}`)).body.noteRevision).toBe(reviewed.noteRevision);
  await request(recovered).post(`/api/consultations/${id}/approve`).set('Origin', origin).send({ reviewed: true, noteRevision: reviewed.noteRevision }).expect(200);
});

it.each([undefined, 'Audio worklet stopped unexpectedly.'])('retries final metadata failure without releasing a newer session (captureError=%s)', async captureError => {
  const original = ConsultationStore.prototype.update; let failed = false;
  vi.spyOn(ConsultationStore.prototype, 'update').mockImplementation(async function (this: ConsultationStore, id, change) {
    const current = await this.get(id); change(current);
    if (!failed && ['ready', 'incomplete'].includes(current.state)) { failed = true; throw new Error('Transient final metadata save'); }
    return original.call(this, id, change);
  });
  const { app, start, upload, post, liveSpeech } = await make(); const { body: { id } } = await start().expect(201);
  await request(app).put(`/api/consultations/${id}/media/0`).set('Origin', origin).set('Content-Type', 'video/webm').send(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1])).expect(200);
  await upload(id).expect(202); await post(`/${id}/bookmarks`, { atMs: 2000, text: 'Retained evidence' }).expect(200);
  await post(`/${id}/finish`, { durationMs: 5000, ...(captureError ? { captureError } : {}) }).expect(502);
  expect((await request(app).get(`/api/consultations/${id}`)).body.state).toBe('processing');
  expect(liveSpeech.release).toHaveBeenCalledOnce(); const newer = (await start().expect(201)).body;
  const retried = await post(`/${id}/finish`, { durationMs: 6000 }).expect(200);
  expect(retried.body).toMatchObject({ state: captureError ? 'incomplete' : 'ready', durationMs: 5000, bookmarks: [{ text: 'Retained evidence' }], segments: [{ text: 'Exact source', state: 'complete' }] });
  expect(retried.body.errors).toEqual(captureError ? [{ code: 'CAPTURE_INTERRUPTED', message: captureError }] : []);
  expect(liveSpeech.transcribe).toHaveBeenCalledOnce(); expect(liveSpeech.release).toHaveBeenCalledOnce();
  await request(app).post('/api/notes').set('Origin', origin).send({ text: 'Other AI', sourceKind: 'trainer_summary_text', consent: true }).expect(429);
  await request(app).delete(`/api/consultations/${id}`).set('Origin', origin).expect(204);
  expect(liveSpeech.release).toHaveBeenCalledOnce(); await post(`/${newer.id}/finish`, { durationMs: 0 }).expect(200); expect(liveSpeech.release).toHaveBeenCalledTimes(2);
});

it('deleting a failed finalization preserves the newer session GPU and AI reservation', async () => {
  const original = ConsultationStore.prototype.update; let failed = false;
  vi.spyOn(ConsultationStore.prototype, 'update').mockImplementation(async function (this: ConsultationStore, id, change) {
    const current = await this.get(id); change(current);
    if (!failed && current.state === 'incomplete') { failed = true; throw new Error('Transient final metadata save'); }
    return original.call(this, id, change);
  });
  const { app, start, post, liveSpeech } = await make(); const { body: { id } } = await start().expect(201);
  await post(`/${id}/finish`, { durationMs: 0 }).expect(502); const newer = (await start().expect(201)).body;
  await request(app).delete(`/api/consultations/${id}`).set('Origin', origin).expect(204);
  expect(liveSpeech.release).toHaveBeenCalledOnce();
  await request(app).post('/api/notes').set('Origin', origin).send({ text: 'Other AI', sourceKind: 'trainer_summary_text', consent: true }).expect(429);
  await post(`/${newer.id}/finish`, { durationMs: 0 }).expect(200); expect(liveSpeech.release).toHaveBeenCalledTimes(2);
});
it('application shutdown aborts capture transcription and retains recording in terminal session',async()=>{
 let entered!:()=>void;const began=new Promise<void>(resolve=>entered=resolve);
 const f=await make({},async(_wav,signal)=>{entered();await new Promise<void>((_,reject)=>{if(signal!.aborted){reject(new Error('aborted'));return;}signal!.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});});throw new Error('unreachable');});
 const session=(await f.start().expect(201)).body;const bytes=Buffer.from([0x1a,0x45,0xdf,0xa3,1]);
 await request(f.app).put(`/api/consultations/${session.id}/media/0`).set('Origin',origin).set('Content-Type','video/webm').send(bytes).expect(200);
 await f.upload(session.id).expect(202);await began;await f.app.shutdown();
 const stored=await new ConsultationStore(f.directory).get(session.id);expect(stored.state).toBe('incomplete');expect(stored.errors.some(error=>error.code==='CAPTURE_INTERRUPTED')).toBe(true);
 expect(await new ConsultationStore(f.directory).recording(session.id)).toEqual(bytes);expect(f.liveSpeech.release).toHaveBeenCalledOnce();
});
