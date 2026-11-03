import { z } from 'zod';
import type { CoachingNote, Scene } from '../../src/domain/coaching-note.ts';

const id = z.string().min(1).max(100);
const evidence = z.object({ kind: z.enum(['segment', 'moment', 'scene']), id, quote: z.string().max(8000), startMs: z.number().min(0), endMs: z.number().min(0), speaker: z.enum(['guardian', 'trainer']).optional() }).strict();
const claim = z.object({ id, text: z.string().max(1000), evidence: z.array(evidence).max(20), edited: z.boolean().optional() }).strict();
const claims = z.array(claim).max(100);
const field = z.string().max(300).nullable();
export const noteSchema: z.ZodType<CoachingNote> = z.object({
  version: z.literal(2), summary: claims, concerns: claims,
  behaviors: z.array(z.object({ id, title: z.string().max(200), context: claims, behavior: claims, response: claims, unknown: z.array(z.enum(['trigger', 'frequency', 'duration', 'response'])).max(4) }).strict()).max(50),
  guardianReports: claims, trainerObservations: claims, aiObservations: claims, guidance: claims,
  tasks: z.array(z.object({ id, text: z.string().max(1000), who: field, frequency: field, until: field, successCriteria: field, evidence: z.array(evidence).max(20), edited: z.boolean().optional() }).strict()).max(50),
  followUps: claims, safetyFlags: z.array(z.string().max(100)).max(50), dismissedFlags: z.array(z.string().max(100)).max(50).optional(), methodReview: z.boolean(), uncitedSegmentIds: z.array(id).max(5000),
  createdAt: z.string().max(100), approvedAt: z.string().max(100).optional(), fallbackUsed: z.boolean().optional(), warnings: z.array(z.string().max(2000)).max(500),
}).strict();
export const sceneSchema: z.ZodType<Scene> = z.object({
  id, atMs: z.number().min(0), frameIds: z.array(id).max(8), state: z.enum(['complete', 'failed']),
  observations: z.array(z.object({ id, text: z.string().max(1000), originalText: z.string().max(1000), reviewed: z.boolean() }).strict()).max(50),
}).strict();
