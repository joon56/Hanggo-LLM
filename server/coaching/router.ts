import { randomUUID } from 'node:crypto';
import express from 'express';
import type { ErrorRequestHandler, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { setConsent, transition, TransitionError } from '../../src/domain/coaching.ts';
import { computeBrief } from '../../src/domain/brief.ts';
import { approvalProblems, briefContextOf, deliveryOf, normalizeEditedNote, reviewedObservationClaims } from '../../src/domain/coaching-note.ts';
import { createManualOwnerDraft, validateOwnerDraft } from '../../src/domain/owner-log.ts';
import type { OwnerDraft, OwnerInput } from '../../src/domain/workspace-types.ts';
import type { CoachingCase, Consultation, Moment, Speaker } from '../../src/domain/coaching.ts';
import { can } from '../../src/domain/permissions.ts';
import type { Action, Actor } from '../../src/domain/permissions.ts';
import { iceConfig, type TurnConfig } from '../turn.ts';
import type { GuardianSessions } from './guardian-session.ts';
import { StoreError, type CoachingStore } from './store.ts';
import type { PostProcess } from './post-process.ts';
import type { Transcription } from './transcription.ts';
import { noteSchema } from './note-schema.ts';
import { isSilentWav } from './wav.ts';

export const GUARDIAN_COOKIE = 'hanggo_guardian';
type Headers = { cookie?: string };

export type CoachingDeps = {
  store: CoachingStore; sessions: GuardianSessions; turn: TurnConfig; secureCookies: boolean; transcription: Transcription; postProcess: PostProcess;
  /** How long after the end to accept what browsers still hold. */
  graceMs: number;
  /** Password session check owned by the app. */
  isTrainer: (headers: Headers) => boolean;
  /** Tells connected participants that consultation state changed. */
  notify?: (consultation: Consultation) => void;
  broadcast?: (consultationId: string, message: unknown) => void;
  /** Organizes a guardian's words into events. Without it the guardian still saves the plain text. */
  generateOwner?: (input: OwnerInput, signal?: AbortSignal) => Promise<{ draft: OwnerDraft }>;
  now?: () => number;
};

const name = z.string().trim().min(1).max(200);
const CaseInput = z.object({ petName: name, guardianName: name, trainerName: name }).strict();
const JoinInput = z.object({ token: z.string().min(1).max(200) }).strict();
const ConsentInput = z.object({ value: z.boolean() }).strict();
const MAX_RECORDING_MS = 60 * 60 * 1000;
const CLOCK_SLACK_MS = 5000;
const MAX_FRAMES = 1000;
const MAX_MOMENTS = 200;
const MERGE_MOMENTS_MS = 1000;
const time = z.string().regex(/^\d{1,8}$/).transform(Number).pipe(z.number().max(MAX_RECORDING_MS));
const AudioParams = z.object({ startMs: time, endMs: time }).strict();
const FrameParams = z.object({ frameId: z.uuid(), atMs: time, source: z.enum(['camera', 'screen']), moment: z.uuid().optional() }).strict();
const MemoInput = z.object({ text: z.string().trim().max(500) }).strict();
const SegmentEdit = z.object({ text: z.string().trim().min(1).max(8000).optional(), echoSuspect: z.boolean().optional() }).strict();
const TaskLogInput = z.object({ consultationId: z.uuid(), taskId: z.string().min(1).max(100), status: z.enum(['done', 'partial', 'skipped']), text: z.string().trim().max(2000).optional() }).strict();
const GuardianText = z.object({ text: z.string().trim().min(1).max(8000), sourceKind: z.enum(['nl_log_text', 'nl_log_voice']).default('nl_log_text') }).strict();
const GuardianLogInput = z.object({ draft: z.custom<OwnerDraft>(value => typeof value === 'object' && value !== null) }).strict();
const TIME_ZONE = 'Asia/Seoul';
const MAX_GUARDIAN_LOG_CHARACTERS = 64 * 1024;
const OWNER_DRAFT_TIMEOUT_MS = 80_000;
const ObservationEdit = z.object({ text: z.string().trim().min(1).max(1000).optional(), reviewed: z.boolean().optional() }).strict();
const isJpeg = (bytes: unknown) => Buffer.isBuffer(bytes) && bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

const publicCase = ({ inviteHash: _inviteHash, inviteExpiresAt: _inviteExpiresAt, guardianGeneration: _generation, ...shared }: CoachingCase) => shared;
/** The guardian's copy comes from the delivery route. Drafts, edits, scenes, and memos stay with the trainer. */
const viewFor = (actor: Actor, consultation: Consultation): Consultation => {
  if (actor.role === 'trainer') return consultation;
  const { note: _note, noteGenerating: _noteGenerating, organizing: _organizing, ...shared } = consultation;
  return { ...shared, segments: [], frames: [], moments: [], scenes: [], errors: [] };
};
/** Photos the confirmed note cites, which are the only ones a guardian may open. */
const citedScenes = (consultation: Consultation) => {
  // Read from the delivery, so an observation left out of it does not leave its photo reachable.
  const cited = new Set((consultation.note ? deliveryOf(consultation.note).aiObservations : []).flatMap(claim => claim.evidence).filter(item => item.kind === 'scene').map(item => item.id));
  return consultation.scenes.filter(scene => cited.has(scene.id)).map(({ id, atMs, frameIds }) => ({ id, atMs, frameIds }));
};
const readCookie = (headers: Headers, key: string) => headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${key}=`))?.slice(key.length + 1);

/** Shared with the signaling server so REST and WebSocket apply the same identity rules. */
export function createActorResolver({ store, sessions, isTrainer }: Pick<CoachingDeps, 'store' | 'sessions' | 'isTrainer'>) {
  return async (headers: Headers): Promise<Actor | null> => {
    const raw = readCookie(headers, GUARDIAN_COOKIE);
    const session = raw ? sessions.read(raw) : null;
    if (session) {
      const stored = await store.getCase(session.caseId).catch(() => null);
      if (stored?.guardianGeneration === session.generation) return { role: 'guardian', caseId: session.caseId };
    }
    return isTrainer(headers) ? { role: 'trainer' } : null;
  };
}

export function createCoachingRouter(deps: CoachingDeps) {
  const { store, sessions, notify, transcription, postProcess, graceMs, broadcast, generateOwner, now = Date.now } = deps;
  const router = express.Router();
  const resolveActor = createActorResolver(deps);
  const joinLimit = rateLimit({ windowMs: 60_000, limit: 10, keyGenerator: () => 'join', standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: '잠시 후 다시 시도해 주세요.', code: 'RATE_LIMIT' } });
  const cookieOptions = { httpOnly: true, secure: deps.secureCookies, sameSite: 'strict' as const, path: '/api', maxAge: sessions.maxAgeMs };

  router.post('/join', joinLimit, async (req, res) => {
    const { token } = JoinInput.parse(req.body);
    const redeemed = await store.redeemInvite(token);
    res.cookie(GUARDIAN_COOKIE, sessions.issue(redeemed.id, redeemed.guardianGeneration), cookieOptions).json({ case: publicCase(redeemed) });
  });

  const actors = new WeakMap<Request, Actor>();
  router.use(async (req, res, next) => {
    const actor = await resolveActor(req.headers);
    if (!actor) { res.status(401).json({ error: '로그인이 필요합니다.', code: 'AUTH' }); return; }
    actors.set(req, actor); next();
  });
  const actorOf = (req: Request) => actors.get(req)!;
  function allowed(req: Request, res: Response, action: Action, caseId?: string) {
    if (can(actorOf(req), action, caseId)) return true;
    res.status(403).json({ error: '권한이 없습니다.', code: 'FORBIDDEN' });
    return false;
  }
  const roleOf = (actor: Actor): Speaker => actor.role;
  const param = (req: Request, key: string) => String(req.params[key]);

  router.get('/me', (req, res) => { res.json(actorOf(req)); });

  router.post('/cases', async (req, res) => {
    if (!allowed(req, res, 'case:create')) return;
    const created = await store.createCase(CaseInput.parse(req.body));
    res.status(201).json({ case: publicCase(created.case), inviteToken: created.inviteToken });
  });
  router.get('/cases', async (req, res) => {
    const actor = actorOf(req);
    const cases = actor.role === 'trainer' ? await store.listCases() : [await store.getCase(actor.caseId)];
    res.json({ cases: cases.map(publicCase) });
  });
  router.get('/cases/:id', async (req, res) => {
    const id = param(req, 'id');
    if (!allowed(req, res, 'case:read', id)) return;
    res.json({ ...publicCase(await store.getCase(id)), consultations: (await store.listConsultations(id)).map(item => viewFor(actorOf(req), item)) });
  });
  router.delete('/cases/:id', async (req, res) => {
    const id = param(req, 'id');
    if (!allowed(req, res, 'case:delete', id)) return;
    await store.deleteCase(id);
    res.status(204).end();
  });
  router.post('/cases/:id/invite', async (req, res) => {
    const id = param(req, 'id');
    if (!allowed(req, res, 'case:invite', id)) return;
    res.json({ inviteToken: await store.reissueInvite(id) });
  });
  router.post('/cases/:id/consultations', async (req, res) => {
    const id = param(req, 'id');
    if (!allowed(req, res, 'consultation:start', id)) return;
    res.status(201).json(await store.startConsultation(id));
  });

  /** One guardian's session should not be able to keep the GPU or the store busy for everyone else. */
  const perCase = (limit: number) => rateLimit({ windowMs: 60_000, limit, keyGenerator: req => String(req.params.id), standardHeaders: 'draft-8', legacyHeaders: false, validate: false,
    message: { error: '잠시 후 다시 시도해 주세요.', code: 'RATE_LIMIT' } });
  router.post('/cases/:id/task-logs', perCase(60), async (req, res) => {
    const caseId = param(req, 'id');
    if (!allowed(req, res, 'task-log:write', caseId)) return;
    const { consultationId, taskId, status, text } = TaskLogInput.parse(req.body);
    const consultation = await store.getConsultation(consultationId);
    if (consultation.caseId !== caseId || consultation.state !== 'approved' || !consultation.note?.tasks.some(task => task.id === taskId)) throw new StoreError('NOT_FOUND', '이 과제를 찾을 수 없습니다.', 404);
    res.status(201).json(await store.addTaskLog(caseId, { id: randomUUID(), caseId, consultationId, taskId, at: new Date(now()).toISOString(), status, ...(text ? { text } : {}) }));
  });
  router.get('/cases/:id/task-logs', async (req, res) => {
    const caseId = param(req, 'id');
    if (allowed(req, res, 'task-log:read', caseId)) res.json({ logs: await store.listTaskLogs(caseId) });
  });
  /** One GPU cannot organize a note and hold a speech model at once, so a guardian's log waits for neither. */
  const gpuFree = () => !postProcess.busy() && !['preparing', 'ready'].includes(transcription.status());
  router.post('/cases/:id/guardian-logs/draft', perCase(10), async (req, res) => {
    const caseId = param(req, 'id');
    if (!allowed(req, res, 'guardian-log:write', caseId)) return;
    const { text, sourceKind } = GuardianText.parse(req.body);
    const { petName } = await store.getCase(caseId);
    const input: OwnerInput = { text, sourceKind, pets: [{ id: caseId, name: petName, nicknames: [] }], now: new Date(now()).toISOString(), timeZone: TIME_ZONE };
    const organized = generateOwner && gpuFree() ? await generateOwner(input, AbortSignal.timeout(OWNER_DRAFT_TIMEOUT_MS)).then(result => result.draft, () => null) : null;
    res.json(organized ?? createManualOwnerDraft(input));
  });
  router.post('/cases/:id/guardian-logs', perCase(30), async (req, res) => {
    const caseId = param(req, 'id');
    if (!allowed(req, res, 'guardian-log:write', caseId)) return;
    const { draft: submitted } = GuardianLogInput.parse(req.body);
    if (JSON.stringify(submitted).length > MAX_GUARDIAN_LOG_CHARACTERS) throw new StoreError('INPUT', '기록이 너무 깁니다.');
    // Ids come from here, because the brief refuses to read records whose ids collide.
    const draft = { ...submitted, events: Array.isArray(submitted.events) ? submitted.events.map(event => ({ ...event, id: randomUUID() })) : submitted.events };
    const problems = validateOwnerDraft(draft);
    if (draft.pets?.length !== 1 || draft.pets[0].id !== caseId) problems.push('이 사례의 반려동물 기록이 아닙니다.');
    if (problems.length) throw new StoreError('INPUT', problems.join(' '));
    res.status(201).json(await store.addGuardianLog(caseId, { id: randomUUID(), draft, savedAt: new Date(now()).toISOString() }));
  });
  router.get('/cases/:id/guardian-logs', async (req, res) => {
    const caseId = param(req, 'id');
    if (allowed(req, res, 'guardian-log:read', caseId)) res.json({ logs: await store.listGuardianLogs(caseId) });
  });
  router.put('/cases/:id/voice', perCase(40), express.raw({ type: 'audio/wav', limit: '600kb' }), async (req, res) => {
    const caseId = param(req, 'id');
    if (!allowed(req, res, 'guardian-log:write', caseId)) return;
    const durationMs = Buffer.isBuffer(req.body) ? Math.round((req.body.length - 44) / 32) : 0;
    if (isSilentWav(req.body, 0, durationMs)) { res.json({ text: '' }); return; }
    if (postProcess.busy()) throw new StoreError('GPU_BUSY', '상담을 정리하는 중이라 지금은 받아쓸 수 없습니다. 글로 적어 주세요.', 409);
    res.json({ text: await transcription.dictate(req.body) });
  });
  router.get('/cases/:id/brief', async (req, res) => {
    const caseId = param(req, 'id');
    if (!allowed(req, res, 'brief:read', caseId)) return;
    const [info, consultations, taskLogs, guardianLogs] = await Promise.all([store.getCase(caseId), store.listConsultations(caseId), store.listTaskLogs(caseId), store.listGuardianLogs(caseId)]);
    // Newest first, so this is the session that just ended, not one chosen by matching a name.
    const latest = consultations.find(item => item.state === 'approved' && item.note);
    const brief = computeBrief({ pet: { id: caseId, name: info.petName, nicknames: [] }, records: guardianLogs, now: new Date(now()).toISOString(), timeZone: TIME_ZONE },
      latest && briefContextOf(latest, info, TIME_ZONE), taskLogs.filter(log => log.consultationId === latest?.id));
    res.json({ brief, consultationId: latest?.id ?? null });
  });

  async function consultationFor(req: Request, res: Response, action: Action) {
    const consultation = await store.getConsultation(param(req, 'id'));
    return allowed(req, res, action, consultation.caseId) ? consultation : null;
  }
  router.get('/consultations/:id', async (req, res) => {
    const consultation = await consultationFor(req, res, 'case:read');
    if (consultation) res.json(viewFor(actorOf(req), consultation));
  });
  router.get('/consultations/:id/ice', async (req, res) => {
    if (await consultationFor(req, res, 'call:join')) res.json(iceConfig(deps.turn));
  });
  router.post('/consultations/:id/consent', async (req, res) => {
    const consultation = await consultationFor(req, res, 'consent:set');
    if (!consultation) return;
    const { value } = ConsentInput.parse(req.body);
    const updated = await store.updateConsultation(consultation.id, current => setConsent(current, roleOf(actorOf(req)), value, now()));
    if (updated.recording) transcription.start(updated.id);
    notify?.(updated); res.json(viewFor(actorOf(req), updated));
  });
  router.post('/consultations/:id/end', async (req, res) => {
    const consultation = await consultationFor(req, res, 'consultation:end');
    if (!consultation) return;
    const updated = await store.updateConsultation(consultation.id, current => transition(current, 'end', now()));
    notify?.(updated); res.json(updated);
    void postProcess.finish(updated.id).catch(() => { console.error('상담 마무리 처리에 실패했습니다.'); });
  });

  /** The browser's last window arrives after the end, but only if both sides were still consenting then. */
  function acceptsMedia(consultation: Consultation) {
    if (consultation.recording) return true;
    return consultation.state === 'processing' && consultation.consent.guardian && consultation.consent.trainer && now() - consultation.endedAt! < graceMs;
  }
  async function recordingFor(req: Request, res: Response) {
    const consultation = await consultationFor(req, res, 'recording:upload');
    if (consultation && !acceptsMedia(consultation)) throw new StoreError('NOT_RECORDING', '지금은 기록 중이 아닙니다.', 409);
    return consultation;
  }
  const elapsed = (consultation: Consultation) => (consultation.endedAt ?? now()) - consultation.recordingStartedAt!;
  router.put('/consultations/:id/audio/:startMs', express.raw({ type: 'audio/wav', limit: '600kb' }), async (req, res) => {
    const consultation = await recordingFor(req, res);
    if (!consultation) return;
    const times = AudioParams.parse({ startMs: param(req, 'startMs'), endMs: req.query.endMs });
    if (times.endMs > elapsed(consultation) + CLOCK_SLACK_MS) throw new StoreError('INPUT', '기록 시간을 벗어났습니다.');
    if (isSilentWav(req.body, times.startMs, times.endMs)) { res.json({ dropped: true }); return; }
    const segment = await transcription.accept(consultation.id, roleOf(actorOf(req)), times, req.body);
    res.status(202).json({ id: segment.id });
  });
  router.put('/consultations/:id/frames/:frameId', express.raw({ type: 'image/jpeg', limit: '256kb' }), async (req, res) => {
    const consultation = await recordingFor(req, res);
    if (!consultation) return;
    const { frameId, atMs, source, moment } = FrameParams.parse({ frameId: param(req, 'frameId'), ...req.query });
    const speaker = roleOf(actorOf(req));
    // A shared screen or the trainer's own camera can show private things, so they are kept only when someone marked the moment.
    if (!moment && (speaker !== 'guardian' || source !== 'camera')) throw new StoreError('INPUT', '이 장면은 캐치할 때만 저장합니다.');
    if (!isJpeg(req.body)) throw new StoreError('INPUT', 'JPEG 사진이 아닙니다.');
    if (moment && !consultation.moments.some(item => item.id === moment)) throw new StoreError('NOT_FOUND', '캐치를 찾을 수 없습니다.', 404);
    const existing = consultation.frames.find(item => item.id === frameId);
    if (existing && existing.speaker !== speaker) throw new StoreError('FRAME', '이미 다른 참가자가 올린 사진입니다.', 409);
    if (!existing && consultation.frames.length >= MAX_FRAMES) throw new StoreError('FRAME_LIMIT', '저장할 수 있는 사진 수를 넘었습니다.', 429);
    if (!existing) await store.putFrame(consultation.id, frameId, req.body);
    await store.updateConsultation(consultation.id, current => ({ ...current,
      frames: current.frames.some(item => item.id === frameId) ? current.frames : [...current.frames, { id: frameId, atMs, source, speaker, bytes: req.body.length }],
      moments: current.moments.map(item => item.id === moment && !item.frameIds.includes(frameId) ? { ...item, frameIds: [...item.frameIds, frameId] } : item) }));
    res.status(201).json({ id: frameId });
  });
  router.get('/consultations/:id/frames/:frameId', async (req, res) => {
    const consultation = await consultationFor(req, res, 'frame:read-cited');
    if (!consultation) return;
    const frameId = param(req, 'frameId');
    const readable = can(actorOf(req), 'frame:read-all', consultation.caseId) || (consultation.state === 'approved' && citedScenes(consultation).some(scene => scene.frameIds.includes(frameId)));
    if (!readable) { res.status(403).json({ error: '권한이 없습니다.', code: 'FORBIDDEN' }); return; }
    res.type('image/jpeg').send(await store.readFrame(consultation.id, frameId));
  });
  router.post('/consultations/:id/moments', async (req, res) => {
    const consultation = await consultationFor(req, res, 'moment:create');
    if (!consultation) return;
    if (!consultation.recording) throw new StoreError('NOT_RECORDING', '지금은 기록 중이 아닙니다.', 409);
    const createdBy = roleOf(actorOf(req)); const atMs = elapsed(consultation);
    if (atMs > MAX_RECORDING_MS) throw new StoreError('INPUT', '기록 시간을 벗어났습니다.');
    let moment!: Moment; let added = false;
    await store.updateConsultation(consultation.id, current => {
      const recent = current.moments.filter(item => item.createdBy === createdBy && atMs - item.atMs < MERGE_MOMENTS_MS).at(-1);
      if (recent) { moment = recent; return current; }
      if (current.moments.length >= MAX_MOMENTS) throw new StoreError('MOMENT_LIMIT', '저장할 수 있는 캐치 수를 넘었습니다.', 429);
      moment = { id: randomUUID(), atMs, createdBy, frameIds: [] }; added = true;
      return { ...current, moments: [...current.moments, moment] };
    });
    if (added) broadcast?.(consultation.id, { type: 'moment', id: moment.id, atMs, createdBy });
    res.status(201).json({ ...moment, text: undefined });
  });
  router.patch('/consultations/:id/moments/:momentId', async (req, res) => {
    const consultation = await consultationFor(req, res, 'scene:review');
    if (!consultation) return;
    const { text } = MemoInput.parse(req.body);
    const momentId = param(req, 'momentId');
    if (!consultation.moments.some(item => item.id === momentId)) throw new StoreError('NOT_FOUND', '캐치를 찾을 수 없습니다.', 404);
    const updated = await store.updateConsultation(consultation.id, current => ({ ...current, moments: current.moments.map(item => item.id === momentId ? { ...item, text } : item) }));
    res.json(updated.moments.find(item => item.id === momentId));
  });

  async function reviewable(req: Request, res: Response, action: Action) {
    const consultation = await consultationFor(req, res, action);
    if (!consultation) return null;
    if (consultation.state !== 'review') throw new StoreError('STATE', '검토 중인 상담이 아닙니다.', 409);
    return consultation;
  }
  async function editable(req: Request, res: Response, action: Action) {
    const consultation = await reviewable(req, res, action);
    if (consultation?.noteGenerating) throw new StoreError('NOTE_BUSY', '일지를 다시 만드는 중입니다. 잠시 후 다시 시도해 주세요.', 409);
    return consultation;
  }
  const refreshed = (current: Consultation, info: CoachingCase) => current.note ? { ...current, note: normalizeEditedNote(current.note, current.note, current, info).note } : current;
  router.patch('/consultations/:id/segments/:segmentId', async (req, res) => {
    const consultation = await editable(req, res, 'transcript:edit');
    if (!consultation) return;
    const change = SegmentEdit.parse(req.body);
    const segmentId = param(req, 'segmentId');
    if (!consultation.segments.some(item => item.id === segmentId)) throw new StoreError('NOT_FOUND', '전사 구간을 찾을 수 없습니다.', 404);
    const info = await store.getCase(consultation.caseId);
    // Quotes in the note follow the corrected transcript, and an echo stops being citable.
    res.json(await store.updateConsultation(consultation.id, current => refreshed({ ...current, segments: current.segments.map(item => item.id === segmentId ? { ...item, ...change } : item) }, info)));
  });
  router.patch('/consultations/:id/scenes/:sceneId/observations/:observationId', async (req, res) => {
    const consultation = await editable(req, res, 'scene:review');
    if (!consultation) return;
    const change = ObservationEdit.parse(req.body);
    const sceneId = param(req, 'sceneId'); const observationId = param(req, 'observationId');
    if (!consultation.scenes.some(scene => scene.id === sceneId && scene.observations.some(item => item.id === observationId))) throw new StoreError('NOT_FOUND', '장면 관찰을 찾을 수 없습니다.', 404);
    res.json(await store.updateConsultation(consultation.id, current => ({ ...current, scenes: current.scenes.map(scene => scene.id !== sceneId ? scene : { ...scene, observations: scene.observations.map(item => item.id === observationId ? { ...item, ...change } : item) }) })));
  });
  router.post('/consultations/:id/note', async (req, res) => {
    const consultation = await editable(req, res, 'note:draft');
    if (!consultation) return;
    if (['preparing', 'ready'].includes(transcription.status())) throw new StoreError('GPU_BUSY', '다른 상담을 기록하는 중에는 일지를 다시 만들 수 없습니다.', 409);
    await postProcess.regenerate(consultation.id);
    res.status(202).json(await store.getConsultation(consultation.id));
  });
  router.put('/consultations/:id/note', async (req, res) => {
    const consultation = await editable(req, res, 'note:draft');
    if (!consultation) return;
    if (!consultation.note) throw new StoreError('NOT_FOUND', '일지가 없습니다.', 404);
    const edited = noteSchema.parse(req.body);
    const { note, problems } = normalizeEditedNote(edited, consultation.note, consultation, await store.getCase(consultation.caseId));
    if (problems.length) throw new StoreError('NOTE_EVIDENCE', problems.join(' '));
    res.json(await store.updateConsultation(consultation.id, current => ({ ...current, note })));
  });
  router.post('/consultations/:id/approve', async (req, res) => {
    const consultation = await editable(req, res, 'note:draft');
    if (!consultation) return;
    if (!consultation.note) throw new StoreError('NOT_FOUND', '일지가 없습니다.', 404);
    const note = { ...consultation.note, aiObservations: reviewedObservationClaims(consultation.scenes), approvedAt: new Date(now()).toISOString() };
    const problems = approvalProblems(note);
    if (problems.length) throw new StoreError('NOTE_BLOCKED', problems.join(' '), 409);
    const updated = await store.updateConsultation(consultation.id, current => ({ ...transition(current, 'approve', now()), note }));
    notify?.(updated); res.json(updated);
  });
  router.get('/consultations/:id/delivery', async (req, res) => {
    const consultation = await consultationFor(req, res, 'delivery:read');
    if (!consultation) return;
    if (consultation.state !== 'approved' || !consultation.note) throw new StoreError('NOT_FOUND', '아직 확정된 상담일지가 없습니다.', 404);
    res.json({ note: deliveryOf(consultation.note), scenes: citedScenes(consultation) });
  });

  const errors: ErrorRequestHandler = (error, _req, res, next) => {
    if (error instanceof StoreError) res.status(error.status).json({ error: error.message, code: error.code });
    else if (error instanceof TransitionError) res.status(409).json({ error: error.message, code: 'STATE' });
    else if (error instanceof z.ZodError) res.status(400).json({ error: '입력 내용을 확인해 주세요.', code: 'INPUT' });
    else next(error);
  };
  router.use(errors);
  return router;
}
