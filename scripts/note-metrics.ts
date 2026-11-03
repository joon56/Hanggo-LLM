import type { CoachingNote, CoachingTask, Claim as Claim_ } from '../src/domain/coaching-note.ts';
import { numbersSupported } from '../src/domain/korean-numbers.ts';

type Spellings = string[];
type Segment = { id: string; speaker: string; startMs: number; endMs: number; text: string };
export type GoldenDialogue = {
  id: string; segments: Segment[];
  /** Every group must match, and any spelling in a group counts. */
  expectedFacts: { id: string; any: Spellings[] }[];
  /** Null means the dialogue never states the field, so the note must leave it empty. */
  expectedTasks: { id: string; any: Spellings[]; who: Spellings | null; frequency: Spellings | null; until: Spellings | null }[];
  unknown: string[]; expectedSafetyFlags: string[]; expectedMethodReview: boolean; forbiddenClaims: string[];
  /** A fact that must land in a section because of who said it. */
  attributions?: { section: string; any: Spellings[] }[];
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
  const fields = matched.flatMap(({ expected, task }) => task ? [includes(`${task.who ?? ''} ${task.text}`, expected.who ?? []), includes(`${task.frequency ?? ''} ${task.text}`, expected.frequency ?? []), includes(`${task.until ?? ''} ${task.text}`, expected.until ?? [])] : []);
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


/** Scores the finished note, whose evidence already holds quotes. Tasks match one to one, so a merged task cannot answer two expectations. */
export function scoreDelivered(dialogue: GoldenDialogue, note: CoachingNote) {
  const sections: Claim_[] = [...note.summary, ...note.concerns, ...note.guardianReports, ...note.trainerObservations, ...note.guidance, ...note.followUps, ...note.behaviors.flatMap(item => [...item.context, ...item.behavior, ...item.response])];
  const taskText = (task: CoachingTask) => [task.text, task.who, task.frequency, task.until, task.successCriteria].filter(Boolean).join(' ');
  const joined = [...sections.map(item => item.text), ...note.behaviors.map(item => item.title), ...note.tasks.map(taskText)].join('\n');
  const missedFacts = dialogue.expectedFacts.filter(fact => !fact.any.every(group => includes(joined, group))).map(fact => fact.id);
  const remaining = [...note.tasks];
  const matched = dialogue.expectedTasks.map(expected => {
    const index = remaining.findIndex(task => expected.any.every(group => includes(taskText(task), group)) && (!expected.who || includes(taskText(task), expected.who)));
    const fallback = index >= 0 ? index : remaining.findIndex(task => expected.any.every(group => includes(taskText(task), group)));
    return { expected, task: fallback >= 0 ? remaining.splice(fallback, 1)[0] : undefined };
  });
  const field = (spellings: Spellings | null, value: string | null, text: string) => spellings ? includes(`${value ?? ''} ${text}`, spellings) : value === null;
  const fields = matched.flatMap(({ expected, task }) => task ? [field(expected.who, task.who, task.text), field(expected.frequency, task.frequency, task.text), field(expected.until, task.until, task.text)] : []);
  const unsupported = [...sections, ...note.tasks.map(task => ({ text: [task.text, task.frequency].filter(Boolean).join(' '), evidence: task.evidence }))]
    .flatMap(item => numbersSupported(item.text, item.evidence.map(entry => entry.quote)));
  const attributions = dialogue.attributions ?? [];
  const inSection = (section: string) => (note[section as 'guidance'] ?? []).map((item: Claim_) => item.text).join('\n');
  return {
    factRecall: dialogue.expectedFacts.length ? (dialogue.expectedFacts.length - missedFacts.length) / dialogue.expectedFacts.length : 1, missedFacts,
    taskRecall: dialogue.expectedTasks.length ? matched.filter(item => item.task).length / dialogue.expectedTasks.length : null,
    taskFieldRecall: fields.length ? fields.filter(Boolean).length / fields.length : null,
    inventedTasks: remaining.length, unsupportedNumbers: unsupported.length,
    forbiddenHits: dialogue.forbiddenClaims.filter(claim => includes(joined, [claim])),
    safetyRecall: dialogue.expectedSafetyFlags.length ? dialogue.expectedSafetyFlags.filter(flag => note.safetyFlags.includes(flag)).length / dialogue.expectedSafetyFlags.length : null,
    extraSafetyFlags: note.safetyFlags.filter(flag => !dialogue.expectedSafetyFlags.includes(flag)),
    methodReviewMatch: note.methodReview === dialogue.expectedMethodReview,
    attributionRecall: attributions.length ? attributions.filter(item => item.any.every(group => includes(inSection(item.section), group))).length / attributions.length : null,
    emptied: !!note.fallbackUsed, dropped: note.warnings.length, uncited: note.uncitedSegmentIds.length,
  };
}

export function aggregateScores(scores: ReturnType<typeof scoreDelivered>[]) {
  const mean = (values: (number | null)[]) => { const known = values.filter((value): value is number => value !== null); return known.length ? known.reduce((sum, value) => sum + value, 0) / known.length : null; };
  return {
    dialogues: scores.length,
    factRecall: mean(scores.map(score => score.factRecall)), taskRecall: mean(scores.map(score => score.taskRecall)), taskFieldRecall: mean(scores.map(score => score.taskFieldRecall)),
    safetyRecall: mean(scores.map(score => score.safetyRecall)), attributionRecall: mean(scores.map(score => score.attributionRecall)),
    inventedTasks: scores.reduce((sum, score) => sum + score.inventedTasks, 0), unsupportedNumbers: scores.reduce((sum, score) => sum + score.unsupportedNumbers, 0),
    forbiddenHits: scores.reduce((sum, score) => sum + score.forbiddenHits.length, 0), extraSafetyFlags: scores.reduce((sum, score) => sum + score.extraSafetyFlags.length, 0),
    methodReviewMismatch: scores.filter(score => !score.methodReviewMatch).length, emptied: scores.filter(score => score.emptied).length,
  };
}
