import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { newConsultation, transition } from '../../src/domain/coaching.ts';
import type { CoachingCase, Consultation, TaskLog } from '../../src/domain/coaching.ts';
import type { SavedOwnerLog } from '../../src/domain/workspace-types.ts';
import { noteSchema, sceneSchema } from './note-schema.ts';

export class StoreError extends Error {
  readonly code: string; readonly status: number;
  constructor(code: string, message: string, status = 400) { super(message); this.code = code; this.status = status; }
}

const INVITE_MS = 7 * 24 * 60 * 60 * 1000;
const NO_INVITE = '';
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const name = z.string().trim().min(1).max(200);
const caseSchema = z.object({ id: z.uuid(), petName: name, guardianName: name, trainerName: name, createdAt: z.string(), inviteHash: z.string(), inviteExpiresAt: z.string(), guardianGeneration: z.number().int().min(0) }).strict();
const speaker = z.enum(['guardian', 'trainer']);
const segmentSchema = z.object({ id: z.uuid(), speaker, startMs: z.number().min(0), endMs: z.number().min(0), text: z.string(), originalText: z.string(), state: z.enum(['queued', 'complete', 'failed']),
  echoSuspect: z.boolean().optional(), model: z.string().optional(), latencyMs: z.number().optional() }).strict();
const momentSchema = z.object({ id: z.uuid(), atMs: z.number().min(0), createdBy: speaker, text: z.string().optional(), frameIds: z.array(z.uuid()) }).strict();
const frameSchema = z.object({ id: z.uuid(), atMs: z.number().min(0), source: z.enum(['camera', 'screen']), speaker, bytes: z.number().int().min(0) }).strict();
const consultationSchema = z.object({ id: z.uuid(), caseId: z.uuid(), createdAt: z.string(), state: z.enum(['scheduled', 'live', 'processing', 'review', 'approved', 'interrupted']),
  recording: z.boolean(), consent: z.object({ guardian: z.boolean(), trainer: z.boolean() }),
  startedAt: z.number().optional(), endedAt: z.number().optional(), recordingStartedAt: z.number().optional(),
  recordingGaps: z.array(z.object({ startMs: z.number(), endMs: z.number().optional() })), errors: z.array(z.object({ code: z.string(), message: z.string() })),
  // Records written before transcription existed have none of these.
  segments: z.array(segmentSchema).default([]), moments: z.array(momentSchema).default([]), frames: z.array(frameSchema).default([]),
  scenes: z.array(sceneSchema).default([]), note: noteSchema.optional(), noteGenerating: z.boolean().optional() }).strict();

const taskLogSchema: z.ZodType<TaskLog> = z.object({ id: z.uuid(), caseId: z.uuid(), consultationId: z.uuid(), taskId: z.string().min(1).max(100), at: z.string(), status: z.enum(['done', 'partial', 'skipped']), text: z.string().max(2000).optional() }).strict();
// Saved logs were checked by validateOwnerDraft when they arrived.
const caseRecordsSchema = z.object({ taskLogs: z.array(taskLogSchema), guardianLogs: z.array(z.custom<SavedOwnerLog>()) }).strict();
const MAX_RECORDS = 5000;

export type CaseInput = Pick<CoachingCase, 'petName' | 'guardianName' | 'trainerName'>;
export type CoachingStore = {
  createCase(input: CaseInput): Promise<{ case: CoachingCase; inviteToken: string }>;
  reissueInvite(caseId: string): Promise<string>;
  redeemInvite(token: string): Promise<CoachingCase>;
  getCase(id: string): Promise<CoachingCase>;
  /** Removes the case and everything recorded under it. This cannot be undone. */
  deleteCase(id: string): Promise<void>;
  listCases(): Promise<CoachingCase[]>;
  createConsultation(caseId: string): Promise<Consultation>;
  /** One GPU serves one conversation, so only one consultation may be live at a time. */
  startConsultation(caseId: string): Promise<Consultation>;
  getConsultation(id: string): Promise<Consultation>;
  listConsultations(caseId: string): Promise<Consultation[]>;
  updateConsultation(id: string, change: (current: Consultation) => Consultation): Promise<Consultation>;
  putFrame(consultationId: string, frameId: string, bytes: Uint8Array): Promise<void>;
  readFrame(consultationId: string, frameId: string): Promise<Buffer>;
  addTaskLog(caseId: string, log: TaskLog, limit?: number): Promise<TaskLog>;
  listTaskLogs(caseId: string): Promise<TaskLog[]>;
  addGuardianLog(caseId: string, log: SavedOwnerLog, limit?: number): Promise<SavedOwnerLog>;
  listGuardianLogs(caseId: string): Promise<SavedOwnerLog[]>;
  recoverInterrupted(): Promise<void>;
};

export function createFileStore(directory: string, options: { now?: () => number } = {}): CoachingStore {
  const now = options.now ?? Date.now;
  const root = path.resolve(directory);
  let tail: Promise<unknown> = Promise.resolve();
  /** One queue for reads and writes: Windows refuses to replace a file another handle has open. */
  const queued = <T>(operation: () => Promise<T>): Promise<T> => { const result = tail.then(operation); tail = result.catch(() => {}); return result; };

  const safeId = (id: string) => { if (!/^[0-9a-f-]{36}$/.test(id)) throw new StoreError('INPUT', 'Invalid ID.'); return id; };
  const casePath = (id: string) => path.join(root, 'cases', `${safeId(id)}.json`);
  const consultationPath = (id: string) => path.join(root, 'consultations', safeId(id), 'consultation.json');
  const recordsPath = (caseId: string) => path.join(root, 'case-records', `${safeId(caseId)}.json`);
  const framePath = (id: string, frameId: string) => path.join(root, 'consultations', safeId(id), 'frames', `${safeId(frameId)}.jpg`);

  async function replace(file: string, content: string | Uint8Array) {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, { flag: 'wx' });
    try { await rename(temporary, file); } finally { await rm(temporary, { force: true }); }
  }
  const save = (file: string, value: unknown) => replace(file, JSON.stringify(value));
  const notFound = (error: NodeJS.ErrnoException): never => { if (error.code === 'ENOENT') throw new StoreError('NOT_FOUND', 'Record not found.', 404); throw error; };
  async function load<T>(file: string, schema: z.ZodType<T>): Promise<T> {
    const source = await readFile(file, 'utf8').catch(notFound);
    return schema.parse(JSON.parse(source));
  }
  const readRecords = (caseId: string) => load(recordsPath(caseId), caseRecordsSchema).catch(error => { if (error instanceof StoreError && error.code === 'NOT_FOUND') return { taskLogs: [], guardianLogs: [] }; throw error; });
  const names = (folder: string) => readdir(path.join(root, folder)).catch(error => { if (error.code === 'ENOENT') return [] as string[]; throw error; });
  const allCases = async () => Promise.all((await names('cases')).filter(file => file.endsWith('.json')).map(file => load(path.join(root, 'cases', file), caseSchema)));
  const allConsultations = async () => Promise.all((await names('consultations')).map(id => load(consultationPath(id), consultationSchema)));

  async function issue(id: string) {
    const token = randomBytes(32).toString('hex');
    return { token, inviteHash: hash(token), inviteExpiresAt: new Date(now() + INVITE_MS).toISOString(), id };
  }
  const matches = (stored: string, token: string) => stored !== NO_INVITE && timingSafeEqual(Buffer.from(stored), Buffer.from(hash(token)));

  return {
    createCase: input => queued(async () => {
      const id = randomUUID();
      const { token, inviteHash, inviteExpiresAt } = await issue(id);
      const created = caseSchema.parse({ ...input, id, createdAt: new Date(now()).toISOString(), inviteHash, inviteExpiresAt, guardianGeneration: 0 });
      await save(casePath(id), created);
      return { case: created, inviteToken: token };
    }),
    reissueInvite: caseId => queued(async () => {
      const current = await load(casePath(caseId), caseSchema);
      const { token, inviteHash, inviteExpiresAt } = await issue(caseId);
      await save(casePath(caseId), { ...current, inviteHash, inviteExpiresAt, guardianGeneration: current.guardianGeneration + 1 });
      return token;
    }),
    redeemInvite: token => queued(async () => {
      const found = (await allCases()).find(item => matches(item.inviteHash, token));
      if (!found || Date.parse(found.inviteExpiresAt) < now()) throw new StoreError('INVITE', 'Invite is invalid or expired.', 403);
      const redeemed = { ...found, inviteHash: NO_INVITE };
      await save(casePath(found.id), redeemed);
      return redeemed;
    }),
    getCase: id => queued(() => load(casePath(id), caseSchema)),
    deleteCase: id => queued(async () => {
      await load(casePath(id), caseSchema);
      const consultations = (await allConsultations()).filter(item => item.caseId === id);
      if (consultations.some(item => item.state === 'live' || item.state === 'processing')) throw new StoreError('ACTIVE_CONSULTATION', 'A consultation of this case is still running.', 409);
      for (const item of consultations) await rm(path.dirname(consultationPath(item.id)), { recursive: true, force: true });
      await rm(recordsPath(id), { force: true });
      // Last, so a failure part way leaves a case the trainer can see and delete again.
      await rm(casePath(id), { force: true });
    }),
    listCases: () => queued(allCases),
    createConsultation: caseId => queued(async () => {
      await load(casePath(caseId), caseSchema);
      const created = newConsultation({ id: randomUUID(), caseId, createdAt: new Date(now()).toISOString() });
      await save(consultationPath(created.id), created);
      return created;
    }),
    startConsultation: caseId => queued(async () => {
      await load(casePath(caseId), caseSchema);
      if ((await allConsultations()).some(item => item.state === 'live' || item.state === 'processing')) throw new StoreError('ACTIVE_CONSULTATION', 'Another consultation is live or still being organized.', 409);
      const started = transition(newConsultation({ id: randomUUID(), caseId, createdAt: new Date(now()).toISOString() }), 'start', now());
      await save(consultationPath(started.id), started);
      return started;
    }),
    getConsultation: id => queued(() => load(consultationPath(id), consultationSchema)),
    listConsultations: caseId => queued(async () => (await allConsultations()).filter(item => item.caseId === caseId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))),
    updateConsultation: (id, change) => queued(async () => {
      const next = consultationSchema.parse(change(await load(consultationPath(id), consultationSchema)));
      await save(consultationPath(id), next);
      return next;
    }),
    putFrame: (consultationId, frameId, bytes) => queued(() => replace(framePath(consultationId, frameId), bytes)),
    readFrame: (consultationId, frameId) => queued(() => readFile(framePath(consultationId, frameId)).catch(notFound)),
    addTaskLog: (caseId, log, limit = MAX_RECORDS) => queued(async () => {
      const records = await readRecords(caseId);
      if (records.taskLogs.length >= limit) throw new StoreError('RECORD_LIMIT', '저장할 수 있는 기록 수를 넘었습니다.', 429);
      await save(recordsPath(caseId), { ...records, taskLogs: [...records.taskLogs, log] });
      return log;
    }),
    listTaskLogs: caseId => queued(async () => (await readRecords(caseId)).taskLogs),
    addGuardianLog: (caseId, log, limit = MAX_RECORDS) => queued(async () => {
      const records = await readRecords(caseId);
      if (records.guardianLogs.length >= limit) throw new StoreError('RECORD_LIMIT', '저장할 수 있는 기록 수를 넘었습니다.', 429);
      await save(recordsPath(caseId), { ...records, guardianLogs: [...records.guardianLogs, log] });
      return log;
    }),
    listGuardianLogs: caseId => queued(async () => (await readRecords(caseId)).guardianLogs),
    recoverInterrupted: () => queued(async () => {
      for (const item of await allConsultations()) {
        if (item.noteGenerating) { const { noteGenerating: _noteGenerating, ...rest } = item; await save(consultationPath(item.id), rest); }
        if (item.state === 'live' || item.state === 'processing') await save(consultationPath(item.id), {
        // Queued audio lived in memory, so those windows can no longer be transcribed.
        ...transition(item, 'interrupt', now()), segments: item.segments.map(segment => segment.state === 'queued' ? { ...segment, state: 'failed' } : segment) });
      }
    }),
  };
}
