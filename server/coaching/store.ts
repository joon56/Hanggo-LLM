import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { newConsultation, transition } from '../../src/domain/coaching.ts';
import type { CoachingCase, Consultation } from '../../src/domain/coaching.ts';

export class StoreError extends Error {
  readonly code: string; readonly status: number;
  constructor(code: string, message: string, status = 400) { super(message); this.code = code; this.status = status; }
}

const INVITE_MS = 7 * 24 * 60 * 60 * 1000;
const NO_INVITE = '';
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const name = z.string().trim().min(1).max(200);
const caseSchema = z.object({ id: z.uuid(), petName: name, guardianName: name, trainerName: name, createdAt: z.string(), inviteHash: z.string(), inviteExpiresAt: z.string(), guardianGeneration: z.number().int().min(0) }).strict();
const consultationSchema = z.object({ id: z.uuid(), caseId: z.uuid(), createdAt: z.string(), state: z.enum(['scheduled', 'live', 'processing', 'review', 'approved', 'interrupted']),
  recording: z.boolean(), consent: z.object({ guardian: z.boolean(), trainer: z.boolean() }),
  startedAt: z.number().optional(), endedAt: z.number().optional(), recordingStartedAt: z.number().optional(),
  recordingGaps: z.array(z.object({ startMs: z.number(), endMs: z.number().optional() })), errors: z.array(z.object({ code: z.string(), message: z.string() })) }).strict();

export type CaseInput = Pick<CoachingCase, 'petName' | 'guardianName' | 'trainerName'>;
export type CoachingStore = {
  createCase(input: CaseInput): Promise<{ case: CoachingCase; inviteToken: string }>;
  reissueInvite(caseId: string): Promise<string>;
  redeemInvite(token: string): Promise<CoachingCase>;
  getCase(id: string): Promise<CoachingCase>;
  listCases(): Promise<CoachingCase[]>;
  createConsultation(caseId: string): Promise<Consultation>;
  getConsultation(id: string): Promise<Consultation>;
  listConsultations(caseId: string): Promise<Consultation[]>;
  updateConsultation(id: string, change: (current: Consultation) => Consultation): Promise<Consultation>;
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

  async function save(file: string, value: unknown) {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value), { flag: 'wx' });
    try { await rename(temporary, file); } finally { await rm(temporary, { force: true }); }
  }
  async function load<T>(file: string, schema: z.ZodType<T>): Promise<T> {
    const source = await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') throw new StoreError('NOT_FOUND', 'Record not found.', 404); throw error; });
    return schema.parse(JSON.parse(source));
  }
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
    listCases: () => queued(allCases),
    createConsultation: caseId => queued(async () => {
      await load(casePath(caseId), caseSchema);
      const created = newConsultation({ id: randomUUID(), caseId, createdAt: new Date(now()).toISOString() });
      await save(consultationPath(created.id), created);
      return created;
    }),
    getConsultation: id => queued(() => load(consultationPath(id), consultationSchema)),
    listConsultations: caseId => queued(async () => (await allConsultations()).filter(item => item.caseId === caseId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))),
    updateConsultation: (id, change) => queued(async () => {
      const next = consultationSchema.parse(change(await load(consultationPath(id), consultationSchema)));
      await save(consultationPath(id), next);
      return next;
    }),
    recoverInterrupted: () => queued(async () => {
      for (const item of await allConsultations()) if (item.state === 'live' || item.state === 'processing') await save(consultationPath(item.id), transition(item, 'interrupt', now()));
    }),
  };
}
