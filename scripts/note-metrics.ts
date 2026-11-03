import { numbersSupported } from '../src/domain/korean-numbers.ts';

type Spellings = string[];
type Segment = { id: string; speaker: string; startMs: number; endMs: number; text: string };
export type GoldenDialogue = {
  id: string; segments: Segment[];
  /** Every group must match, and any spelling in a group counts. */
  expectedFacts: { id: string; any: Spellings[] }[];
  expectedTasks: { id: string; any: Spellings[]; who: Spellings; frequency: Spellings; until: Spellings }[];
  unknown: string[]; expectedSafetyFlags: string[]; expectedMethodReview: boolean; forbiddenClaims: string[];
};
type Claim = { text: string; evidence: string[] };
type Task = { text: string; who: string | null; frequency: string | null; until: string | null; evidence: string[] };
type Note = { tasks?: Task[]; behaviors?: { title?: string; context?: Claim[]; behavior?: Claim[]; response?: Claim[] }[]; safetyFlags?: string[]; methodReview?: boolean } & Record<string, unknown>;

const CLAIM_SECTIONS = ['summary', 'concerns', 'guardianReports', 'trainerObservations', 'aiObservations', 'guidance', 'followUps'];
const compact = (text: string) => text.replace(/\s/g, '');
const includes = (text: string, spellings: Spellings) => spellings.some(spelling => compact(text).includes(compact(spelling)));

function claimsOf(note: Note): Claim[] {
  const direct = CLAIM_SECTIONS.flatMap(section => Array.isArray(note[section]) ? note[section] as Claim[] : []);
  const nested = (note.behaviors ?? []).flatMap(item => [...(item.context ?? []), ...(item.behavior ?? []), ...(item.response ?? [])]);
  return [...direct, ...nested];
}

export function collectNoteText(note: Note): string[] {
  return [...claimsOf(note).map(claim => claim.text), ...(note.behaviors ?? []).map(item => item.title ?? ''),
    ...(note.tasks ?? []).flatMap(task => [task.text, task.who ?? '', task.frequency ?? '', task.until ?? ''])].filter(Boolean);
}

const empty = { valid: false, factRecall: 0, taskRecall: null, taskFieldRecall: null, inventedTasks: 0, unsupportedNumbers: [] as string[], forbiddenHits: [] as string[], invalidEvidence: 0, safetyRecall: null, extraSafetyFlags: [] as string[], methodReviewMatch: false, missedFacts: [] as string[] };

export function scoreNote(dialogue: GoldenDialogue, raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty;
  const note = raw as Note;
  const joined = collectNoteText(note).join('\n');
  const missedFacts = dialogue.expectedFacts.filter(fact => !fact.any.every(group => includes(joined, group))).map(fact => fact.id);
  const tasks = note.tasks ?? [];
  const taskText = (task: Task) => [task.text, task.who, task.frequency, task.until].filter(Boolean).join(' ');
  const matched = dialogue.expectedTasks.map(expected => ({ expected, task: tasks.find(task => expected.any.every(group => includes(taskText(task), group))) }));
  const fields = matched.flatMap(({ expected, task }) => task ? [includes(`${task.who ?? ''} ${task.text}`, expected.who), includes(`${task.frequency ?? ''} ${task.text}`, expected.frequency), includes(`${task.until ?? ''} ${task.text}`, expected.until)] : []);
  const segments = new Map(dialogue.segments.map(segment => [segment.id, segment.text]));
  const evidenced = [...claimsOf(note), ...tasks.map(task => ({ text: taskText(task), evidence: task.evidence }))];
  const unsupportedNumbers = evidenced.flatMap(claim => numbersSupported(claim.text, (claim.evidence ?? []).map(id => segments.get(id) ?? '')).map(String));
  const invalidEvidence = evidenced.flatMap(claim => claim.evidence ?? []).filter(id => !segments.has(id)).length;
  const flags = note.safetyFlags ?? [];
  return {
    valid: true,
    factRecall: dialogue.expectedFacts.length ? (dialogue.expectedFacts.length - missedFacts.length) / dialogue.expectedFacts.length : 1,
    taskRecall: dialogue.expectedTasks.length ? matched.filter(item => item.task).length / dialogue.expectedTasks.length : null,
    taskFieldRecall: fields.length ? fields.filter(Boolean).length / fields.length : null,
    inventedTasks: Math.max(0, tasks.length - matched.filter(item => item.task).length),
    unsupportedNumbers, invalidEvidence,
    forbiddenHits: dialogue.forbiddenClaims.filter(claim => includes(joined, [claim])),
    safetyRecall: dialogue.expectedSafetyFlags.length ? dialogue.expectedSafetyFlags.filter(flag => flags.includes(flag)).length / dialogue.expectedSafetyFlags.length : null,
    extraSafetyFlags: flags.filter(flag => !dialogue.expectedSafetyFlags.includes(flag)),
    methodReviewMatch: note.methodReview === dialogue.expectedMethodReview,
    missedFacts,
  };
}
