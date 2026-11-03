// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { Consultation, Segment } from './coaching.ts';
import { newConsultation } from './coaching.ts';
import { approvalProblems, assembleNote, briefContextOf, buildNoteSource, deliveryOf, emptyNote, normalizeEditedNote, reviewedObservationClaims, type CoachingNote, type Evidence, type RawNote } from './coaching-note.ts';

const segment = (id: string, speaker: Segment['speaker'], startMs: number, text: string, change: Partial<Segment> = {}): Segment => ({ id, speaker, startMs, endMs: startMs + 3000, text, originalText: text, state: 'complete', ...change });
const segments = [
  segment('a', 'guardian', 0, '택배 기사님이 초인종을 누르면 현관으로 뛰어가서 계속 짖어요. 하루에 세 번쯤 그래요.'),
  segment('b', 'trainer', 4000, '보호자님이 하루 두 번, 한 번에 삼 분씩 매트로 가는 연습을 다음 상담까지 해 주세요.'),
  segment('c', 'guardian', 8000, '네, 아침이랑 저녁에 해 볼게요.'),
  segment('d', 'guardian', 12000, '메아리로 들린 문장입니다', { echoSuspect: true }),
  segment('e', 'trainer', 16000, '', { state: 'failed' }),
];
function consultation(change: Partial<Consultation> = {}): Consultation {
  return { ...newConsultation({ id: 'c1', caseId: 'k1', createdAt: '2026-11-04T00:00:00.000Z' }), segments, ...change };
}
const info = { petName: '초코', guardianName: '김하늘', trainerName: '이바다' };
const source = (change: Partial<Consultation> = {}) => buildNoteSource(consultation(change), info);
const blank: RawNote = { summary: [], concerns: [], behaviors: [], guardianReports: [], trainerObservations: [], guidance: [], tasks: [], followUps: [], safetyFlags: [], methodReview: false };
const claim = (text: string, ...evidence: string[]) => ({ text, evidence });
const task = (change: Partial<RawNote['tasks'][number]> = {}) => ({ text: '매트로 가는 연습', who: '보호자', frequency: '하루 두 번', until: '다음 상담', successCriteria: null, evidence: ['s02'], ...change });
const assemble = (raw: Partial<RawNote>, change: Partial<Consultation> = {}) => assembleNote({ ...blank, ...raw }, source(change), '2026-11-04T01:00:00.000Z');
const reasons = (result: ReturnType<typeof assemble>) => result.violations.flatMap(item => item.reasons).join(' / ');

describe('buildNoteSource', () => {
  it('gives short aliases only to usable speech, so echoes and failed windows cannot be cited', () => {
    const built = source();
    expect(built.lines.map(line => [line.alias, line.evidence.id])).toEqual([['s01', 'a'], ['s02', 'b'], ['s03', 'c']]);
  });
  it('adds trainer memos as evidence', () => {
    const built = source({ moments: [{ id: 'm', atMs: 5000, createdBy: 'guardian', text: '귀가 먼저 움직임', frameIds: [] }, { id: 'n', atMs: 6000, createdBy: 'guardian', frameIds: [] }] });
    expect(built.lines.at(-1)).toMatchObject({ alias: 'm01', evidence: { kind: 'moment', id: 'm', quote: '귀가 먼저 움직임', speaker: 'trainer' } });
    expect(built.lines.filter(line => line.evidence.kind === 'moment')).toHaveLength(1);
  });
  it('quotes the edited text but keeps the time from the original', () => {
    const built = buildNoteSource(consultation({ segments: [segment('a', 'guardian', 1000, '고친 문장', { originalText: '틀린 문장' })] }), info);
    expect(built.lines[0].evidence).toMatchObject({ quote: '고친 문장', startMs: 1000, endMs: 4000, speaker: 'guardian' });
  });
});

describe('assembleNote', () => {
  it('turns aliases into quoted evidence with times from the transcript', () => {
    const { note, violations } = assemble({ guardianReports: [claim('초인종이 울리면 현관으로 뛰어가 짖는다고 말함', 's01')] });
    expect(violations).toEqual([]);
    expect(note.guardianReports[0].evidence).toEqual([{ kind: 'segment', id: 'a', quote: segments[0].text, startMs: 0, endMs: 3000, speaker: 'guardian' }]);
    expect(note.guardianReports[0].id).toBeTruthy();
  });
  it('strips alias markers the model writes into sentences', () => {
    const { note } = assemble({ guardianReports: [claim('[s01] 초인종이 울리면 현관으로 뛰어가 짖는다 (s01)', 's01')] });
    expect(note.guardianReports[0].text).toBe('초인종이 울리면 현관으로 뛰어가 짖는다');
  });
  it('drops a claim without valid evidence', () => {
    const result = assemble({ summary: [claim('초인종에 짖음', 's09'), claim('근거가 비어 있는 문장')] });
    expect(result.note.summary).toEqual([]);
    expect(reasons(result)).toContain('근거');
  });
  it('rejects a number the evidence does not have, counting spellings as equal', () => {
    const fine = assemble({ guardianReports: [claim('초인종에 하루 3번쯤 짖는다', 's01')] });
    expect(fine.note.guardianReports).toHaveLength(1);
    const wrong = assemble({ guardianReports: [claim('초인종에 하루 다섯 번 짖는다', 's01')] });
    expect(wrong.note.guardianReports).toEqual([]);
    expect(reasons(wrong)).toContain('숫자');
  });
  it('rejects a name that neither the evidence nor the case has', () => {
    const wrong = assemble({ guardianReports: [claim('민수 씨가 초인종을 누르면 현관으로 뛰어가 짖는다', 's01')] });
    expect(wrong.note.guardianReports).toEqual([]);
    expect(reasons(wrong)).toContain('민수');
    const fine = assemble({ guardianReports: [claim('김하늘 님이 초인종을 누르면 현관으로 뛰어가 짖는다고 말함', 's01'), claim('택배 기사님이 초인종을 누르면 짖는다', 's01')] });
    expect(fine.note.guardianReports).toHaveLength(2);
  });
  it('holds guardian reports and guidance to the person who actually said them', () => {
    const wrong = assemble({ guardianReports: [claim('매트로 가는 연습을 한다', 's02')], guidance: [claim('현관으로 뛰어가서 짖는다', 's01')], trainerObservations: [claim('현관으로 뛰어간다', 's01')] });
    expect(wrong.note.guardianReports).toEqual([]);
    expect(wrong.note.guidance).toEqual([]);
    expect(wrong.note.trainerObservations).toEqual([]);
    expect(wrong.violations).toHaveLength(3);
  });
  it('accepts a trainer memo as a trainer observation', () => {
    const { note, violations } = assemble({ trainerObservations: [claim('귀가 먼저 움직였다', 'm01')] }, { moments: [{ id: 'm', atMs: 5000, createdBy: 'guardian', text: '귀가 먼저 움직임', frameIds: [] }] });
    expect(violations).toEqual([]);
    expect(note.trainerObservations[0].evidence[0]).toMatchObject({ kind: 'moment', id: 'm' });
  });
  it('rejects banned expressions, except a guardian relaying their own words', () => {
    for (const text of ['초코의 짖음을 치료할 수 있다', '확실히 나아질 것이다', '초코는 문제견이다', '짖음이 줄어 좋아졌다', '분리불안으로 보인다']) {
      const wrong = assemble({ summary: [claim(text, 's01')] });
      expect(wrong.note.summary, text).toEqual([]);
      expect(reasons(wrong), text).toContain('금지');
    }
    const relayed = buildNoteSource(consultation({ segments: [segment('a', 'guardian', 0, '병원에서 분리불안 진단을 받았어요')] }), info);
    const fine = assembleNote({ ...blank, guardianReports: [claim('병원에서 분리불안 진단을 받았다고 말함', 's01')], summary: [claim('분리불안 진단을 받았다', 's01')] }, relayed, 'now');
    expect(fine.note.guardianReports).toHaveLength(1);
    expect(fine.note.summary).toEqual([]);
  });
  it('rejects a sentence that shares almost nothing with its evidence', () => {
    const wrong = assemble({ concerns: [claim('사료를 바꾼 뒤 잠을 잘 못 자고 낮에 자주 운다', 's01')] });
    expect(wrong.note.concerns).toEqual([]);
    expect(reasons(wrong)).toContain('근거와');
  });
  it('checks claims inside behavior entries and keeps the entry when something survives', () => {
    const result = assemble({ behaviors: [{ title: '초인종 짖음', context: [claim('초인종을 누르면', 's01')], behavior: [claim('다섯 번 짖는다', 's01')], response: [], unknown: ['duration'] }] });
    expect(result.note.behaviors[0]).toMatchObject({ title: '초인종 짖음', unknown: ['duration'] });
    expect(result.note.behaviors[0].context).toHaveLength(1);
    expect(result.note.behaviors[0].behavior).toEqual([]);
    expect(result.violations).toHaveLength(1);
  });
  it('removes a behavior entry when nothing in it survives', () => {
    const { note } = assemble({ behaviors: [{ title: '초인종 짖음', context: [], behavior: [claim('다섯 번 짖는다', 's01')], response: [], unknown: [] }] });
    expect(note.behaviors).toEqual([]);
  });
  it('requires trainer evidence for a task', () => {
    const wrong = assemble({ tasks: [task({ evidence: ['s03'] })] });
    expect(wrong.note.tasks).toEqual([]);
    expect(reasons(wrong)).toContain('훈련사');
  });
  it('keeps task fields the evidence supports and clears the rest as unknown', () => {
    const { note } = assemble({ tasks: [task({ who: '보호자', frequency: '하루 2번', until: '다음 달까지', successCriteria: '짖지 않고 매트에 있으면 성공' })] });
    expect(note.tasks[0]).toMatchObject({ who: '보호자', frequency: '하루 2번', until: null, successCriteria: null });
  });
  it('lets a task quote its own evidence loosely but not invent a count', () => {
    const wrong = assemble({ tasks: [task({ text: '매트로 가는 연습을 열 번 한다' })] });
    expect(wrong.note.tasks).toEqual([]);
    expect(reasons(wrong)).toContain('숫자');
  });
  it('raises safety flags from the transcript even when the model missed them, and never lowers them', () => {
    const risky = buildNoteSource(consultation({ segments: [segment('a', 'guardian', 0, '뒷다리를 절뚝거리고 만지면 아파해요')] }), info);
    expect(assembleNote(blank, risky, 'now').note.safetyFlags.sort()).toEqual(['절뚝거림', '통증']);
    expect(assembleNote({ ...blank, safetyFlags: ['구토'] }, risky, 'now').note.safetyFlags.sort()).toEqual(['구토', '절뚝거림', '통증']);
    expect(assembleNote({ ...blank, safetyFlags: ['없는 신호'] }, risky, 'now').note.safetyFlags).not.toContain('없는 신호');
  });
  it('raises method review from the transcript or the model', () => {
    const risky = buildNoteSource(consultation({ segments: [segment('a', 'guardian', 0, '짖으면 코를 때렸어요')] }), info);
    expect(assembleNote(blank, risky, 'now').note.methodReview).toBe(true);
    expect(assemble({ methodReview: true }).note.methodReview).toBe(true);
    expect(assemble({}).note.methodReview).toBe(false);
  });
  it('lists speech the note did not use, so nothing silently disappears', () => {
    const { note } = assemble({ guardianReports: [claim('초인종을 누르면 현관으로 뛰어가 짖는다', 's01')] });
    expect(note.uncitedSegmentIds).toEqual(['b', 'c']);
  });
  it('does not count echoes and failed windows as uncited', () => {
    expect(assemble({}).note.uncitedSegmentIds).not.toEqual(expect.arrayContaining(['d']));
    expect(assemble({}).note.uncitedSegmentIds).not.toEqual(expect.arrayContaining(['e']));
  });
});

describe('emptyNote', () => {
  it('is a blank form that still points at the whole transcript and rule flags', () => {
    const risky = buildNoteSource(consultation({ segments: [segment('a', 'guardian', 0, '오늘 구토를 했어요')] }), info);
    const note = emptyNote(risky, 'now', ['일지 초안을 만들지 못했습니다.']);
    expect(note).toMatchObject({ version: 2, summary: [], tasks: [], fallbackUsed: true, safetyFlags: ['구토'], uncitedSegmentIds: ['a'], warnings: ['일지 초안을 만들지 못했습니다.'] });
  });
});

describe('editing and approval', () => {
  const draft = () => assemble({ guardianReports: [claim('초인종을 누르면 현관으로 뛰어가 짖는다', 's01')], tasks: [task()] }).note;
  it('marks changed sentences as edited and rebuilds evidence from the record', () => {
    const before = draft();
    const edited = structuredClone(before);
    edited.guardianReports[0].text = '초인종에 짖는다';
    edited.guardianReports[0].evidence = [{ kind: 'segment', id: 'a', quote: '꾸며낸 인용', startMs: 999, endMs: 1000, speaker: 'trainer' }];
    const { note, problems } = normalizeEditedNote(edited, before, consultation(), info);
    expect(problems).toEqual([]);
    expect(note.guardianReports[0]).toMatchObject({ edited: true, text: '초인종에 짖는다' });
    expect(note.guardianReports[0].evidence[0]).toMatchObject({ quote: segments[0].text, startMs: 0, speaker: 'guardian' });
  });
  it('leaves untouched sentences unmarked', () => {
    const before = draft();
    const { note } = normalizeEditedNote(structuredClone(before), before, consultation(), info);
    expect(note.guardianReports[0].edited).toBeUndefined();
  });
  it('accepts a sentence the trainer wrote without evidence, marked as written by hand', () => {
    const before = draft();
    const edited = structuredClone(before);
    edited.concerns.push({ id: 'new', text: '훈련사가 직접 쓴 문장', evidence: [] });
    const { note, problems } = normalizeEditedNote(edited, before, consultation(), info);
    expect(problems).toEqual([]);
    expect(note.concerns[0]).toMatchObject({ edited: true, evidence: [] });
    expect(note.concerns[0].id).not.toBe('new');
  });
  it('refuses evidence that does not exist in this consultation', () => {
    const before = draft();
    const edited = structuredClone(before);
    edited.guardianReports[0].evidence = [{ kind: 'segment', id: 'missing', quote: 'x', startMs: 0, endMs: 1 }];
    expect(normalizeEditedNote(edited, before, consultation(), info).problems).toHaveLength(1);
  });
  it('keeps safety flags, method review, and approval fields out of the trainer edit', () => {
    const risky = consultation({ segments: [segment('a', 'guardian', 0, '오늘 구토를 했어요')] });
    const before = assembleNote(blank, buildNoteSource(risky, info), 'now').note;
    const edited = { ...structuredClone(before), safetyFlags: [], methodReview: false, approvedAt: 'forged' };
    const { note } = normalizeEditedNote(edited, before, risky, info);
    expect(note.safetyFlags).toEqual(['구토']);
    expect(note.approvedAt).toBeUndefined();
  });
  it('recalculates uncited speech after an edit removes the only citation', () => {
    const before = draft();
    const edited = structuredClone(before);
    edited.guardianReports = [];
    expect(normalizeEditedNote(edited, before, consultation(), info).note.uncitedSegmentIds).toContain('a');
  });
  it('blocks approval while a banned expression remains, wherever a human typed it', () => {
    const note = draft();
    expect(approvalProblems(note)).toEqual([]);
    note.guidance.push({ id: 'x', text: '이 훈련으로 반드시 좋아집니다', evidence: [], edited: true });
    note.tasks[0].text = '치료를 위해 매일 연습';
    expect(approvalProblems(note)).toHaveLength(2);
  });
  it('turns only reviewed observations into AI claims', () => {
    const scenes = [{ id: 'scene-1', atMs: 3000, frameIds: ['f1'], state: 'complete' as const, observations: [
      { id: 'o1', text: '개가 매트 위에 앉아 있다', originalText: '개가 매트 위에 앉아 있다', reviewed: true },
      { id: 'o2', text: '개가 현관을 보고 있다', originalText: '개가 현관을 보고 있다', reviewed: false },
    ] }];
    expect(reviewedObservationClaims(scenes)).toEqual([expect.objectContaining({ text: '개가 매트 위에 앉아 있다', evidence: [expect.objectContaining({ kind: 'scene', id: 'scene-1', quote: '개가 매트 위에 앉아 있다', startMs: 3000, endMs: 3000 })] })]);
  });
});

describe('deliveryOf', () => {
  const approved = () => {
    const risky = consultation({ segments: [
      segment('a', 'guardian', 0, '짖으면 코를 때렸어요'),
      segment('b', 'trainer', 4000, '코를 때리는 대신 매트로 보내고 간식을 주세요'),
      segment('c', 'trainer', 8000, '하루 두 번 매트 연습을 해 주세요'),
    ] });
    const built = buildNoteSource(risky, info);
    return assembleNote({ ...blank, summary: [claim('매트 연습을 하기로 함', 's03')], guardianReports: [claim('짖으면 코를 때렸다고 말함', 's01')], guidance: [claim('매트로 보내고 간식을 주라고 안내함', 's02')],
      tasks: [{ text: '매트 연습', who: null, frequency: '하루 두 번', until: null, successCriteria: null, evidence: ['s03'] }] }, built, 'now').note;
  };
  it('leaves out method mentions and the review flag', () => {
    const delivery = deliveryOf({ ...approved(), approvedAt: '2026-11-04T02:00:00.000Z' });
    expect(JSON.stringify(delivery)).not.toMatch(/때리|때렸/);
    expect(delivery).not.toHaveProperty('methodReview');
    expect(delivery.summary).toHaveLength(1);
    expect(delivery.tasks).toHaveLength(1);
  });
  it('removes a quoted method mention but keeps a harmless sentence built on it', () => {
    const delivery = deliveryOf({ ...approved(), approvedAt: 'x' });
    expect(delivery.guidance).toHaveLength(1);
    expect(delivery.guidance[0].evidence).toEqual([]);
  });
  it('carries no trainer-only material', () => {
    const delivery = deliveryOf({ ...approved(), approvedAt: 'x', warnings: ['내부 경고'], trainerObservations: [{ id: 't', text: '훈련사 관찰', evidence: [] }] });
    const text = JSON.stringify(delivery);
    expect(text).not.toContain('내부 경고');
    expect(text).not.toContain('uncitedSegmentIds');
    expect(delivery).not.toHaveProperty('warnings');
  });
  it('drops trainer memo evidence, because memos stay with the trainer', () => {
    const note = approved();
    note.guidance[0].evidence = [{ kind: 'moment', id: 'm', quote: '비공개 메모', startMs: 0, endMs: 0, speaker: 'trainer' }];
    const delivery = deliveryOf({ ...note, approvedAt: 'x' });
    expect(JSON.stringify(delivery)).not.toContain('비공개 메모');
  });
  it('keeps safety flags so the guardian sees the vet notice first', () => {
    const risky = buildNoteSource(consultation({ segments: [segment('a', 'guardian', 0, '오늘 구토를 했어요')] }), info);
    expect(deliveryOf({ ...assembleNote(blank, risky, 'now').note, approvedAt: 'x' }).safetyFlags).toEqual(['구토']);
  });
});

describe('rule signals in ordinary speech', () => {
  const flagged = (text: string) => assembleNote(blank, buildNoteSource({ segments: [segment('a', 'trainer', 0, text)], moments: [] }, info), 'now').note;
  it('treats advice not to punish as advice, not a method concern', () => {
    for (const text of ['혼내지는 말아 주세요', '때리지 마세요', '혼내지 말고 기다려 주세요']) expect(flagged(text).methodReview, text).toBe(false);
    for (const text of ['짖으면 혼냈어요', '코를 때렸어요', '때린 적도 있어요', '코를 때리는 대신']) expect(flagged(text).methodReview, text).toBe(true);
  });
  it('recognizes a change in temperament and eating from how people say it', () => {
    expect(flagged('원래 순했는데 만지면 으르렁거려요').safetyFlags).toContain('갑작스러운 공격성');
    expect(flagged('갑자기 으르렁거려요').safetyFlags).toContain('갑작스러운 공격성');
    expect(flagged('낯선 개를 보면 으르렁거려요').safetyFlags).not.toContain('갑작스러운 공격성');
    expect(flagged('사료를 평소의 절반만 먹어요').safetyFlags).toContain('식욕 저하');
  });
});

describe('briefContextOf', () => {
  const approved = () => {
    const note = assemble({ summary: [claim('초인종에 짖는다', 's01')], guardianReports: [claim('초인종을 누르면 현관으로 뛰어가 짖는다', 's01')], guidance: [claim('매트로 가는 연습을 안내함', 's02')], tasks: [task()], followUps: [claim('연습을 다음 상담까지 해 달라고 함', 's02')] }).note;
    return consultation({ state: 'approved', note: { ...note, approvedAt: '2026-11-04T03:00:00.000Z' } });
  };
  it('turns a confirmed note into what the brief reads, with tasks described by their known fields', () => {
    const context = briefContextOf(approved(), info, 'Asia/Seoul');
    expect(context).toMatchObject({ id: 'c1', date: '2026-11-04', petName: '초코', trainerName: '이바다', revision: '2026-11-04T03:00:00.000Z' });
    const planned = context.items.find(item => item.category === 'task')!;
    expect(planned.text).toContain('매트로 가는 연습');
    expect(planned.text).toContain('담당 보호자');
    expect(planned.text).toContain('횟수 하루 두 번');
    expect(planned.evidence[0]).toMatchObject({ kind: 'segment', quote: segments[1].text, startMs: 4000 });
    expect(context.items.map(item => item.category)).toEqual(expect.arrayContaining(['purpose', 'owner_report', 'guidance', 'follow_up']));
  });
  it('keeps task ids so records can find their task', () => {
    const consultationRecord = approved();
    expect(briefContextOf(consultationRecord, info, 'Asia/Seoul').items.find(item => item.category === 'task')?.id).toBe(consultationRecord.note!.tasks[0].id);
  });
  it('names memos and scenes in the terms the brief knows', () => {
    const consultationRecord = approved();
    consultationRecord.note!.aiObservations = [{ id: 'o', text: '개가 매트에 앉아 있다', evidence: [{ kind: 'scene', id: 's', quote: '개가 매트에 앉아 있다', startMs: 1, endMs: 1 }] }];
    consultationRecord.note!.trainerObservations = [{ id: 'm', text: '귀가 먼저 움직임', evidence: [{ kind: 'moment', id: 'x', quote: '귀가 먼저 움직임', startMs: 2, endMs: 2, speaker: 'trainer' }] }];
    const kinds = briefContextOf(consultationRecord, info, 'Asia/Seoul').items.flatMap(item => item.evidence.map(entry => entry.kind));
    expect(kinds).toEqual(expect.arrayContaining(['vision', 'bookmark']));
  });
});

describe('what must stay with the trainer', () => {
  const said: Evidence = { kind: 'segment', id: 'b', quote: segments[1].text, startMs: 4000, endMs: 7000, speaker: 'trainer' };
  const memo: Evidence = { kind: 'moment', id: 'm', quote: '비공개 메모', startMs: 0, endMs: 0, speaker: 'trainer' };
  const approved = (change: Partial<CoachingNote>) => ({ ...assemble({}).note, approvedAt: 'x', ...change });
  it('clears a task field that mentions a forceful method', () => {
    const delivery = deliveryOf(approved({ tasks: [{ id: 't', text: '매트 연습', who: '보호자', frequency: null, until: null, successCriteria: '목줄을 세게 당기면 성공', evidence: [said] }] }));
    expect(delivery.tasks[0]).toMatchObject({ text: '매트 연습', who: '보호자', successCriteria: null });
  });
  it('leaves out sentences and tasks that rest only on a private memo', () => {
    const delivery = deliveryOf(approved({ trainerObservations: [{ id: 'o', text: '메모에만 있는 관찰', evidence: [memo] }, { id: 'p', text: '말로도 한 관찰', evidence: [memo, said] }], tasks: [{ id: 't', text: '메모에만 있는 과제', who: null, frequency: null, until: null, successCriteria: null, evidence: [memo] }] }));
    expect(delivery.trainerObservations.map(item => item.text)).toEqual(['말로도 한 관찰']);
    expect(delivery.tasks).toEqual([]);
  });
  it('keeps a sentence the trainer wrote by hand, which has no evidence to check', () => {
    const delivery = deliveryOf(approved({ guidance: [{ id: 'g', text: '훈련사가 직접 쓴 안내', evidence: [], edited: true }] }));
    expect(delivery.guidance).toHaveLength(1);
  });
  it('does not accept a memo as the evidence for a task or for guidance, because those must have been said', () => {
    const withMemo = { moments: [{ id: 'm', atMs: 5000, createdBy: 'guardian' as const, text: '매트 연습을 시키기', frameIds: [] }] };
    const result = assemble({ tasks: [task({ text: '매트 연습을 시키기', evidence: ['m01'] })], guidance: [claim('매트 연습을 시키기', 'm01')] }, withMemo);
    expect(result.note.tasks).toEqual([]);
    expect(result.note.guidance).toEqual([]);
    expect(result.violations).toHaveLength(2);
  });
});

describe('after the transcript changes', () => {
  const said = (text: string): Consultation => consultation({ segments: [segment('a', 'guardian', 0, text)] });
  const draftFrom = (record: Consultation) => assembleNote({ ...blank, guardianReports: [claim('초인종에 세 번쯤 짖는다', 's01')] }, buildNoteSource(record, info), 'now').note;
  it('picks up safety signals the correction reveals', () => {
    const note = draftFrom(said('초인종에 세 번쯤 짖어요'));
    const { note: refreshed } = normalizeEditedNote(note, note, said('초인종에 세 번쯤 짖고 오늘 구토도 했어요'), info);
    expect(refreshed.safetyFlags).toContain('구토');
  });
  it('blocks approval of a sentence its corrected evidence no longer supports', () => {
    const note = draftFrom(said('초인종에 세 번쯤 짖어요'));
    const { note: refreshed } = normalizeEditedNote(note, note, said('초인종에 두 번쯤 짖어요'), info);
    expect(refreshed.guardianReports[0].evidence[0].quote).toBe('초인종에 두 번쯤 짖어요');
    expect(approvalProblems(refreshed).join()).toContain('초인종에 세 번쯤 짖는다');
  });
  it('trusts a sentence the trainer has since rewritten', () => {
    const note = draftFrom(said('초인종에 세 번쯤 짖어요'));
    const { note: refreshed } = normalizeEditedNote(note, note, said('초인종에 두 번쯤 짖어요'), info);
    const rewritten = structuredClone(refreshed);
    rewritten.guardianReports[0].text = '초인종에 세 번 이상 짖는다고 훈련사가 확인함';
    const { note: saved } = normalizeEditedNote(rewritten, refreshed, said('초인종에 두 번쯤 짖어요'), info);
    expect(approvalProblems(saved)).toEqual([]);
  });
});

describe('dismissing a safety flag', () => {
  const risky = consultation({ segments: [segment('a', 'guardian', 0, '오늘 구토를 했고 다리를 절뚝거려요')] });
  const note = assembleNote(blank, buildNoteSource(risky, info), 'now').note;
  it('keeps the flag on record but leaves it out of the delivery', () => {
    const { note: saved } = normalizeEditedNote({ ...note, dismissedFlags: ['구토'] }, note, risky, info);
    expect(saved.safetyFlags.sort()).toEqual(['구토', '절뚝거림']);
    expect(saved.dismissedFlags).toEqual(['구토']);
    expect(deliveryOf({ ...saved, approvedAt: 'x' }).safetyFlags).toEqual(['절뚝거림']);
  });
  it('ignores a dismissal of something that was never flagged', () => {
    const { note: saved } = normalizeEditedNote({ ...note, dismissedFlags: ['출혈'] }, note, risky, info);
    expect(saved.dismissedFlags).toEqual([]);
  });
});

describe('more that must not pass', () => {
  it('rejects a claimed improvement in any tense', () => {
    for (const text of ['초코가 좋아지고 있어요', '짖음이 나아지는 중이다', '많이 호전되었다', '행동이 개선되는 중이다']) {
      expect(assemble({ summary: [claim(text, 's01')] }).note.summary, text).toEqual([]);
    }
  });
  it('rejects a full name before a title', () => {
    const wrong = assemble({ guardianReports: [claim('이민호 선생님이 초인종을 누르면 짖는다고 말함', 's01')] });
    expect(wrong.note.guardianReports).toEqual([]);
    expect(reasons(wrong)).toContain('이민호');
  });
  it('holds behavior titles to the same evidence', () => {
    const entry = (title: string) => assemble({ behaviors: [{ title, context: [claim('초인종을 누르면 현관으로 뛰어간다', 's01')], behavior: [], response: [], unknown: [] }] });
    expect(entry('초인종에 짖음').note.behaviors).toHaveLength(1);
    expect(entry('초인종에 하루 10번 짖음').note.behaviors[0].title).toBe('행동 기록');
    expect(entry('민수 씨 귀가 때 짖음').note.behaviors[0].title).toBe('행동 기록');
  });
});

describe('a short answer and its question', () => {
  const asked = consultation({ segments: [segment('q', 'trainer', 0, '한 번 짖기 시작하면 얼마나 오래 짖나요?'), segment('a', 'guardian', 3000, '삼십 초 정도요.')] });
  const report = (text: string) => assembleNote({ ...blank, guardianReports: [claim(text, 's02')] }, buildNoteSource(asked, info), 'now');
  it('may use the words of the question, so the sentence says what the answer was about', () => {
    expect(report('한 번 짖기 시작하면 삼십 초 정도 짖음').violations).toEqual([]);
  });
  it('still needs its numbers in the answer itself', () => {
    expect(report('한 번 짖기 시작하면 사십 초 정도 짖음').violations).toHaveLength(1);
  });
  it('still rejects words from nowhere', () => {
    expect(report('산책 나가면 낯선 사람에게 달려듦').violations).toHaveLength(1);
  });
});

describe('a sentence whose citation falls short', () => {
  const said = consultation({ segments: [
    segment('p', 'trainer', 0, '초인종이 울리면 매트로 가는 연습을 할 겁니다. 소리를 작게 틀고 매트에 가면 바로 간식을 주세요.'),
    segment('x', 'guardian', 4000, '초인종에 매트로 가는 건 어려울 것 같아요.'),
    segment('t', 'trainer', 8000, '과제는 보호자님이 하루 두 번 다음 상담까지 해 주세요.'),
  ] });
  const task = (text: string, ...evidence: string[]) => ({ text, who: null, frequency: null, until: null, successCriteria: null, evidence });
  const made = (raw: Partial<RawNote>) => assembleNote({ ...blank, ...raw }, buildNoteSource(said, info), 'now');
  it('points to the lines that really say it, rather than losing a true task', () => {
    const { note, violations } = made({ tasks: [task('초인종이 울리면 매트로 가는 연습을 하루 두 번 하기', 's03')] });
    expect(violations).toEqual([]);
    expect(note.tasks[0].evidence.map(item => item.id)).toEqual(['p', 't']);
  });
  it('only looks through what the right person said', () => {
    const { note } = made({ guidance: [claim('초인종에 매트로 가는 건 어려울 것 같음', 's03')] });
    expect(note.guidance).toEqual([]);
  });
  it('still rejects words nobody said', () => {
    expect(made({ tasks: [task('공원에서 자전거 타는 사람을 보면 앉히기', 's03')] }).note.tasks).toEqual([]);
  });
  it('does not find a number on another line for a sentence that made it up', () => {
    expect(made({ tasks: [task('초인종이 울리면 매트로 가는 연습을 하루 다섯 번 하기', 's03')] }).note.tasks).toEqual([]);
  });
});

describe('one fact in one place', () => {
  const said = consultation({ segments: [segment('a', 'guardian', 0, '택배 기사님이 초인종을 누르면 현관으로 뛰어가서 계속 짖어요'), segment('b', 'guardian', 4000, '지금은 사료 알갱이를 쓰고 있어요'), segment('c', 'trainer', 8000, '귀가 앞으로 서 있네요')] });
  const entry = (title: string, text: string, alias: string) => ({ title, context: [], behavior: [claim(text, alias)], response: [], unknown: [] });
  const made = (raw: Partial<RawNote>) => assembleNote({ ...blank, ...raw }, buildNoteSource(said, info), 'now');
  it('leaves a fact under its behavior when the report only repeats it', () => {
    const { note } = made({ behaviors: [entry('초인종에 짖음', '택배 기사님이 초인종을 누르면 현관으로 뛰어가서 짖음', 's01')],
      guardianReports: [claim('초코는 택배 기사님이 초인종을 누르면 현관으로 뛰어가서 계속 짖음', 's01'), claim('지금은 사료 알갱이를 씀', 's02')] });
    expect(note.guardianReports.map(item => item.text)).toEqual(['지금은 사료 알갱이를 씀']);
  });
  it('does the same for a trainer observation', () => {
    const { note } = made({ behaviors: [entry('짖음', '귀가 앞으로 서 있음', 's03')], trainerObservations: [claim('귀가 앞으로 서 있음', 's03')] });
    expect(note.trainerObservations).toEqual([]);
  });
  it('removes nothing from a report that says something else', () => {
    const { note } = made({ behaviors: [entry('짖음', '귀가 앞으로 서 있음', 's03')], guardianReports: [claim('지금은 사료 알갱이를 씀', 's02')] });
    expect(note.guardianReports).toHaveLength(1);
  });
});

describe('finding lines for a sentence, carefully', () => {
  const task = (text: string, ...evidence: string[]) => ({ text, who: null, frequency: null, until: null, successCriteria: null, evidence });
  const made = (lines: Segment[], raw: Partial<RawNote>) => assembleNote({ ...blank, ...raw }, buildNoteSource(consultation({ segments: lines }), info), 'now');
  it('does not turn a question into a fact because an answer was cited', () => {
    const lines = [segment('q', 'trainer', 0, '아이 손을 문 적이 있나요?'), segment('a', 'guardian', 3000, '아니요, 그런 적 없어요.')];
    for (const raw of [{ summary: [claim('아이 손을 문 적이 있음', 's02')] }, { concerns: [claim('아이 손을 문 적이 있음', 's02')] }, { behaviors: [{ title: '입질', context: [], behavior: [claim('아이 손을 문 적이 있음', 's02')], response: [], unknown: [] }] }])
      expect(JSON.stringify(made(lines, raw).note)).not.toContain('아이 손을 문 적이 있음');
  });
  it('does not take a number from a line the sentence never cited', () => {
    const lines = [segment('m', 'trainer', 0, '매트 연습은 하루에 세 번 해 주세요'), segment('r', 'trainer', 3000, '과제는 이렇게 하겠습니다'), segment('d', 'trainer', 6000, '초인종 연습도 같이 합니다')];
    expect(made(lines, { tasks: [task('초인종 연습은 하루에 세 번 하기', 's02')] }).note.tasks).toEqual([]);
  });
  it('does not take a line that says the opposite', () => {
    const lines = [segment('n', 'guardian', 0, '아이 손을 문 적은 없어요'), segment('o', 'guardian', 3000, '오늘 날씨가 좋네요')];
    expect(made(lines, { guardianReports: [claim('아이 손을 문 적이 있음', 's02')] }).note.guardianReports).toEqual([]);
  });
  it('does not reach far across the conversation', () => {
    const filler = Array.from({ length: 10 }, (_, index) => segment(`f${index}`, 'trainer', 3000 * (index + 1), '네 그렇군요'));
    const lines = [segment('p', 'trainer', 0, '초인종이 울리면 매트로 가는 연습을 할 겁니다'), ...filler, segment('t', 'trainer', 60000, '과제는 보호자님이 해 주세요')];
    expect(made(lines, { tasks: [task('초인종이 울리면 매트로 가는 연습을 하기', 's12')] }).note.tasks).toEqual([]);
  });
});

describe('a behavior with a bad title', () => {
  const said = consultation({ segments: [segment('a', 'guardian', 0, '혼자 두면 계속 짖어요')] });
  const entry = (title: string) => ({ title, context: [claim('혼자 두면 계속 짖음', 's01')], behavior: [], response: [], unknown: [] });
  const made = (title: string) => assembleNote({ ...blank, behaviors: [entry(title)] }, buildNoteSource(said, info), 'now');
  it('keeps its sentences under a plain title, since they are fine', () => {
    for (const title of ['분리불안 짖음', '하루 10번 짖음', 'guardianReports', 'unknown']) {
      const { note, violations } = made(title);
      expect(note.behaviors[0], title).toMatchObject({ title: '행동 기록', context: [expect.objectContaining({ text: '혼자 두면 계속 짖음' })] });
      expect(violations, title).toEqual([]);
    }
  });
  it('leaves a good title alone', () => {
    expect(made('혼자 있을 때 짖음').note.behaviors[0].title).toBe('혼자 있을 때 짖음');
  });
});

describe('names', () => {
  const said = consultation({ segments: [segment('a', 'guardian', 0, '초인종이 울리면 짖어요')] });
  const reasons = (text: string) => assembleNote({ ...blank, summary: [claim(text, 's01')] }, buildNoteSource(said, info), 'now').violations.flatMap(item => item.reasons).join();
  it('does not mistake the end of a word for a name', () => {
    for (const text of ['초인종이 울리면 짖는다고 보호자가 말함', '초코의 보호자는 초인종이 울리면 짖는다고 함', '초인종이 울리면 짖는 것을 지금은 훈련사가 봄']) expect(reasons(text), text).not.toContain('이름');
  });
  it('still catches a full name', () => {
    expect(reasons('이민호 선생님이 초인종이 울리면 짖는다고 함')).toContain('이민호');
    expect(reasons('최수민 훈련사가 초인종이 울리면 짖는다고 함')).toContain('최수민');
  });
});

describe('repeats that are not repeats', () => {
  const said = consultation({ segments: [segment('a', 'guardian', 0, '사람을 보면 짖어요'), segment('b', 'guardian', 3000, '다른 사람을 보면 짖지 않아요')] });
  const entry = { title: '짖음', context: [], behavior: [claim('사람을 보면 짖음', 's01')], response: [], unknown: [] };
  it('keeps a sentence that says the opposite of one under a behavior', () => {
    const { note } = assembleNote({ ...blank, behaviors: [entry], guardianReports: [claim('사람을 보면 짖지 않음', 's02')] }, buildNoteSource(said, info), 'now');
    expect(note.guardianReports).toHaveLength(1);
  });
  it('keeps a sentence with a different count', () => {
    const counted = consultation({ segments: [segment('a', 'guardian', 0, '하루에 세 번 짖어요'), segment('b', 'guardian', 3000, '주말에는 하루에 다섯 번 짖어요')] });
    const { note } = assembleNote({ ...blank, behaviors: [{ ...entry, behavior: [claim('하루에 세 번 짖음', 's01')] }], guardianReports: [claim('하루에 다섯 번 짖음', 's02')] }, buildNoteSource(counted, info), 'now');
    expect(note.guardianReports).toHaveLength(1);
  });
});

describe('a memo stays private', () => {
  it('does not turn into a warning the guardian receives', () => {
    const said = consultation({ segments: [segment('a', 'guardian', 0, '초인종이 울리면 짖어요')], moments: [{ id: 'm', atMs: 0, createdBy: 'trainer', text: '구토 이력 확인 필요', frameIds: [] }] });
    const { note } = assembleNote({ ...blank, guardianReports: [claim('초인종이 울리면 짖음', 's01')], safetyFlags: ['구토'] }, buildNoteSource(said, info), 'now');
    expect(deliveryOf({ ...note, approvedAt: 'x' }).safetyFlags).toEqual([]);
  });
  it('still raises what was said aloud', () => {
    const said = consultation({ segments: [segment('a', 'guardian', 0, '어제 구토를 했어요')], moments: [{ id: 'm', atMs: 0, createdBy: 'trainer', text: '구토 이력 확인 필요', frameIds: [] }] });
    expect(assembleNote(blank, buildNoteSource(said, info), 'now').note.safetyFlags).toContain('구토');
  });
});

describe('words against a method reach the guardian', () => {
  it('delivers advice not to use force, and holds back the force itself', () => {
    const said = consultation({ segments: [segment('t', 'trainer', 0, '목줄을 세게 당기지 마세요'), segment('g', 'guardian', 3000, '코를 때린 적이 있어요')] });
    const { note } = assembleNote({ ...blank, guidance: [claim('목줄을 세게 당기지 말라고 안내함', 's01')], guardianReports: [claim('코를 때린 적이 있음', 's02')] }, buildNoteSource(said, info), 'now');
    const delivered = deliveryOf({ ...note, approvedAt: 'x' });
    expect(delivered.guidance).toHaveLength(1);
    expect(delivered.guidance[0].evidence).toHaveLength(1);
    expect(delivered.guardianReports).toEqual([]);
  });
});

describe('improvement in any form', () => {
  it('is not something a note can claim', () => {
    const said = consultation({ segments: [segment('a', 'guardian', 0, '초코가 많이 짖어요')] });
    for (const text of ['초코가 많이 좋아진 것 같음', '초코가 곧 좋아질 것임', '초코가 좋아져서 많이 짖음', '초코가 많이 나아진 것 같음', '초코가 개선된 것 같음'])
      expect(assembleNote({ ...blank, summary: [claim(text, 's01')] }, buildNoteSource(said, info), 'now').note.summary, text).toEqual([]);
  });
});

describe('details of a task after the transcript changes', () => {
  it('blocks approval of a frequency its corrected evidence no longer says', () => {
    const said = (text: string) => consultation({ segments: [segment('t', 'trainer', 0, text)] });
    const before = said('매트 연습을 하루 세 번 해 주세요');
    const { note } = assembleNote({ ...blank, tasks: [{ text: '매트 연습 하기', who: null, frequency: '하루 세 번', until: null, successCriteria: null, evidence: ['s01'] }] }, buildNoteSource(before, info), 'now');
    const after = said('매트 연습을 하루 두 번 해 주세요');
    const { note: refreshed } = normalizeEditedNote(note, note, after, info);
    expect(approvalProblems(refreshed).join()).toContain('하루 세 번');
  });
});

describe('speech the note did not use', () => {
  it('points to what might matter, not to questions and small talk', () => {
    const said = consultation({ segments: [
      segment('q', 'trainer', 0, '한 번 짖으면 얼마나 오래 짖나요?'), segment('r', 'trainer', 3000, '요즘 어떤 상황인지 말씀해 주세요.'), segment('h', 'trainer', 6000, '안녕하세요, 오늘 잘 부탁드립니다.'),
      segment('k', 'guardian', 9000, '네, 알겠습니다.'), segment('f', 'guardian', 12000, '밤에는 현관 앞에서 잠을 자요.'),
    ] });
    expect(assembleNote(blank, buildNoteSource(said, info), 'now').note.uncitedSegmentIds).toEqual(['f']);
  });
});
