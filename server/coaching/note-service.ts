import type { Consultation } from '../../src/domain/coaching.ts';
import { assembleNote, buildNoteSource, emptyNote, uncited, type Claim, type CoachingNote, type NoteLine, type NoteSource, type NoteViolation, type RawNote } from '../../src/domain/coaching-note.ts';
import type { LlmProvider } from '../ai/llm/types.ts';
import { buildNoteRequest, buildSummaryRequest, RawNoteSchema, RawSummarySchema } from './note-prompt.ts';
import { noteSchema } from './note-schema.ts';

const CHUNK_MS = 15 * 60 * 1000;
type CaseInfo = { petName: string; guardianName: string; trainerName: string };
const DEFAULT_CALL_TIMEOUT_MS = 10 * 60 * 1000;
type Deps = { llm: LlmProvider; now?: () => number; callTimeoutMs?: number };
type Attempt = { note: CoachingNote; violations: NoteViolation[] };

const timeLabel = (ms: number) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
const compact = (text: string) => text.replace(/\s/g, '');
const warningFor = ({ text, reasons }: NoteViolation) => `일지에서 뺐습니다: "${text}" (${reasons.join(' ')})`;

/** Long conversations go through the model in parts, because one prompt cannot hold them and still leave room to answer. */
function splitByTime(lines: NoteLine[]) {
  const parts = new Map<number, NoteLine[]>();
  for (const line of lines) {
    const index = Math.floor(line.evidence.startMs / CHUNK_MS);
    parts.set(index, [...(parts.get(index) ?? []), line]);
  }
  return [...parts.entries()].sort(([left], [right]) => left - right).map(([index, part]) => ({ startMs: index * CHUNK_MS, lines: part }));
}

function mergeClaims(parts: Claim[][]) {
  const seen = new Set<string>();
  return parts.flat().filter(item => { const key = compact(item.text); if (seen.has(key)) return false; seen.add(key); return true; });
}

function merge(notes: CoachingNote[], source: NoteSource, createdAt: string, warnings: string[]): CoachingNote {
  const sections = { summary: mergeClaims(notes.map(note => note.summary)), concerns: mergeClaims(notes.map(note => note.concerns)), behaviors: notes.flatMap(note => note.behaviors),
    guardianReports: mergeClaims(notes.map(note => note.guardianReports)), trainerObservations: mergeClaims(notes.map(note => note.trainerObservations)), aiObservations: [],
    guidance: mergeClaims(notes.map(note => note.guidance)), tasks: notes.flatMap(note => note.tasks), followUps: mergeClaims(notes.map(note => note.followUps)) };
  return { version: 2, ...sections, safetyFlags: [...new Set(notes.flatMap(note => note.safetyFlags))], methodReview: notes.some(note => note.methodReview), uncitedSegmentIds: uncited(sections, source), createdAt, warnings };
}

export function createNoteService({ llm, now = Date.now, callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS }: Deps) {
  async function ask<T>(request: Parameters<LlmProvider['structured']>[0], parse: (json: unknown) => T): Promise<T | null> {
    // A model that stops answering must not leave the consultation stuck, so each call has a limit of its own.
    const limit = AbortSignal.timeout(callTimeoutMs);
    try {
      const { json, finished } = await llm.structured({ ...request, signal: request.signal ? AbortSignal.any([request.signal, limit]) : limit });
      return finished && json !== null ? parse(json) : null;
    } catch (error) {
      if (request.signal?.aborted) throw error;
      return null;
    }
  }

  async function organize(lines: NoteLine[], source: NoteSource, petName: string, createdAt: string, signal?: AbortSignal): Promise<Attempt | null> {
    const attempt = async (problems: NoteViolation[] = []): Promise<Attempt | null> => {
      const raw = await ask<RawNote>({ ...buildNoteRequest(petName, lines, problems), signal }, json => RawNoteSchema.parse(json));
      return raw && assembleNote(raw, source, createdAt);
    };
    const first = await attempt();
    if (first && !first.violations.length) return first;
    const second = await attempt(first?.violations);
    if (!first || !second) return second ?? first;
    return second.violations.length <= first.violations.length ? second : first;
  }

  async function summarize(notes: CoachingNote, source: NoteSource, petName: string, createdAt: string, signal?: AbortSignal) {
    const aliasOf = new Map(source.lines.map(line => [`${line.evidence.kind}:${line.evidence.id}`, line.alias]));
    const statement = (item: { text: string; evidence: Claim['evidence'] }) => ({ text: item.text, aliases: item.evidence.map(entry => aliasOf.get(`${entry.kind}:${entry.id}`)!) });
    const statements = [...notes.concerns, ...notes.guardianReports, ...notes.guidance, ...notes.tasks].map(statement);
    if (!statements.length) return null;
    const raw = await ask({ ...buildSummaryRequest(petName, statements), signal }, json => RawSummarySchema.parse(json));
    if (!raw) return null;
    return assembleNote({ summary: raw.summary, concerns: [], behaviors: [], guardianReports: [], trainerObservations: [], guidance: [], tasks: [], followUps: [], safetyFlags: [], methodReview: false }, source, createdAt).note.summary;
  }

  return {
    /** Never throws for a bad answer: the trainer gets a blank form and the whole transcript instead. Cancellation still throws. */
    async generate(consultation: Consultation, info: CaseInfo, signal?: AbortSignal): Promise<CoachingNote> {
      signal?.throwIfAborted();
      const createdAt = new Date(now()).toISOString();
      const source = buildNoteSource(consultation, info);
      const note = await compose(consultation, source, info, createdAt, signal);
      // Whatever the model did, what comes back must be something the store can keep, or the review would open with nothing.
      return noteSchema.safeParse(note).success ? note : emptyNote(source, createdAt, ['일지 초안의 형식이 맞지 않아 빈 양식을 만들었습니다. 전사를 보고 직접 작성해 주세요.']);
    },
  };

  async function compose(_consultation: Consultation, source: NoteSource, info: CaseInfo, createdAt: string, signal?: AbortSignal): Promise<CoachingNote> {
      if (!source.lines.length) return emptyNote(source, createdAt, ['받아쓴 발화가 없어 빈 양식을 만들었습니다.']);
      const parts = splitByTime(source.lines);
      const attempts: Attempt[] = []; const warnings: string[] = [];
      for (const part of parts) {
        const attempt = await organize(part.lines, source, info.petName, createdAt, signal);
        if (attempt) attempts.push(attempt);
        else warnings.push(`${timeLabel(part.startMs)}부터 ${timeLabel(part.startMs + CHUNK_MS)}까지 일지로 정리하지 못했습니다. 전사를 확인해 주세요.`);
      }
      if (!attempts.length) return emptyNote(source, createdAt, ['일지 초안을 만들지 못했습니다. 전사를 보고 직접 작성해 주세요.']);
      warnings.push(...attempts.flatMap(attempt => attempt.violations.map(warningFor)));
      const note = merge(attempts.map(attempt => attempt.note), source, createdAt, warnings);
      if (parts.length === 1) return note;
      const summary = await summarize(note, source, info.petName, createdAt, signal);
      if (!summary) return { ...note, summary: [], warnings: [...warnings, '전체 요약을 만들지 못했습니다.'] };
      const summarized = { ...note, summary };
      return { ...summarized, uncitedSegmentIds: uncited(summarized, source) };
  }
}
