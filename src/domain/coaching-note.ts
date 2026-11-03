import { similarity, type Consultation, type Speaker } from './coaching.ts';
import { extractNumbers, numbersSupported } from './korean-numbers.ts';
import { flagsFromSource, mentionsForcefulMethod, SAFETY_LABELS } from './notes.ts';
import type { BriefConsultationContext } from './workspace-types.ts';

export type Evidence = { kind: 'segment' | 'moment' | 'scene'; id: string; quote: string; startMs: number; endMs: number; speaker?: Speaker };
export type Claim = { id: string; text: string; evidence: Evidence[]; edited?: boolean };
export type UnknownField = 'trigger' | 'frequency' | 'duration' | 'response';
export type BehaviorEntry = { id: string; title: string; context: Claim[]; behavior: Claim[]; response: Claim[]; unknown: UnknownField[] };
export type CoachingTask = { id: string; text: string; who: string | null; frequency: string | null; until: string | null; successCriteria: string | null; evidence: Evidence[]; edited?: boolean };
export type CoachingNote = {
  version: 2; summary: Claim[]; concerns: Claim[]; behaviors: BehaviorEntry[]; guardianReports: Claim[]; trainerObservations: Claim[]; aiObservations: Claim[]; guidance: Claim[]; tasks: CoachingTask[]; followUps: Claim[];
  safetyFlags: string[];
  /** Flags the trainer marked as not applying. They stay on record, but the guardian is not warned about them. */
  dismissedFlags?: string[];
  methodReview: boolean; uncitedSegmentIds: string[]; createdAt: string; approvedAt?: string; fallbackUsed?: boolean; warnings: string[];
};
export type Observation = { id: string; text: string; originalText: string; reviewed: boolean };
export type Scene = { id: string; atMs: number; frameIds: string[]; observations: Observation[]; state: 'complete' | 'failed' };

export type RawClaim = { text: string; evidence: string[] };
export type RawTask = { text: string; who: string | null; frequency: string | null; until: string | null; successCriteria: string | null; evidence: string[] };
export type RawBehavior = { title: string; context: RawClaim[]; behavior: RawClaim[]; response: RawClaim[]; unknown: UnknownField[] };
export type RawNote = { summary: RawClaim[]; concerns: RawClaim[]; behaviors: RawBehavior[]; guardianReports: RawClaim[]; trainerObservations: RawClaim[]; guidance: RawClaim[]; tasks: RawTask[]; followUps: RawClaim[]; safetyFlags: string[]; methodReview: boolean };
export type NoteLine = { alias: string; evidence: Evidence };
export type NoteSource = { lines: NoteLine[]; names: string[] };
export type NoteViolation = { section: string; text: string; reasons: string[] };
type CaseInfo = { petName: string; guardianName: string; trainerName: string };

const CLAIM_SECTIONS = ['summary', 'concerns', 'guardianReports', 'trainerObservations', 'aiObservations', 'guidance', 'followUps'] as const;
const REQUIRED_SPEAKER: Partial<Record<string, { speaker: Speaker; name: string }>> = {
  guardianReports: { speaker: 'guardian', name: '보호자' }, guidance: { speaker: 'trainer', name: '훈련사' },
  trainerObservations: { speaker: 'trainer', name: '훈련사' }, tasks: { speaker: 'trainer', name: '훈련사' },
};
const BANNED = /진단|치료|완치|처방|증상\s*판정|정확도|효과\s*보장|반드시\s*(?:좋아|낫|나아)|확실히|문제견|나쁜\s*개|공격견|사나운\s*개|좋아[지진질져졌]|개선[되된될됐]|나아[지진질져졌]|호전|이\s*품종은\s*원래|분리불안|관절염|슬개골|골절|디스크|치매|피부염|장염|췌장염|강박증|불안장애/g;
const NAME = /([가-힣]{2,4})\s?(?:님|씨)/g;
const SURNAMES = '김이박최정강조윤장임한오서신권황안송류전홍고문양손배백허유남심노하곽성차주우구민진지엄채원천방공현함변염여추도소석선설마길연위표명기반왕금옥육인맹제모탁국어은편용';
// A surname and two syllables, because a title also follows ordinary words, as in 짖는다고 보호자가.
const NAME_BEFORE_TITLE = new RegExp(`(?<![가-힣])([${SURNAMES}][가-힣]{2})\\s(?:선생님|훈련사|수의사|원장)`, 'g');
// Titles and everyday words that end the way a name with an honorific does.
const NOT_A_NAME = /(?:보호자|훈련사|선생|기사|수의사|원장|사장|고객|손|어머|아버|남편|아내|따|아드|아저|아가|날|솜|말|맵|글|마음|시|사모)$/;
// Ordinary words that can sit right before a title without being anyone's name.
const NOT_A_NAME_BEFORE_TITLE = /^(?:반려견|동물병원)$|[은는이가을를의에도로만요고며면서다]$/;
const ALIAS_MARKER = /\s*[[(]\s*[sm]\d{1,3}(?:\s*,\s*[sm]\d{1,3})*\s*[\])]/g;
const MIN_CLAIM_SUPPORT = 0.3;
const MIN_OWN_SUPPORT = 0.15;
const MIN_FIELD_SUPPORT = 0.6;
// Stricter than a citation the model chose, since here the code is the one choosing.
const MIN_FOUND_SUPPORT = 0.5;
const MAX_ADDED_LINES = 2;
const REPEAT_SIMILARITY = 0.6;
const MAX_LINES_AWAY = 6;
const PLAIN_TITLE = '행동 기록';
// Pointing these out as unused would only hide the lines that might matter.
const NOTHING_TO_REPORT = /\?$|말씀해\s*주세요\.?$|^안녕하세요|^네[,.\s]+(?:알겠습니다|그렇군요|맞아요)?\.?$|감사합니다\.?$/;
const NEGATION = /않|없|못|아니|안\s|말[고아]|마세/;
const newId = () => crypto.randomUUID();

const pairsOf = (text: string) => {
  const clean = text.replace(/[^\p{L}]/gu, '');
  return Array.from({ length: Math.max(0, clean.length - 1) }, (_, index) => clean.slice(index, index + 2));
};
/** How much of a sentence comes from its evidence. A rewritten sentence reuses the words; an invented one does not. */
function supportOf(text: string, sources: string[]) {
  const pairs = pairsOf(text);
  if (pairs.length < 3) return 1;
  const known = new Set(sources.flatMap(pairsOf));
  return pairs.filter(pair => known.has(pair)).length / pairs.length;
}
export const bannedIn = (text: string) => [...new Set(text.match(BANNED) ?? [])];

export function buildNoteSource(consultation: Pick<Consultation, 'segments' | 'moments'>, info: CaseInfo): NoteSource {
  const spoken = consultation.segments.filter(segment => segment.state === 'complete' && !segment.echoSuspect && segment.text.trim());
  const memos = consultation.moments.filter(moment => moment.text?.trim());
  const alias = (prefix: string, index: number) => `${prefix}${String(index + 1).padStart(2, '0')}`;
  return { names: [info.petName, info.guardianName, info.trainerName], lines: [
    ...spoken.map((segment, index): NoteLine => ({ alias: alias('s', index), evidence: { kind: 'segment', id: segment.id, quote: segment.text, startMs: segment.startMs, endMs: segment.endMs, speaker: segment.speaker } })),
    ...memos.map((moment, index): NoteLine => ({ alias: alias('m', index), evidence: { kind: 'moment', id: moment.id, quote: moment.text!, startMs: moment.atMs, endMs: moment.atMs, speaker: 'trainer' } })),
  ] };
}

/** A short answer only means something with its question, so a sentence may use the question's words. Numbers still have to be in the answer. */
function linesBefore(evidence: Evidence[], source: NoteSource) {
  return evidence.flatMap(item => {
    const at = source.lines.findIndex(line => line.evidence.kind === item.kind && line.evidence.id === item.id);
    return at > 0 ? [source.lines[at - 1].evidence.quote] : [];
  });
}

/** Mostly the cited lines, so a sentence cannot rest on the words of whoever spoke just before. */
function wellSupported(text: string, evidence: Evidence[], source: NoteSource) {
  const quotes = evidence.map(item => item.quote);
  return supportOf(text, [...quotes, ...source.names]) >= MIN_OWN_SUPPORT && supportOf(text, [...quotes, ...linesBefore(evidence, source), ...source.names]) >= MIN_CLAIM_SUPPORT;
}

/**
 * Models often cite the line that says "please do it" and not the line that says what to do. When the words really are
 * in what that person said, the record can point there itself instead of losing a true sentence. Numbers are checked afterward.
 */
function withSupportingLines(section: string, text: string, evidence: Evidence[], source: NoteSource) {
  const quotes = evidence.map(item => item.quote);
  if (!evidence.length || supportOf(text, [...quotes, ...source.names]) >= MIN_CLAIM_SUPPORT || numbersSupported(text, quotes).length) return evidence;
  const required = REQUIRED_SPEAKER[section];
  const cited = evidence.map(item => source.lines.findIndex(line => line.evidence.id === item.id));
  const usable = (quote: string) => quote.split(/(?<=[.?!])\s*/).filter(sentence => NEGATION.test(sentence) === NEGATION.test(text)).join(' ');
  // What the same person said nearby, in sentences that do not say the opposite. A question is not a statement of what it asks about.
  const nearby = source.lines.filter((line, at) => line.evidence.kind === 'segment' && evidence.some(item => item.speaker === line.evidence.speaker) && (!required || line.evidence.speaker === required.speaker)
    && cited.some(index => Math.abs(index - at) <= MAX_LINES_AWAY) && !cited.includes(at)).map(line => ({ item: line.evidence, words: usable(line.evidence.quote) }));
  const kept = [...evidence];
  const known = [...quotes];
  const wanted = pairsOf(text);
  for (let added = 0; added < MAX_ADDED_LINES; added += 1) {
    const covered = new Set(known.flatMap(pairsOf));
    const missing = new Set(wanted.filter(pair => !covered.has(pair)));
    const gain = (words: string) => new Set(pairsOf(words).filter(pair => missing.has(pair))).size;
    const best = nearby.filter(({ item }) => !kept.includes(item)).sort((left, right) => gain(right.words) - gain(left.words))[0];
    if (!best || !gain(best.words)) break;
    kept.push(best.item); known.push(best.words);
    if (supportOf(text, known) >= MIN_FOUND_SUPPORT) return kept.sort((left, right) => left.startMs - right.startMs);
  }
  return evidence;
}

function problemsWith(section: string, text: string, evidence: Evidence[], source: NoteSource) {
  if (!evidence.length) return ['근거 발화가 없습니다.'];
  const quotes = evidence.map(item => item.quote);
  const reasons: string[] = [];
  const numbers = numbersSupported(text, quotes);
  if (numbers.length) reasons.push(`근거에 없는 숫자입니다: ${numbers.join(', ')}`);
  const names = [...text.matchAll(NAME), ...text.matchAll(NAME_BEFORE_TITLE)].map(match => match[1]).filter(name => !NOT_A_NAME.test(name) && !NOT_A_NAME_BEFORE_TITLE.test(name) && ![...quotes, ...source.names].some(known => known.includes(name)));
  if (names.length) reasons.push(`근거에 없는 이름입니다: ${names.join(', ')}`);
  // A guardian may relay what someone told them. Anywhere else the note would be making the claim itself.
  const banned = bannedIn(text).filter(word => section !== 'guardianReports' || !quotes.some(quote => quote.includes(word)));
  if (banned.length) reasons.push(`금지 표현입니다: ${banned.join(', ')}`);
  if (!wellSupported(text, evidence, source)) reasons.push('문장이 근거와 거의 겹치지 않습니다.');
  return reasons;
}

function evidenceFor(section: string, aliases: string[], source: NoteSource) {
  const found = aliases.map(alias => source.lines.find(line => line.alias === alias)?.evidence).filter((item): item is Evidence => !!item);
  const required = REQUIRED_SPEAKER[section];
  // A memo was never said aloud, so it can back the trainer's own observation but not guidance or a task.
  const allowed = required ? found.filter(item => item.speaker === required.speaker && (section === 'trainerObservations' || item.kind === 'segment')) : found;
  return { evidence: allowed, wrongSpeaker: !!required && found.length > 0 && !allowed.length ? required.name : '' };
}

function supportedField(value: string | null, quotes: string[]) {
  const text = value?.trim();
  if (!text) return null;
  if (numbersSupported(text, quotes).length) return null;
  // Numbers are spelled differently from the transcript, so a supported count is enough on its own.
  return /\d/.test(text) || supportOf(text, quotes) >= MIN_FIELD_SUPPORT ? text : null;
}

function citedSegmentIds(note: Pick<CoachingNote, typeof CLAIM_SECTIONS[number] | 'behaviors' | 'tasks'>) {
  const claims = [...CLAIM_SECTIONS.flatMap(section => note[section]), ...note.behaviors.flatMap(item => [...item.context, ...item.behavior, ...item.response]), ...note.tasks];
  return new Set(claims.flatMap(claim => claim.evidence).filter(item => item.kind === 'segment').map(item => item.id));
}
export const uncited = (note: Parameters<typeof citedSegmentIds>[0], source: NoteSource) => {
  const cited = citedSegmentIds(note);
  return source.lines.filter(line => line.evidence.kind === 'segment' && !cited.has(line.evidence.id) && !NOTHING_TO_REPORT.test(line.evidence.quote.trim())).map(line => line.evidence.id);
};
const said = (source: NoteSource, kind: Evidence['kind']) => source.lines.filter(line => line.evidence.kind === kind).map(line => line.evidence.quote).join('\n');
/** From what was said aloud. A private memo must not surface as a warning to the guardian. */
const ruleSafetyFlags = (source: NoteSource) => flagsFromSource(said(source, 'segment'));
const ruleMethodReview = (source: NoteSource) => source.lines.some(line => mentionsForcefulMethod(line.evidence.quote));
const plain = (text: string) => text.replace(/[^\p{L}\p{N}]/gu, '');
const sortedNumbers = (text: string) => String(extractNumbers(text).sort());
/** Close in wording, and neither negates the other nor counts differently, which a few changed letters can do. */
export const sameFact = (left: string, right: string, threshold = REPEAT_SIMILARITY) =>
  similarity(plain(left), plain(right)) >= threshold && NEGATION.test(left) === NEGATION.test(right) && sortedNumbers(left) === sortedNumbers(right);

/** Sentences come from the model, but citations and times always come from the record, and anything unsupported is left out. */
export function assembleNote(raw: RawNote, source: NoteSource, createdAt: string) {
  const violations: NoteViolation[] = [];
  const reject = (section: string, text: string, reasons: string[]) => { violations.push({ section, text, reasons }); };
  const claims = (section: string, items: RawClaim[]): Claim[] => items.flatMap(item => {
    const text = item.text.replace(ALIAS_MARKER, '').trim();
    // The schema names the word "unknown", and a model sometimes writes it as a sentence.
    if (!text || /^unknown$/i.test(text)) return [];
    const { evidence: cited, wrongSpeaker } = evidenceFor(section, item.evidence, source);
    const evidence = withSupportingLines(section, text, cited, source);
    const reasons = wrongSpeaker ? [`${wrongSpeaker} 발화를 근거로 써야 합니다.`] : problemsWith(section, text, evidence, source);
    if (reasons.length) { reject(section, text, reasons); return []; }
    return [{ id: newId(), text, evidence }];
  });
  const behaviors = raw.behaviors.flatMap((item): BehaviorEntry[] => {
    const entry = { id: newId(), title: item.title.trim(), context: claims('behaviors.context', item.context), behavior: claims('behaviors.behavior', item.behavior), response: claims('behaviors.response', item.response), unknown: [...new Set(item.unknown)] };
    const evidenceInEntry = [...entry.context, ...entry.behavior, ...entry.response].flatMap(claim => claim.evidence);
    if (!evidenceInEntry.length) return [];
    // The sentences stand on their own evidence, so a bad title costs only the title. Models also file whole sections under their field names.
    const titleProblems = problemsWith('behaviors.title', entry.title, evidenceInEntry, source).filter(reason => !reason.startsWith('문장이'));
    return [{ ...entry, title: /[가-힣]/.test(entry.title) && !titleProblems.length ? entry.title : PLAIN_TITLE }];
  });
  const tasks = raw.tasks.flatMap((item): CoachingTask[] => {
    const text = item.text.replace(ALIAS_MARKER, '').trim();
    if (!text) return [];
    const { evidence: cited, wrongSpeaker } = evidenceFor('tasks', item.evidence, source);
    const evidence = withSupportingLines('tasks', text, cited, source);
    const reasons = wrongSpeaker ? [`${wrongSpeaker} 발화를 근거로 써야 합니다.`] : problemsWith('tasks', text, evidence, source);
    if (reasons.length) { reject('tasks', text, reasons); return []; }
    const quotes = evidence.map(entry => entry.quote);
    return [{ id: newId(), text, who: supportedField(item.who, quotes), frequency: supportedField(item.frequency, quotes), until: supportedField(item.until, quotes), successCriteria: supportedField(item.successCriteria, quotes), evidence }];
  });
  const underBehaviors = behaviors.flatMap(entry => [...entry.context, ...entry.behavior, ...entry.response]);
  const fresh = (items: Claim[]) => items.filter(item => !underBehaviors.some(other => sameFact(other.text, item.text)));
  const sections = { summary: claims('summary', raw.summary), concerns: claims('concerns', raw.concerns), behaviors, guardianReports: fresh(claims('guardianReports', raw.guardianReports)),
    trainerObservations: fresh(claims('trainerObservations', raw.trainerObservations)), aiObservations: [] as Claim[], guidance: claims('guidance', raw.guidance), tasks, followUps: claims('followUps', raw.followUps) };
  const spokenFlags = ruleSafetyFlags(source);
  const memoOnlyFlags = flagsFromSource(said(source, 'moment')).filter(flag => !spokenFlags.includes(flag));
  const note: CoachingNote = { version: 2, ...sections,
    // Rules and the model can each raise a flag. Neither can lower one.
    safetyFlags: [...new Set([...spokenFlags, ...raw.safetyFlags.filter(flag => SAFETY_LABELS.includes(flag) && !memoOnlyFlags.includes(flag))])],
    methodReview: raw.methodReview || ruleMethodReview(source),
    uncitedSegmentIds: uncited(sections, source), createdAt, warnings: [] };
  return { note, violations };
}

export function emptyNote(source: NoteSource, createdAt: string, warnings: string[]): CoachingNote {
  const sections = { summary: [], concerns: [], behaviors: [], guardianReports: [], trainerObservations: [], aiObservations: [], guidance: [], tasks: [], followUps: [] };
  return { version: 2, ...sections, safetyFlags: ruleSafetyFlags(source), methodReview: ruleMethodReview(source), uncitedSegmentIds: uncited(sections, source), createdAt, fallbackUsed: true, warnings };
}

/** A person's edit is trusted for wording, but evidence is looked up again so a request cannot forge a quote or a time. */
export function normalizeEditedNote(edited: CoachingNote, before: CoachingNote, consultation: Pick<Consultation, 'segments' | 'moments' | 'scenes'>, info: CaseInfo) {
  const source = buildNoteSource(consultation, info);
  const known = new Map(source.lines.map(line => [`${line.evidence.kind}:${line.evidence.id}`, line.evidence]));
  for (const scene of consultation.scenes) for (const observation of scene.observations) known.set(`scene:${scene.id}`, { kind: 'scene', id: scene.id, quote: observation.text, startMs: scene.atMs, endMs: scene.atMs });
  const problems: string[] = [];
  const earlier = new Map([...CLAIM_SECTIONS.flatMap(section => before[section]), ...before.behaviors.flatMap(item => [...item.context, ...item.behavior, ...item.response]), ...before.tasks].map(item => [item.id, item]));
  const lookup = (evidence: Evidence[]) => evidence.flatMap(item => {
    const found = known.get(`${item.kind}:${item.id}`);
    if (!found) problems.push(`근거를 찾을 수 없습니다: ${item.id}`);
    return found ? [found] : [];
  });
  const evidenceKey = (evidence: Evidence[]) => evidence.map(item => `${item.kind}:${item.id}`).sort().join();
  const changed = (item: { id: string; text: string; evidence: Evidence[] }, extra = false) => {
    const previous = earlier.get(item.id);
    return !previous || previous.text !== item.text || evidenceKey(previous.evidence) !== evidenceKey(item.evidence) || extra;
  };
  const claim = (item: Claim): Claim => {
    const previous = earlier.get(item.id);
    const edited_ = changed(item) || previous?.edited;
    return { id: previous ? item.id : newId(), text: item.text.trim(), evidence: lookup(item.evidence), ...(edited_ ? { edited: true } : {}) };
  };
  const claims = (items: Claim[]) => items.filter(item => item.text.trim()).map(claim);
  const behaviors = edited.behaviors.filter(item => item.title.trim()).map((item): BehaviorEntry => ({ id: before.behaviors.some(entry => entry.id === item.id) ? item.id : newId(), title: item.title.trim(), context: claims(item.context), behavior: claims(item.behavior), response: claims(item.response), unknown: item.unknown }));
  const tasks = edited.tasks.filter(item => item.text.trim()).map((item): CoachingTask => {
    const previous = earlier.get(item.id) as CoachingTask | undefined;
    const fieldsChanged = !!previous && (['who', 'frequency', 'until', 'successCriteria'] as const).some(field => previous[field] !== item[field]);
    const edited_ = changed(item, fieldsChanged) || previous?.edited;
    return { id: previous ? item.id : newId(), text: item.text.trim(), who: item.who, frequency: item.frequency, until: item.until, successCriteria: item.successCriteria, evidence: lookup(item.evidence), ...(edited_ ? { edited: true } : {}) };
  });
  const sections = { summary: claims(edited.summary), concerns: claims(edited.concerns), behaviors, guardianReports: claims(edited.guardianReports), trainerObservations: claims(edited.trainerObservations),
    aiObservations: before.aiObservations, guidance: claims(edited.guidance), tasks, followUps: claims(edited.followUps) };
  const { approvedAt: _approvedAt, ...kept } = before;
  // A corrected transcript can reveal a signal. Nothing here can remove one.
  const safetyFlags = [...new Set([...before.safetyFlags, ...ruleSafetyFlags(source)])];
  const note: CoachingNote = { ...kept, ...sections, safetyFlags, methodReview: before.methodReview || ruleMethodReview(source), uncitedSegmentIds: uncited(sections, source),
    dismissedFlags: (edited.dismissedFlags ?? []).filter(flag => safetyFlags.includes(flag)) };
  return { note, problems };
}

/** A guardian may relay what someone told them, so their reports only count when the evidence used the same word. */
export function approvalProblems(note: CoachingNote) {
  const problems: string[] = [];
  const check = (text: string, quotes: string[] = []) => {
    const banned = bannedIn(text).filter(word => !quotes.some(quote => quote.includes(word)));
    if (banned.length) problems.push(`금지 표현을 고쳐 주세요: ${banned.join(', ')} (${text})`);
  };
  for (const section of CLAIM_SECTIONS) for (const claim of note[section]) check(claim.text, section === 'guardianReports' ? claim.evidence.map(item => item.quote) : []);
  for (const entry of note.behaviors) { check(entry.title); for (const claim of [...entry.context, ...entry.behavior, ...entry.response]) check(claim.text); }
  for (const task of note.tasks) for (const text of [task.text, task.who, task.frequency, task.until, task.successCriteria]) if (text) check(text);
  // A sentence nobody rewrote still has to match its evidence, which may have been corrected since it was drafted.
  const unedited: { text: string; evidence: Evidence[]; edited?: boolean }[] = [...CLAIM_SECTIONS.flatMap(section => note[section]), ...note.behaviors.flatMap(entry => [...entry.context, ...entry.behavior, ...entry.response]), ...note.tasks];
  for (const claim of unedited) {
    if (claim.edited || !claim.evidence.length) continue;
    if (numbersSupported(claim.text, claim.evidence.map(item => item.quote)).length) problems.push(`고친 전사와 숫자가 맞지 않습니다: ${claim.text}`);
  }
  for (const task of note.tasks) {
    if (task.edited || !task.evidence.length) continue;
    for (const field of [task.who, task.frequency, task.until, task.successCriteria]) if (field && numbersSupported(field, task.evidence.map(item => item.quote)).length) problems.push(`고친 전사와 숫자가 맞지 않습니다: ${field}`);
  }
  return problems;
}

export function reviewedObservationClaims(scenes: Scene[]): Claim[] {
  return scenes.flatMap(scene => scene.observations.filter(item => item.reviewed && item.text.trim()).map((item): Claim => ({ id: item.id, text: item.text, evidence: [{ kind: 'scene', id: scene.id, quote: item.text, startMs: scene.atMs, endMs: scene.atMs }] })));
}

export type NoteDelivery = Pick<CoachingNote, 'summary' | 'concerns' | 'behaviors' | 'guardianReports' | 'trainerObservations' | 'aiObservations' | 'guidance' | 'tasks' | 'followUps' | 'safetyFlags'> & { approvedAt: string };

/** What the guardian receives. Method concerns and the trainer's private memos stay out, including inside quotes. */
export function deliveryOf(note: CoachingNote): NoteDelivery {
  const evidence = (items: Evidence[]) => items.filter(item => item.kind !== 'moment' && !mentionsForcefulMethod(item.quote));
  const memoOnly = (item: { evidence: Evidence[] }) => item.evidence.length > 0 && item.evidence.every(entry => entry.kind === 'moment');
  const claims = (items: Claim[]) => items.filter(item => !mentionsForcefulMethod(item.text) && !memoOnly(item)).map(item => ({ ...item, evidence: evidence(item.evidence) }));
  const field = (value: string | null) => value && mentionsForcefulMethod(value) ? null : value;
  const behaviors = note.behaviors.map(item => ({ ...item, context: claims(item.context), behavior: claims(item.behavior), response: claims(item.response) })).filter(item => !mentionsForcefulMethod(item.title) && (item.context.length || item.behavior.length || item.response.length));
  const tasks = note.tasks.filter(item => !mentionsForcefulMethod(item.text) && !memoOnly(item)).map(item => ({ ...item, who: field(item.who), frequency: field(item.frequency), until: field(item.until), successCriteria: field(item.successCriteria), evidence: evidence(item.evidence) }));
  return { summary: claims(note.summary), concerns: claims(note.concerns), behaviors, guardianReports: claims(note.guardianReports), trainerObservations: claims(note.trainerObservations), aiObservations: claims(note.aiObservations), guidance: claims(note.guidance), tasks, followUps: claims(note.followUps), safetyFlags: note.safetyFlags.filter(flag => !note.dismissedFlags?.includes(flag)), approvedAt: note.approvedAt! };
}

const taskDescription = (task: CoachingTask) => {
  const fields = ([['담당', task.who], ['횟수', task.frequency], ['기한', task.until], ['성공 기준', task.successCriteria]] as const).filter(([, value]) => value).map(([label, value]) => `${label} ${value}`);
  return fields.length ? `${task.text} (${fields.join(', ')})` : task.text;
};

/** What the next brief reads from a confirmed note. The case ties sessions together, so nothing is matched by name. */
export function briefContextOf(consultation: Consultation, info: CaseInfo, timeZone: string): BriefConsultationContext {
  const note = consultation.note!;
  const evidence = (items: Evidence[]) => items.map(item => ({ kind: item.kind === 'moment' ? 'bookmark' as const : item.kind === 'scene' ? 'vision' as const : 'segment' as const, quote: item.quote, startMs: item.startMs, endMs: item.endMs }));
  const claims = (items: Claim[], category: string) => items.map(item => ({ id: item.id, text: item.text, category, evidence: evidence(item.evidence) }));
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(consultation.createdAt));
  const date = ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-');
  return { id: consultation.id, date, petName: info.petName, trainerName: info.trainerName, revision: note.approvedAt!, approvedAt: note.approvedAt!, omittedItems: 0, items: [
    ...note.tasks.map(task => ({ id: task.id, text: taskDescription(task), category: 'task', evidence: evidence(task.evidence) })),
    ...claims(note.summary, 'purpose'), ...claims(note.concerns, 'purpose'), ...claims(note.followUps, 'follow_up'), ...claims(note.guardianReports, 'owner_report'),
    ...claims(note.trainerObservations, 'observation'), ...claims(note.aiObservations, 'observation'), ...claims(note.guidance, 'guidance'),
  ] };
}
