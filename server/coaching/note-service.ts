import type { Consultation } from '../../src/domain/coaching.ts';
import { assembleNote, buildNoteSource, emptyNote, uncited, type BehaviorEntry, type Claim, type CoachingNote, type CoachingTask, type NoteLine, type NoteSource, type NoteViolation, type RawNote } from '../../src/domain/coaching-note.ts';
import type { LlmProvider } from '../ai/llm/types.ts';
import { buildNoteRequest, buildSummaryRequest, RawNoteSchema, RawSummarySchema } from './note-prompt.ts';
import { noteSchema } from './note-schema.ts';

// About five minutes of talk. Measured on a thirty minute consultation, parts of fifteen minutes lost a fifth of the facts and a third of the tasks.
const PART_CHARACTERS = 1500;
const OVERLAP_CHARACTERS = 200;
const SMALL_TAIL_CHARACTERS = 300;
type CaseInfo = { petName: string; guardianName: string; trainerName: string };
const DEFAULT_CALL_TIMEOUT_MS = 10 * 60 * 1000;
type Deps = { llm: LlmProvider; now?: () => number; callTimeoutMs?: number };
type Attempt = { note: CoachingNote; violations: NoteViolation[] };
export type Progress = (done: number, total: number) => Promise<void>;

const timeLabel = (ms: number) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
const compact = (text: string) => text.replace(/\s/g, '');
const warningFor = ({ text, reasons }: NoteViolation) => `일지에서 뺐습니다: "${text}" (${reasons.join(' ')})`;

const lengthOf = (lines: NoteLine[]) => lines.reduce((sum, line) => sum + line.evidence.quote.length, 0);

/**
 * Long conversations go through the model in parts, split by how much was said rather than by the clock,
 * and each part also reads the end of the one before so a topic that runs across a cut stays whole.
 */
function splitIntoParts(lines: NoteLine[]) {
  const parts: NoteLine[][] = [];
  let current: NoteLine[] = [];
  for (const line of lines) {
    current.push(line);
    if (lengthOf(current) >= PART_CHARACTERS) { parts.push(current); current = []; }
  }
  if (current.length && parts.length && lengthOf(current) < SMALL_TAIL_CHARACTERS) parts.at(-1)!.push(...current);
  else if (current.length) parts.push(current);
  return parts.map((own, index) => {
    const lead: NoteLine[] = [];
    for (const line of [...(parts[index - 1] ?? [])].reverse()) {
      if (lengthOf(lead) >= OVERLAP_CHARACTERS) break;
      lead.unshift(line);
    }
    return { from: own[0].evidence.startMs, to: own.at(-1)!.evidence.endMs, lines: [...lead, ...own] };
  });
}

const idsOf = (items: { evidence: Claim['evidence'] }[]) => new Set(items.flatMap(item => item.evidence.map(entry => entry.id)));

/** Parts overlap, so a later part can organize lines an earlier one already did, in other words. */
function mergeClaims(parts: Claim[][]) {
  const kept: Claim[] = [];
  for (const part of parts) {
    const cited = idsOf(kept);
    const fresh = part.filter(item => !item.evidence.every(entry => cited.has(entry.id)));
    kept.push(...fresh.filter(item => !kept.some(other => compact(other.text) === compact(item.text))));
  }
  return kept;
}

/** Of two tasks from the same lines in different parts, the one that read more of the conversation is the whole task. */
function mergeTasks(parts: CoachingTask[][]) {
  let kept: CoachingTask[] = [];
  for (const part of parts) {
    const earlier = kept;
    const shares = (left: CoachingTask, right: CoachingTask) => left.evidence.some(entry => right.evidence.some(other => other.id === entry.id));
    const replaced = part.filter(task => earlier.every(other => !shares(task, other) || task.evidence.length > other.evidence.length));
    kept = [...earlier.filter(other => !replaced.some(task => shares(task, other))), ...replaced];
  }
  return kept;
}

function mergeBehaviors(parts: BehaviorEntry[][]) {
  const kept: BehaviorEntry[] = [];
  for (const part of parts) {
    const earlier = kept.flatMap(entry => [...entry.context, ...entry.behavior, ...entry.response]);
    const cited = idsOf(earlier);
    const fresh = (claims: Claim[]) => claims.filter(item => !item.evidence.every(entry => cited.has(entry.id)));
    for (const entry of part) {
      const trimmed = { ...entry, context: fresh(entry.context), behavior: fresh(entry.behavior), response: fresh(entry.response) };
      if (!trimmed.context.length && !trimmed.behavior.length && !trimmed.response.length) continue;
      const same = kept.find(other => compact(other.title) === compact(entry.title));
      if (same) Object.assign(same, { context: [...same.context, ...trimmed.context], behavior: [...same.behavior, ...trimmed.behavior], response: [...same.response, ...trimmed.response], unknown: same.unknown.filter(item => entry.unknown.includes(item)) });
      else kept.push(trimmed);
    }
  }
  return kept;
}

function merge(notes: CoachingNote[], source: NoteSource, createdAt: string, warnings: string[]): CoachingNote {
  const sections = { summary: mergeClaims(notes.map(note => note.summary)), concerns: mergeClaims(notes.map(note => note.concerns)), behaviors: mergeBehaviors(notes.map(note => note.behaviors)),
    guardianReports: mergeClaims(notes.map(note => note.guardianReports)), trainerObservations: mergeClaims(notes.map(note => note.trainerObservations)), aiObservations: [],
    guidance: mergeClaims(notes.map(note => note.guidance)), tasks: mergeTasks(notes.map(note => note.tasks)), followUps: mergeClaims(notes.map(note => note.followUps)) };
  return { version: 2, ...sections, safetyFlags: [...new Set(notes.flatMap(note => note.safetyFlags))], methodReview: notes.some(note => note.methodReview), uncitedSegmentIds: uncited(sections, source), createdAt, warnings };
}

/** Adds what a repair fixed to what the first answer already got right. Only exact repeats are dropped, since a fix may rest on the same line. */
function withRepairs(first: CoachingNote, repaired: CoachingNote, source: NoteSource): CoachingNote {
  const add = <T extends { text: string }>(kept: T[], more: T[]) => [...kept, ...more.filter(item => !kept.some(other => compact(other.text) === compact(item.text)))];
  const behaviors = first.behaviors.map(entry => ({ ...entry }));
  for (const entry of repaired.behaviors) {
    const same = behaviors.find(other => compact(other.title) === compact(entry.title));
    if (same) Object.assign(same, { context: add(same.context, entry.context), behavior: add(same.behavior, entry.behavior), response: add(same.response, entry.response) });
    else behaviors.push(entry);
  }
  const sections = { summary: add(first.summary, repaired.summary), concerns: add(first.concerns, repaired.concerns), behaviors, guardianReports: add(first.guardianReports, repaired.guardianReports),
    trainerObservations: add(first.trainerObservations, repaired.trainerObservations), aiObservations: first.aiObservations, guidance: add(first.guidance, repaired.guidance), tasks: add(first.tasks, repaired.tasks), followUps: add(first.followUps, repaired.followUps) };
  return { ...first, ...sections, safetyFlags: [...new Set([...first.safetyFlags, ...repaired.safetyFlags])], methodReview: first.methodReview || repaired.methodReview, uncitedSegmentIds: uncited(sections, source) };
}

/** A sentence counts as fixed when the repair added one to its section, so one warning remains for each sentence still missing. */
function stillWrong(violations: NoteViolation[], repaired: CoachingNote) {
  const addedTo = (section: string) => {
    const [head, field] = section.split('.') as [keyof CoachingNote, 'context' | 'behavior' | 'response' | 'title' | undefined];
    if (head !== 'behaviors') return (repaired[head] as unknown[]).length;
    return field === 'title' || !field ? repaired.behaviors.length : repaired.behaviors.flatMap(entry => entry[field]).length;
  };
  const fixed = new Map<string, number>();
  return violations.filter(({ section }) => {
    const used = fixed.get(section) ?? 0;
    if (used >= addedTo(section)) return true;
    fixed.set(section, used + 1);
    return false;
  });
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
    const first = await attempt() ?? await attempt();
    if (!first?.violations.length) return first;
    // Only what failed goes back, so a retry takes seconds and cannot lose what the first answer got right.
    const repair = await attempt(first.violations);
    if (!repair) return first;
    return { note: withRepairs(first.note, repair.note, source), violations: stillWrong(first.violations, repair.note) };
  }

  async function summarize(notes: CoachingNote, source: NoteSource, petName: string, createdAt: string, signal?: AbortSignal) {
    const aliasOf = new Map(source.lines.map(line => [`${line.evidence.kind}:${line.evidence.id}`, line.alias]));
    const statement = (item: { text: string; evidence: Claim['evidence'] }) => ({ text: item.text, aliases: item.evidence.map(entry => aliasOf.get(`${entry.kind}:${entry.id}`)!) });
    const behaviors = notes.behaviors.flatMap(entry => [...entry.context, ...entry.behavior, ...entry.response]);
    const statements = [...notes.concerns, ...behaviors, ...notes.guardianReports, ...notes.guidance, ...notes.tasks].map(statement);
    if (!statements.length) return null;
    const raw = await ask({ ...buildSummaryRequest(petName, statements), signal }, json => RawSummarySchema.parse(json));
    if (!raw) return null;
    return assembleNote({ summary: raw.summary, concerns: [], behaviors: [], guardianReports: [], trainerObservations: [], guidance: [], tasks: [], followUps: [], safetyFlags: [], methodReview: false }, source, createdAt).note.summary;
  }

  return {
    /** Never throws for a bad answer: the trainer gets a blank form and the whole transcript instead. Cancellation still throws. */
    async generate(consultation: Consultation, info: CaseInfo, signal?: AbortSignal, onProgress?: Progress): Promise<CoachingNote> {
      signal?.throwIfAborted();
      const createdAt = new Date(now()).toISOString();
      const source = buildNoteSource(consultation, info);
      const note = await compose(source, info, createdAt, signal, onProgress);
      // Whatever the model did, what comes back must be something the store can keep, or the review would open with nothing.
      return noteSchema.safeParse(note).success ? note : emptyNote(source, createdAt, ['일지 초안의 형식이 맞지 않아 빈 양식을 만들었습니다. 전사를 보고 직접 작성해 주세요.']);
    },
  };

  async function compose(source: NoteSource, info: CaseInfo, createdAt: string, signal?: AbortSignal, onProgress?: Progress): Promise<CoachingNote> {
      if (!source.lines.length) return emptyNote(source, createdAt, ['받아쓴 발화가 없어 빈 양식을 만들었습니다.']);
      const parts = splitIntoParts(source.lines);
      const attempts: Attempt[] = []; const warnings: string[] = [];
      for (const [index, part] of parts.entries()) {
        await onProgress?.(index, parts.length);
        const attempt = await organize(part.lines, source, info.petName, createdAt, signal);
        if (attempt) attempts.push(attempt);
        else warnings.push(`${timeLabel(part.from)}부터 ${timeLabel(part.to)}까지 일지로 정리하지 못했습니다. 전사를 확인해 주세요.`);
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
