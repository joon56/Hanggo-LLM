// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { Consultation, Segment } from './coaching.ts';
import { newConsultation } from './coaching.ts';
import { approvalProblems, assembleNote, briefContextOf, buildNoteSource, deliveryOf, emptyNote, normalizeEditedNote, reviewedObservationClaims, type RawNote } from './coaching-note.ts';

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
