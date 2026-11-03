import express from 'express';
import type { ErrorRequestHandler, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { setConsent, transition, TransitionError } from '../../src/domain/coaching.ts';
import type { CoachingCase, Consultation, Speaker } from '../../src/domain/coaching.ts';
import { can } from '../../src/domain/permissions.ts';
import type { Action, Actor } from '../../src/domain/permissions.ts';
import { iceConfig, type TurnConfig } from '../turn.ts';
import type { GuardianSessions } from './guardian-session.ts';
import { StoreError, type CoachingStore } from './store.ts';

export const GUARDIAN_COOKIE = 'hanggo_guardian';
type Headers = { cookie?: string };

export type CoachingDeps = {
  store: CoachingStore; sessions: GuardianSessions; turn: TurnConfig; secureCookies: boolean;
  /** Password session check owned by the app. */
  isTrainer: (headers: Headers) => boolean;
  /** Tells connected participants that consultation state changed. */
  notify?: (consultation: Consultation) => void;
  now?: () => number;
};

const name = z.string().trim().min(1).max(200);
const CaseInput = z.object({ petName: name, guardianName: name, trainerName: name }).strict();
const JoinInput = z.object({ token: z.string().min(1).max(200) }).strict();
const ConsentInput = z.object({ value: z.boolean() }).strict();

const publicCase = ({ inviteHash: _inviteHash, inviteExpiresAt: _inviteExpiresAt, guardianGeneration: _generation, ...shared }: CoachingCase) => shared;
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
  const { store, sessions, notify, now = Date.now } = deps;
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
    res.json({ ...publicCase(await store.getCase(id)), consultations: await store.listConsultations(id) });
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

  async function consultationFor(req: Request, res: Response, action: Action) {
    const consultation = await store.getConsultation(param(req, 'id'));
    return allowed(req, res, action, consultation.caseId) ? consultation : null;
  }
  router.get('/consultations/:id', async (req, res) => {
    const consultation = await consultationFor(req, res, 'case:read');
    if (consultation) res.json(consultation);
  });
  router.get('/consultations/:id/ice', async (req, res) => {
    if (await consultationFor(req, res, 'call:join')) res.json(iceConfig(deps.turn));
  });
  router.post('/consultations/:id/consent', async (req, res) => {
    const consultation = await consultationFor(req, res, 'consent:set');
    if (!consultation) return;
    const { value } = ConsentInput.parse(req.body);
    const updated = await store.updateConsultation(consultation.id, current => setConsent(current, roleOf(actorOf(req)), value, now()));
    notify?.(updated); res.json(updated);
  });
  router.post('/consultations/:id/end', async (req, res) => {
    const consultation = await consultationFor(req, res, 'consultation:end');
    if (!consultation) return;
    // Nothing to post-process until transcription arrives, so ending goes straight to review.
    const updated = await store.updateConsultation(consultation.id, current => transition(transition(current, 'end', now()), 'processed', now()));
    notify?.(updated); res.json(updated);
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
