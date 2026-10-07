import { mkdir, writeFile, readFile, lstat, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { visionSceneTimes, visionFrameTimes, visionObservationsSchema, VISION_INTERVAL_MS } from '../src/domain/consultation-vision.ts';
import type { VisionService } from './consultation-vision.ts';
import { MAX_FRAME_BYTES } from './consultation-vision.ts';
import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { validateConsultationNote } from '../src/domain/consultation.ts';
import type { ConsultationSession, ConsultationNote } from '../src/domain/consultation.ts';
import type { SourceKind } from '../src/domain/notes.ts';
import type { LiveSpeechService } from './live-speech.ts';
import { ConsultationError, ConsultationStore, consultationNoteRevision, MAX_SESSION_MS, MAX_SESSION_BYTES } from './consultation-store.ts';
import { generateConsultationNote } from './consultation-notes.ts';
import { recordingHandler } from './consultation-media.ts';
import { briefConsultationChoice, resolveBriefConsultation } from './brief-consultation.ts';

type Options = { vision?: VisionService; enabled: boolean; directory: string; ffmpegPath?: string; speech?: LiveSpeechService; generate: (text: string, sourceKind: SourceKind, signal?: AbortSignal) => Promise<unknown>; acquireAi: (charge: boolean) => () => void };
const integerTime = z.number().int().min(0).max(MAX_SESSION_MS);
const metadataSchema = z.object({ petName: z.string().trim().min(1).max(200), trainerName: z.string().trim().min(1).max(200), sessionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => { const date = new Date(`${value}T00:00:00Z`); return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value; }) }).strict();
function parse<T>(schema: z.ZodType<T>, value: unknown): T { const result = schema.safeParse(value); if (!result.success) throw new ConsultationError('INPUT', 'Check request fields.'); return result.data; }
function sequence(value: string): number { if (!/^\d{1,4}$/.test(value)) throw new ConsultationError('SEQUENCE', 'Invalid chunk sequence.'); return Number(value); }
function validateWav(bytes: Buffer, startMs: number, endMs: number) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.readUInt32LE(4) + 8 !== bytes.length) throw new ConsultationError('AUDIO_INPUT', 'Upload standalone PCM WAV.');
  let offset = 12; let pcm = false; let dataBytes = 0; let audible = false;
  while (offset + 8 <= bytes.length) {
    const kind = bytes.toString('ascii', offset, offset + 4); const size = bytes.readUInt32LE(offset + 4); const at = offset + 8;
    if (at + size > bytes.length) throw new ConsultationError('AUDIO_INPUT', 'Truncated WAV chunk.');
    if (kind === 'fmt ') pcm = size >= 16 && bytes.readUInt16LE(at) === 1 && bytes.readUInt16LE(at + 2) === 1 && bytes.readUInt32LE(at + 4) === 16000 && bytes.readUInt32LE(at + 8) === 32000 && bytes.readUInt16LE(at + 12) === 2 && bytes.readUInt16LE(at + 14) === 16;
    if (kind === 'data') {
      dataBytes += size;
      if (size % 2) throw new ConsultationError('AUDIO_INPUT', 'Invalid PCM sample data.');
      // Any audible 100ms window preserves the whole clip, including quiet speech.
      for (let window = at; window < at + size; window += 3200) {
        const end = Math.min(window + 3200, at + size); let squares = 0;
        for (let sample = window; sample < end; sample += 2) squares += (bytes.readInt16LE(sample) / 32768) ** 2;
        if (Math.sqrt(squares / ((end - window) / 2)) >= 0.003) audible = true;
      }
    }
    offset = at + size + (size % 2);
  }
  const durationMs = dataBytes / 32;
  if (!pcm || !dataBytes || dataBytes % 2 || durationMs > 15000 || Math.abs(durationMs - (endMs - startMs)) > 2) throw new ConsultationError('AUDIO_INPUT', 'WAV must be mono 16kHz PCM with matching timestamps and at most 15 seconds.');
  return !audible;
}

export function createConsultationRouter(options: Options) {
  const router = express.Router(); const store = new ConsultationStore(options.directory);
  let stopping = false; let shutdownTask: Promise<void> | undefined;
  let activeId: string | undefined; let preparing = false; let mutationTail: Promise<unknown> = Promise.resolve();
  type Capture = { controller: AbortController; tail: Promise<void>; pending: number; release: () => void; released?: boolean; timer?: NodeJS.Timeout; closing?: Promise<ConsultationSession>; finalization?: { durationMs: number; expired: boolean; captureError?: string }; storageErrors: { code: string; message: string; sequence?: number }[] };
  const work = new Map<string, Capture>();
  const noteWork = new Map<string, { controller: AbortController; task: Promise<ConsultationSession> }>();
  const visionWork = new Map<string, { controller: AbortController; task: Promise<void> }>();
  const deleting = new Set<string>();
  const busy = () => preparing || !!activeId || noteWork.size > 0 || visionWork.size > 0;
  const lock = <T>(operation: () => Promise<T>): Promise<T> => { const result = mutationTail.then(operation); mutationTail = result.catch(() => {}); return result; };
  const currentCapture = async (id: string) => { const session = await store.get(id); if (deleting.has(id) || activeId !== id || session.state !== 'recording') throw new ConsultationError('STATE', 'Session is not capturing.', 409); return session; };
  async function releaseCapture(id: string, capture: Capture) {
    if (capture.released) return;
    capture.released = true;
    try { await options.speech!.release(); } finally { capture.release(); if (activeId === id) activeId = undefined; }
  }
  async function closeCapture(id: string, durationMs: number, expired = false, captureError?: string): Promise<ConsultationSession> {
    const capture = work.get(id); if (!capture) return store.get(id);
    const { task } = await lock(async () => {
      if (capture.closing) return { task: capture.closing };
      if (!capture.finalization) {
        await store.update(id, session => { if (durationMs < Math.max(0, ...session.segments.map(segment => segment.endMs), ...session.bookmarks.map(bookmark => bookmark.atMs))) throw new ConsultationError('INPUT', 'Capture duration is shorter than accepted evidence.'); session.state = 'processing'; session.durationMs = durationMs; });
        capture.finalization = { durationMs, expired, captureError };
      }
      const finalization = capture.finalization;
      clearTimeout(capture.timer);
      capture.closing = (async () => {
      try { await capture.tail; } catch { capture.storageErrors.push({ code: 'STORAGE', message: 'Transcription queue storage failed.' }); }
      finally { await releaseCapture(id, capture); }
      const finished = await store.update(id, session => {
        session.errors.push(...capture.storageErrors);
        if (finalization.captureError) session.errors.push({ code: 'CAPTURE_INTERRUPTED', message: finalization.captureError });
        session.segments.forEach(segment => { if (segment.state === 'queued' || segment.state === 'processing') { segment.state = 'failed'; session.errors.push({ code: 'STORAGE', message: 'Accepted transcript window could not be completed.', sequence: segment.sequence }); } });
        let end = 0; let gap = false;
        for (const segment of session.segments) { if (segment.startMs > end + 2) gap = true; end = Math.max(end, segment.endMs); }
        if (end < finalization.durationMs - 2 || gap) session.errors.push({ code: 'MISSING_AUDIO', message: 'Transcript audio does not cover the full capture.' });
        if (!session.recordingChunkCount) session.errors.push({ code: 'MISSING_RECORDING', message: 'No recording chunks were saved.' });
        if (finalization.expired) session.errors.push({ code: 'DURATION_LIMIT', message: 'Capture reached the 60 minute limit.' });
        session.state = session.errors.length || session.segments.some(segment => segment.state !== 'complete') ? 'incomplete' : 'ready';
      });
      work.delete(id); return finished;
      })().catch(error => { capture.closing = undefined; throw error; });
      return { task: capture.closing };
    }); return task;
  }
  // Stored approved context remains readable when live capture or AI is disabled.
  router.get('/brief-context', async (_req, res) => { res.json({ consultations: (await store.list()).map(briefConsultationChoice).filter(Boolean) }); });
  router.get('/:id/brief-context', async (req, res) => {
    const input = parse(z.object({ petName: z.string().trim().min(1).max(200), revision: z.string().min(1).max(100) }).strict(), req.query);
    res.json(await resolveBriefConsultation(store, { id: req.params.id, revision: input.revision }, input.petName));
  });
  router.use((req, _res, next) => { if (stopping && !['GET', 'HEAD'].includes(req.method)) next(new ConsultationError('SHUTTING_DOWN', 'Server is shutting down.', 503)); else if (!options.enabled) next(new ConsultationError('FEATURE_DISABLED', 'Live consultation is disabled.', 503)); else next(); });
  router.use('/:id', (req, _res, next) => { if (!['GET', 'HEAD'].includes(req.method) && deleting.has(req.params.id)) next(new ConsultationError('STATE', 'Session is being deleted.', 409)); else next(); });
  router.get('/', async (_req, res) => { res.json({ sessions: await store.list() }); });
  router.post('/', async (req, res) => {
    const input = parse(z.object({ metadata: metadataSchema, captureSource: z.enum(['camera', 'tab']).optional(), consent: z.literal(true) }).strict(), req.body);
    const session = await lock(async () => {
      if (stopping) throw new ConsultationError('SHUTTING_DOWN', 'Server is shutting down.', 503);
      if (busy()) throw new ConsultationError('ACTIVE_SESSION', 'Another consultation is using local AI.', 409);
      if (!options.speech) throw new ConsultationError('SPEECH_UNAVAILABLE', 'Live speech service is unavailable.', 503);
      const release = options.acquireAi(false); preparing = true;
      try {
        await options.speech.prepare(); const created = await store.create(input.metadata, input.captureSource); activeId = created.id;
        const capture: Capture = { controller: new AbortController(), tail: Promise.resolve(), pending: 0, release, storageErrors: [] };
        capture.timer = setTimeout(() => { void closeCapture(created.id, MAX_SESSION_MS, true).catch(() => {}); }, MAX_SESSION_MS + 60000); capture.timer.unref(); work.set(created.id, capture); return created;
      } catch (error) { await options.speech.release().catch(() => {}); release(); throw error; }
      finally { preparing = false; }
    }); res.status(201).json(session);
  });
  router.get('/:id', async (req, res) => { res.json(await store.get(req.params.id)); });
  let uploadWindow = Date.now(); let uploads = 0; let uploadActive = 0;
  router.use('/:id/:kind/:sequence', (req, res, next) => {
    if (req.method !== 'PUT' || !['audio', 'media'].includes(req.params.kind)) { next(); return; }
    if (Date.now() - uploadWindow > 60000) { uploadWindow = Date.now(); uploads = 0; }
    if (uploads >= 300 || uploadActive >= 2) { next(new ConsultationError('UPLOAD_LIMIT', 'Upload budget exhausted; retry later.', 429)); return; }
    uploads++; uploadActive++; let released = false;
    const release = () => { if (!released) { released = true; uploadActive--; } }; res.once('finish', release); res.once('close', release); next();
  });
  router.put('/:id/media/:sequence', express.raw({ type: ['video/webm', 'application/octet-stream'], limit: '16mb' }), async (req, res) => {
    const result = await lock(async () => {
      const id = req.params.id; await currentCapture(id); const index = sequence(req.params.sequence); const bytes = req.body as Buffer;
      if (!Buffer.isBuffer(bytes) || !bytes.length) throw new ConsultationError('MEDIA_INPUT', 'Upload WebM bytes.');
      if (index === 0 && (bytes.length < 4 || !bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])))) throw new ConsultationError('MEDIA_INPUT', 'First recording chunk must contain WebM header.');
      await store.putChunk(id, 'media', index, bytes); return store.get(id);
    }); res.json(result);
  });
  router.put('/:id/audio/:sequence', express.raw({ type: ['audio/wav', 'application/octet-stream'], limit: '1mb' }), async (req, res) => {
    const result = await lock(async () => {
      const id = req.params.id; const session = await currentCapture(id); const index = sequence(req.params.sequence);
      const startMs = parse(z.coerce.number().int().min(0).max(MAX_SESSION_MS), req.query.startMs); const endMs = parse(z.coerce.number().int().min(1).max(MAX_SESSION_MS), req.query.endMs);
      if (endMs <= startMs) throw new ConsultationError('INPUT', 'Invalid audio timestamps.'); const silent = validateWav(req.body, startMs, endMs);
      const existing = session.segments.find(segment => segment.sequence === index);
      if (existing && (existing.startMs !== startMs || existing.endMs !== endMs)) throw new ConsultationError('CONFLICT', 'Retry timestamps differ.', 409);
      const previous = session.segments.at(-1);
      if (!existing && previous && (startMs < previous.endMs - 1000 || endMs <= previous.endMs)) throw new ConsultationError('SEQUENCE', 'Audio timing is out of order.');
      const capture = work.get(id)!; if (!existing && !silent && capture.pending >= 12) throw new ConsultationError('QUEUE_LIMIT', 'Transcription queue is full; retry later.', 429);
      const segmentId = randomUUID();
      if (!await store.putChunk(id, 'audio', index, req.body, { id: segmentId, sequence: index, startMs, endMs, text: '', originalText: '', state: silent ? 'complete' : 'queued', ...(silent ? { model: 'silence-filter', latencyMs: 0 } : {}) })) return store.get(id);
      if (silent) return store.get(id);
      capture.pending++;
      capture.tail = capture.tail.then(async () => {
        let wav: Buffer | undefined;
        try {
          capture.controller.signal.throwIfAborted(); await store.update(id, current => { current.segments.find(segment => segment.id === segmentId)!.state = 'processing'; });
          await options.speech!.prepare(); capture.controller.signal.throwIfAborted();
          wav = await store.audio(id, index); const result = await options.speech!.transcribe(wav, capture.controller.signal); capture.controller.signal.throwIfAborted();
          if (typeof result.text !== 'string' || result.text.length > 16000) throw new Error('Invalid speech result.');
          await store.update(id, current => { const segment = current.segments.find(segment => segment.id === segmentId)!; segment.text = result.text.trim(); segment.originalText = segment.text; segment.state = 'complete'; segment.model = result.model; segment.latencyMs = result.latencyMs; });
        } catch (error) {
          const saveFailure = () => store.update(id, current => { current.segments.find(segment => segment.id === segmentId)!.state = 'failed'; current.errors.push({ code: 'TRANSCRIPTION', message: error instanceof Error ? error.message.slice(0, 500) : 'Transcription failed.', sequence: index }); });
          try { await saveFailure(); } catch { capture.storageErrors.push({ code: 'STORAGE', message: 'Failed transcript state required a storage retry.', sequence: index }); await saveFailure().catch(() => {}); }
        } finally { wav?.fill(0); capture.pending--; }
      }).catch(() => { capture.storageErrors.push({ code: 'STORAGE', message: 'Transcript job could not persist its result.', sequence: index }); }); return store.get(id);
    }); res.status(202).json(result);
  });
  router.post('/:id/finish', async (req, res) => {
    const { durationMs, captureError } = parse(z.object({ durationMs: integerTime, captureError: z.string().trim().min(1).max(500).optional() }).strict(), req.body); const session = await store.get(req.params.id);
    if (durationMs < Math.max(0, ...session.segments.map(segment => segment.endMs))) throw new ConsultationError('INPUT', 'Capture duration is shorter than uploaded audio.');
    if (['recording', 'processing'].includes(session.state) && !work.has(session.id)) throw new ConsultationError('STATE', 'Session capture is unavailable.', 409);
    res.json(await closeCapture(session.id, durationMs, false, captureError));
  });
  router.post('/:id/bookmarks', async (req, res) => {
    const input = parse(z.object({ atMs: integerTime, text: z.string().trim().min(1).max(2000) }).strict(), req.body);
    res.json(await lock(() => store.update(req.params.id, session => { if (visionWork.has(session.id)) throw new ConsultationError('STATE', 'Wait for vision analysis before changing bookmarks.', 409); delete session.vision; if (session.bookmarks.length >= 1000 || (session.state !== 'recording' && input.atMs > session.durationMs)) throw new ConsultationError('INPUT', 'Bookmark exceeds session bounds.'); session.bookmarks.push({ id: randomUUID(), ...input }); delete session.note; delete session.noteRevision; })));
  });
  router.patch('/:id/segments/:segmentId', async (req, res) => {
    const input = parse(z.object({ text: z.string().max(16000) }).strict(), req.body);
    res.json(await store.update(req.params.id, session => { const segment = session.segments.find(segment => segment.id === req.params.segmentId); if (!segment || segment.state !== 'complete') throw new ConsultationError('STATE', 'Transcript segment is not editable.', 409); segment.text = input.text; delete session.note; delete session.noteRevision; }));
  });
  const framePath = (id: string, revision: string, sceneId: string, index: number) => path.join(store.directory, id, 'vision', revision, sceneId, String(index) + '.jpg');
  async function finishVision(id: string, revision: string, state: 'complete' | 'failed' | 'cancelled', error?: string) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await store.update(id, current => {
          if (current.vision?.revision !== revision || current.vision.state !== 'processing') throw new ConsultationError('VISION_CHANGED', 'Vision changed during terminal recovery.', 409);
          const vision = current.vision;
          vision.state = state === 'complete' && vision.scenes.some(scene => scene.state === 'failed') ? 'failed' : state;
          if (error) vision.error = error;
          else if (vision.state === 'failed') vision.error = 'Some sampled scenes could not be analyzed.';
        });
      } catch (failure) {
        if (failure instanceof ConsultationError && ['VISION_CHANGED', 'NOT_FOUND'].includes(failure.code)) throw failure;
        if (attempt === 1) throw new ConsultationError('STORAGE', 'Vision status could not be saved. Retry cancellation to recover interrupted analysis.', 500);
      }
    }
  }
  async function safeDirectory(directory: string) { const info=await lstat(directory); if(!info.isDirectory()||info.isSymbolicLink()) throw new ConsultationError('STORAGE','Unsafe vision directory.',500); }
  router.post('/:id/vision', async (req, res) => {
    parse(z.object({}).strict(), req.body);
    const result = await lock(async () => {
      const id = req.params.id; const session = await store.get(id);
      if (stopping) throw new ConsultationError('SHUTTING_DOWN', 'Server is shutting down.', 503);
      if (busy() || ['recording','processing','preparing'].includes(session.state)) throw new ConsultationError('STATE', 'Finish local AI work before vision analysis.', 409);
      if (!options.vision) throw new ConsultationError('VISION_UNAVAILABLE', 'Local vision service unavailable.', 503);
      if (!session.durationMs) throw new ConsultationError('STATE', 'Recording has no duration.', 409);
      let times: number[]; try { times = visionSceneTimes(session.durationMs, session.bookmarks); } catch { throw new ConsultationError('VISION_LIMIT', 'Too many bookmarks for vision scene budget.', 409); }
      const release = options.acquireAi(true); const controller = new AbortController(); const revision = randomUUID();
      let initial: ConsultationSession;
      const visionDirectory = path.join(store.directory,id,'vision');
      try { await safeDirectory(path.join(store.directory,id)); initial = await store.update(id, current => { delete current.note; delete current.noteRevision; current.vision = { revision, state:'processing', model:options.vision!.model, intervalMs:VISION_INTERVAL_MS, scenes:times.map(atMs => ({id:randomUUID(),atMs,frameTimesMs:visionFrameTimes(atMs,session.durationMs),state:'pending',observations:[],originalObservations:[]})) }; }); }
      catch (error) { release(); throw error; }
      const task = (async () => {
        try {
          controller.signal.throwIfAborted();
          try { await safeDirectory(visionDirectory); await rm(visionDirectory,{recursive:true}); } catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT') throw new Error(error instanceof Error ? error.message : 'Vision frame cleanup failed.'); }
          const files = await store.recordingFiles(id); let storedBytes = await store.storageBytes(id);
          for (const scene of initial.vision!.scenes) {
            controller.signal.throwIfAborted();
            try {
              const { frames, frameTimesMs } = await options.vision!.extractFrames(files, scene.frameTimesMs, controller.signal); controller.signal.throwIfAborted();
              if(frameTimesMs.length !== frames.length || frameTimesMs.some(time=>!Number.isInteger(time)||time<0||time>session.durationMs) || frames.length !== scene.frameTimesMs.length || frames.some(frame => !frame.length || frame.length > MAX_FRAME_BYTES || frame[0]!==0xff || frame[1]!==0xd8)) throw new Error('Invalid extracted scene images.');
              const frameBytes=frames.reduce((sum,frame)=>sum+frame.length,0); if(storedBytes+frameBytes>MAX_SESSION_BYTES) throw new Error('Session storage budget exceeded by scene images.'); storedBytes+=frameBytes;
              const directory = path.dirname(framePath(id, revision, scene.id, 0)); await safeDirectory(path.join(store.directory,id)); for(const parent of [path.join(store.directory,id,'vision'),path.join(store.directory,id,'vision',revision),directory]) { try { await mkdir(parent); } catch(error) { if((error as NodeJS.ErrnoException).code!=='EEXIST') throw error; } await safeDirectory(parent); }
              for(let index=0;index<frames.length;index++) { controller.signal.throwIfAborted(); await writeFile(framePath(id,revision,scene.id,index), frames[index], {flag:'wx'}); }
              await store.update(id, current => { current.vision!.scenes.find(s=>s.id===scene.id)!.frameTimesMs=frameTimesMs; });
              const observations = visionObservationsSchema.parse(await options.vision!.analyze(frames,controller.signal)); controller.signal.throwIfAborted();
              await store.update(id, current => { const target = current.vision!.scenes.find(s => s.id===scene.id)!; target.state='complete'; target.frameTimesMs=frameTimesMs; target.observations=observations; target.originalObservations=[...observations]; });
            } catch(error) {
              if(controller.signal.aborted) throw error;
              await store.update(id, current => { const target = current.vision!.scenes.find(s => s.id===scene.id)!; target.state='failed'; target.error=error instanceof Error?error.message.slice(0,500):'Vision scene failed.'; });
            }
          }
          await finishVision(id, revision, 'complete');
        } catch(error) {
          if (error instanceof ConsultationError && ['STORAGE', 'VISION_CHANGED', 'NOT_FOUND'].includes(error.code)) throw error;
          await finishVision(id, revision, controller.signal.aborted ? 'cancelled' : 'failed', controller.signal.aborted ? 'Vision analysis cancelled.' : error instanceof Error ? error.message.slice(0,500) : 'Vision analysis failed.');
        }
        finally { release(); visionWork.delete(id); }
      })(); visionWork.set(id,{controller,task}); void task.catch(() => {}); return initial;
    }); res.status(202).json(result);
  });
  router.post('/:id/vision/cancel', async (req,res) => {
    parse(z.object({}).strict(),req.body); const id=req.params.id;
    const { job } = await lock(async () => { const session=await store.get(id); const job=visionWork.get(id); job?.controller.abort();
      if (!job && session.vision?.state === 'processing') await finishVision(id, session.vision.revision, 'cancelled', 'Vision analysis interrupted before status could be saved.');
      return { job }; });
    await job?.task; res.json(await store.get(id));
  });
  router.patch('/:id/vision/scenes/:sceneId', async(req,res) => {
    const input=parse(z.object({revision:z.uuid(),observations:visionObservationsSchema}).strict(),req.body);
    res.json(await store.update(req.params.id,current => { if(current.vision?.revision!==input.revision) throw new ConsultationError('VISION_CHANGED','Vision changed after review.',409); if(current.vision.state!=='complete') throw new ConsultationError('STATE','Complete vision before editing.',409); const scene=current.vision.scenes.find(scene=>scene.id===req.params.sceneId); if(!scene) throw new ConsultationError('NOT_FOUND','Scene not found.',404); scene.observations=input.observations; delete current.vision.reviewedAt; current.vision.revision=randomUUID(); delete current.note; delete current.noteRevision; }));
  });
  router.post('/:id/vision/review',async(req,res) => {
    const input=parse(z.object({revision:z.uuid(),reviewed:z.literal(true)}).strict(),req.body);
    res.json(await store.update(req.params.id,current => {if(current.vision?.revision!==input.revision)throw new ConsultationError('VISION_CHANGED','Vision changed after review.',409);if(current.vision.state!=='complete')throw new ConsultationError('STATE','Only complete vision can be reviewed.',409);current.vision.reviewedAt=new Date().toISOString();}));
  });
  router.get('/:id/vision/scenes/:sceneId/frames/:index',async(req,res) => {
    const session=await store.get(req.params.id); const scene=session.vision?.scenes.find(scene=>scene.id===req.params.sceneId); const index=sequence(req.params.index);
    if(!scene||index>=scene.frameTimesMs.length)throw new ConsultationError('NOT_FOUND','Frame not found.',404);
    // Frames keep original analysis revision even after observation edits.
    const folder=path.join(store.directory,session.id,'vision'); let filename:string|undefined;
    await safeDirectory(path.join(store.directory,session.id)); try { await safeDirectory(folder); } catch(error) { if((error as NodeJS.ErrnoException).code==='ENOENT') throw new ConsultationError('NOT_FOUND','Frame not found.',404); throw error; }
    for(const revision of await readdir(folder)){if(!z.uuid().safeParse(revision).success)continue;const candidate=framePath(session.id,revision,scene.id,index);try{await safeDirectory(path.join(folder,revision)); await safeDirectory(path.dirname(candidate)); const info=await lstat(candidate);if(info.isFile()&&!info.isSymbolicLink()&&info.size<=MAX_FRAME_BYTES){filename=candidate;break;}}catch{}}
    if(!filename)throw new ConsultationError('NOT_FOUND','Frame not found.',404);res.type('image/jpeg').send(await readFile(filename));
  });
  router.post('/:id/note', async (req, res) => {
    const id = req.params.id; const session = await store.get(id);
    if (stopping) throw new ConsultationError('SHUTTING_DOWN', 'Server is shutting down.', 503);
    if (busy() || ['recording', 'processing', 'preparing'].includes(session.state)) throw new ConsultationError('STATE', 'Finish local AI work before generating notes.', 409);
    if (session.captureSource === 'camera' && session.vision?.state !== 'complete') throw new ConsultationError('VISION_REQUIRED', 'Complete camera analysis before generating notes.', 409);
    const release = options.acquireAi(true); const controller = new AbortController(); res.once('close', () => { if (!res.writableEnded) controller.abort(); });
    const task = (async () => {
      try { const note = await generateConsultationNote(session, options.generate, controller.signal); controller.signal.throwIfAborted(); return await store.update(id, current => { if (JSON.stringify(current.segments) !== JSON.stringify(session.segments) || JSON.stringify(current.bookmarks) !== JSON.stringify(session.bookmarks) || JSON.stringify(current.vision) !== JSON.stringify(session.vision)) throw new ConsultationError('CONFLICT', 'Transcript changed during generation.', 409); current.note = note; current.noteRevision = randomUUID(); }); }
      finally { release(); noteWork.delete(id); }
    })(); noteWork.set(id, { controller, task }); res.json(await task);
  });
  router.patch('/:id/note', async (req, res) => {
    const input = parse(z.object({ note: z.unknown() }).strict(), req.body);
    res.json(await store.update(req.params.id, session => { const note = structuredClone(input.note) as ConsultationNote; if (validateConsultationNote(note, session).length) throw new ConsultationError('EVIDENCE', 'Note must use exact persisted source evidence.'); delete note.approvedAt; session.note = note; session.noteRevision = randomUUID(); }));
  });
  router.post('/:id/approve', async (req, res) => {
    const input = parse(z.object({ reviewed: z.literal(true), noteRevision: z.string().min(1).max(100) }).strict(), req.body);
    res.json(await store.update(req.params.id, session => { if (input.noteRevision !== consultationNoteRevision(session)) throw new ConsultationError('NOTE_CHANGED', 'Note changed after review. Reload and review current sources.', 409); if ((session.captureSource === 'camera' || session.note?.items.some(item => item.evidence.some(evidence => evidence.kind === 'vision'))) && (session.vision?.state !== 'complete' || !session.vision.reviewedAt)) throw new ConsultationError('VISION_REVIEW_REQUIRED', 'Review complete visual analysis before approval.', 409); if (session.state !== 'ready' || !session.note || validateConsultationNote(session.note, session).length) throw new ConsultationError('STATE', 'Only complete evidence-valid notes can be approved.', 409); session.note.approvedAt = new Date().toISOString(); }));
  });
  router.get('/:id/export', async (req, res) => { res.set('Content-Disposition', 'attachment; filename="consultation.json"').json(await store.get(req.params.id)); });
  router.get('/:id/recording', recordingHandler(store, options.ffmpegPath ?? 'ffmpeg'));
  router.delete('/:id', async (req, res) => {
    const id = req.params.id; await store.get(id); await lock(async () => { if (deleting.has(id)) throw new ConsultationError('STATE', 'Session is being deleted.', 409); deleting.add(id); });
    try {
      const vision = visionWork.get(id); vision?.controller.abort(); await vision?.task.catch(() => {});
      const note = noteWork.get(id); note?.controller.abort(); await note?.task.catch(() => {}); const capture = work.get(id);
      if (capture) { clearTimeout(capture.timer); capture.controller.abort(); await capture.tail.catch(() => {}); if (capture.closing) await capture.closing.catch(() => {}); await releaseCapture(id, capture); work.delete(id); }
      await lock(() => store.delete(id)); res.status(204).end();
    } finally { deleting.delete(id); }
  });
  router.use((error: unknown, _req: Request, res: Response, next: express.NextFunction) => { if (!(error instanceof ConsultationError)) { next(error); return; } res.status(error.status).json({ error: error.message, code: error.code, requestId: res.locals.requestId }); });
  function shutdown(): Promise<void> {
    if (shutdownTask) return shutdownTask;
    stopping = true;
    shutdownTask = (async () => {
      const jobs = await lock(async () => {
        const jobs = [...visionWork.values(), ...noteWork.values()];
        jobs.forEach(job => job.controller.abort());
        work.forEach(capture => { clearTimeout(capture.timer); capture.controller.abort(); });
        return jobs;
      });
      const results = await Promise.allSettled(jobs.map(job => job.task));
      const captures = await Promise.allSettled([...work].map(async ([id, capture]) => {
        try {
          await capture.tail;
          const session = await store.get(id);
          await closeCapture(id, Math.max(session.durationMs, ...session.segments.map(segment => segment.endMs), ...session.bookmarks.map(bookmark => bookmark.atMs)), false, 'Server stopped during capture.');
        } finally { await releaseCapture(id, capture); }
      }));
      const failed = [...results, ...captures].find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    })();
    return shutdownTask;
  }
  return { router, busy, shutdown, resolveBrief: (reference: { id: string; revision: string }, petName: string) => resolveBriefConsultation(store, reference, petName) };
}
