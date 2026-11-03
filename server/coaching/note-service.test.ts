// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { Consultation, Segment } from '../../src/domain/coaching.ts';
import { newConsultation } from '../../src/domain/coaching.ts';
import type { RawNote } from '../../src/domain/coaching-note.ts';
import type { LlmOutput, LlmRequest } from '../ai/llm/types.ts';
import { noteSchema } from './note-schema.ts';
import { createNoteService } from './note-service.ts';

const info = { petName: '초코', guardianName: '가상 보호자', trainerName: '가상 훈련사' };
const segment = (id: string, speaker: Segment['speaker'], startMs: number, text: string): Segment => ({ id, speaker, startMs, endMs: startMs + 3000, text, originalText: text, state: 'complete' });
const consultation = (segments: Segment[], change: Partial<Consultation> = {}): Consultation => ({ ...newConsultation({ id: 'c1', caseId: 'k1', createdAt: 'now' }), segments, ...change });
const short = [segment('a', 'guardian', 0, '초인종이 울리면 하루에 세 번쯤 짖어요'), segment('b', 'trainer', 4000, '하루 두 번 매트로 가는 연습을 해 주세요')];
const blank: RawNote = { summary: [], concerns: [], behaviors: [], guardianReports: [], trainerObservations: [], guidance: [], tasks: [], followUps: [], safetyFlags: [], methodReview: false };
const good: RawNote = { ...blank, guardianReports: [{ text: '초인종이 울리면 하루에 세 번쯤 짖는다', evidence: ['s01'] }], guidance: [{ text: '하루 두 번 매트로 가는 연습을 안내함', evidence: ['s02'] }] };
const bad: RawNote = { ...good, summary: [{ text: '초인종에 하루 다섯 번 짖는다', evidence: ['s01'] }] };
const reply = (json: unknown, finished = true): LlmOutput => ({ json, finished });

function build(...replies: (LlmOutput | Error)[]) {
  const requests: LlmRequest[] = [];
  const structured = vi.fn(async (request: LlmRequest) => {
    requests.push(request);
    const next = replies.length > 1 ? replies.shift()! : replies[0];
    if (next instanceof Error) throw next;
    return next;
  });
  const service = createNoteService({ llm: { name: 'fake', supportsVision: false, structured, release: async () => {} }, now: () => Date.parse('2026-11-04T00:00:00Z') });
  return { service, requests, structured };
}

describe('createNoteService', () => {
  it('sends short evidence ids and returns the checked note', async () => {
    const { service, requests, structured } = build(reply(good));
    const note = await service.generate(consultation(short), info);
    expect(structured).toHaveBeenCalledTimes(1);
    expect(requests[0].user).toContain('[s01 00:00 보호자] 초인종이 울리면');
    expect(requests[0].user).toContain('[s02 00:04 훈련사]');
    expect(JSON.stringify(requests[0].jsonSchema)).toContain('"enum":["s01","s02"]');
    expect(note).toMatchObject({ version: 2, createdAt: '2026-11-04T00:00:00.000Z', warnings: [] });
    expect(note.guardianReports[0].evidence[0]).toMatchObject({ id: 'a', quote: short[0].text });
    expect(note.fallbackUsed).toBeUndefined();
  });
  it('asks again only about what was wrong, and keeps what was right', async () => {
    const fixed: RawNote = { ...blank, summary: [{ text: '초인종이 울리면 하루에 세 번쯤 짖는다', evidence: ['s01'] }] };
    const { service, requests, structured } = build(reply(bad), reply(fixed));
    const note = await service.generate(consultation(short), info);
    expect(structured).toHaveBeenCalledTimes(2);
    expect(requests[1].user).toContain('초인종에 하루 다섯 번 짖는다');
    expect(requests[1].user).toContain('근거에 없는 숫자');
    expect(requests[1].user).toContain('이 문장들만');
    expect(requests[1].maxTokens).toBeLessThan(requests[0].maxTokens!);
    expect(note.warnings).toEqual([]);
    expect(note.summary.map(item => item.text)).toEqual(['초인종이 울리면 하루에 세 번쯤 짖는다']);
    expect(note.guardianReports).toHaveLength(1);
    expect(note.guidance).toHaveLength(1);
    expect(note.uncitedSegmentIds).toEqual([]);
  });
  it('drops what is still wrong after the retry and says so', async () => {
    const { service, structured } = build(reply(bad));
    const note = await service.generate(consultation(short), info);
    expect(structured).toHaveBeenCalledTimes(2);
    expect(note.summary).toEqual([]);
    expect(note.guardianReports).toHaveLength(1);
    expect(note.warnings).toHaveLength(1);
    expect(note.warnings[0]).toContain('초인종에 하루 다섯 번 짖는다');
  });
  it('keeps the first answer when the retry fails', async () => {
    const { service } = build(reply(bad), new Error('model died'));
    const note = await service.generate(consultation(short), info);
    expect(note.guardianReports).toHaveLength(1);
    expect(note.fallbackUsed).toBeUndefined();
    expect(note.warnings).toHaveLength(1);
  });
  it('reports one problem per sentence still wrong, not per attempt', async () => {
    const worse: RawNote = { ...blank, summary: [{ text: '다섯 번 짖는다', evidence: ['s01'] }], concerns: [{ text: '여섯 번 짖는다', evidence: ['s01'] }] };
    const { service } = build(reply(bad), reply(worse));
    const note = await service.generate(consultation(short), info);
    expect(note.guardianReports).toHaveLength(1);
    expect(note.warnings).toHaveLength(1);
    expect(note.warnings[0]).toContain('초인종에 하루 다섯 번 짖는다');
  });
  it('does not repeat anything when the model answers the retry with the whole note', async () => {
    const { service } = build(reply(bad), reply(good));
    const note = await service.generate(consultation(short), info);
    expect(note.guardianReports).toHaveLength(1);
    expect(note.guidance).toHaveLength(1);
    expect(note.warnings).toHaveLength(1);
  });
  it('adds a repaired sentence to the behavior it belongs to', async () => {
    const behavior = (claims: Partial<RawNote['behaviors'][number]>) => ({ title: '초인종 짖음', context: [], behavior: [], response: [], unknown: [], ...claims });
    const first: RawNote = { ...blank, behaviors: [behavior({ context: [{ text: '초인종이 울리면', evidence: ['s01'] }], behavior: [{ text: '하루에 다섯 번 짖는다', evidence: ['s01'] }] })] };
    const repaired: RawNote = { ...blank, behaviors: [behavior({ behavior: [{ text: '하루에 세 번쯤 짖는다', evidence: ['s01'] }] })] };
    const { service } = build(reply(first), reply(repaired));
    const note = await service.generate(consultation(short), info);
    expect(note.behaviors).toHaveLength(1);
    expect(note.behaviors[0].context).toHaveLength(1);
    expect(note.behaviors[0].behavior.map(item => item.text)).toEqual(['하루에 세 번쯤 짖는다']);
    expect(note.warnings).toEqual([]);
  });
  for (const [name, broken] of [['unfinished', reply(good, false)], ['not JSON', reply(null)], ['the wrong shape', reply({ summary: 'no' })], ['failed', new Error('model died')]] as const) {
    it(`retries when the answer is ${name}, then falls back to an empty form`, async () => {
      const { service, structured } = build(broken);
      const note = await service.generate(consultation(short), info);
      expect(structured).toHaveBeenCalledTimes(2);
      expect(note).toMatchObject({ fallbackUsed: true, summary: [], uncitedSegmentIds: ['a', 'b'] });
      expect(note.warnings[0]).toContain('일지 초안을 만들지 못했습니다');
    });
  }
  it('recovers when only the first answer was broken', async () => {
    const { service } = build(reply(null), reply(good));
    const note = await service.generate(consultation(short), info);
    expect(note.fallbackUsed).toBeUndefined();
    expect(note.guardianReports).toHaveLength(1);
  });
  it('does not call the model when there is no speech', async () => {
    const { service, structured } = build(reply(good));
    const note = await service.generate(consultation([]), info);
    expect(structured).not.toHaveBeenCalled();
    expect(note).toMatchObject({ fallbackUsed: true, warnings: ['받아쓴 발화가 없어 빈 양식을 만들었습니다.'] });
  });
  it('stops at once when cancelled', async () => {
    const controller = new AbortController(); controller.abort();
    const { service, structured } = build(reply(good));
    await expect(service.generate(consultation(short), info, controller.signal)).rejects.toThrow();
    expect(structured).not.toHaveBeenCalled();
  });
});

describe('long consultations', () => {
  const minute = 60_000;
  // About three minutes of talk each, so two of them fill one part.
  const lengthy = (spoken: string) => `${spoken} ${'그런 식으로 계속 그렇습니다 '.repeat(50)}`;
  const long = [segment('a', 'guardian', 0, lengthy('초인종이 울리면 세 번쯤 짖어요')), segment('b', 'trainer', 10 * minute, lengthy('매트로 가는 연습을 하세요')), segment('c', 'guardian', 16 * minute, lengthy('산책할 때 다른 개를 보면 짖어요')), segment('d', 'trainer', 31 * minute, lengthy('거리를 두고 간식을 주세요'))];
  const chunkReply = (request: LlmRequest): LlmOutput => {
    if (request.user.includes('문장 목록')) return reply({ summary: [{ text: '초인종과 산책 때 짖는다', evidence: request.user.includes('[s03') ? ['s01', 's03'] : ['s01'] }] });
    const raw: RawNote = { ...blank };
    if (request.user.includes('[s01')) raw.guardianReports = [{ text: '초인종이 울리면 세 번쯤 짖는다', evidence: ['s01'] }];
    if (request.user.includes('[s02')) raw.tasks = [{ text: '매트로 가는 연습', who: null, frequency: null, until: null, successCriteria: null, evidence: ['s02'] }];
    if (request.user.includes('[s03')) raw.guardianReports = [{ text: '다른 개를 보면 짖는다', evidence: ['s03'] }];
    if (request.user.includes('[s04')) raw.guidance = [{ text: '거리를 두고 간식을 주라고 안내함', evidence: ['s04'] }];
    return reply(raw);
  };
  function buildLong(answer: (request: LlmRequest) => LlmOutput) {
    const requests: LlmRequest[] = [];
    const structured = vi.fn(async (request: LlmRequest) => { requests.push(request); return answer(request); });
    return { requests, structured, service: createNoteService({ llm: { name: 'fake', supportsVision: false, structured, release: async () => {} } }) };
  }
  it('splits by how much was said, merges the parts, and summarizes from them', async () => {
    const { service, requests } = buildLong(chunkReply);
    const note = await service.generate(consultation(long), info);
    expect(requests).toHaveLength(3);
    expect(requests[0].user).toContain('[s02');
    expect(requests[0].user).not.toContain('[s03');
    expect(requests[1].user).toContain('[s03');
    expect(requests[1].user).toContain('[s04');
    expect(note.guardianReports.map(item => item.text)).toEqual(['초인종이 울리면 세 번쯤 짖는다', '다른 개를 보면 짖는다']);
    expect(note.tasks).toHaveLength(1);
    expect(note.summary[0].evidence.map(item => item.id)).toEqual(['a', 'c']);
    expect(note.uncitedSegmentIds).toEqual([]);
  });
  it('lets each part read the end of the one before, so a topic across the cut stays whole', async () => {
    const { service, requests } = buildLong(chunkReply);
    await service.generate(consultation(long), info);
    expect(requests[1].user).toContain('[s02');
    expect(requests[1].user).not.toContain('[s01');
  });
  it('reports each part before starting it', async () => {
    const { service } = buildLong(chunkReply);
    const progress: [number, number][] = [];
    await service.generate(consultation(long), info, undefined, async (done, total) => { progress.push([done, total]); });
    expect(progress).toEqual([[0, 2], [1, 2]]);
  });
  it('sends a short conversation as one part, however long the call ran', async () => {
    const { service, requests } = buildLong(chunkReply);
    await service.generate(consultation([segment('a', 'guardian', 0, '초인종이 울리면 세 번쯤 짖어요'), segment('b', 'trainer', 40 * minute, '매트로 가는 연습을 하세요')]), info);
    expect(requests).toHaveLength(1);
  });
  it('does not spend a call on a few words left over at the end', async () => {
    const { service, requests } = buildLong(() => reply(blank));
    await service.generate(consultation([...long.slice(0, 2), segment('c', 'guardian', 20 * minute, '네 감사합니다')]), info);
    expect(requests).toHaveLength(1);
    expect(requests[0].user).toContain('[s03');
  });
  it('removes a sentence two parts both produced', async () => {
    const { service } = buildLong(request => {
      if (request.user.includes('문장 목록')) return reply({ summary: [] });
      const evidence = request.user.includes('[s01') ? ['s01'] : ['s03'];
      return reply({ ...blank, concerns: [{ text: '그런 식으로 계속 그렇습니다', evidence }] });
    });
    const note = await service.generate(consultation(long), info);
    expect(note.concerns).toHaveLength(1);
  });
  it('removes the same lines organized twice in other words, since parts overlap', async () => {
    const { service } = buildLong(request => {
      if (request.user.includes('문장 목록')) return reply({ summary: [] });
      return reply({ ...blank, guidance: [{ text: request.user.includes('[s01') ? '매트로 가는 연습을 하라고 안내함' : '연습을 하세요 매트로 가는', evidence: ['s02'] }] });
    });
    const note = await service.generate(consultation(long), info);
    expect(note.guidance).toHaveLength(1);
  });
  const task = (text: string, evidence: string[]) => ({ text, who: null, frequency: null, until: null, successCriteria: null, evidence });
  it('keeps the fuller of two tasks made from the same lines in different parts', async () => {
    const { service } = buildLong(request => {
      if (request.user.includes('문장 목록')) return reply({ summary: [] });
      return reply({ ...blank, tasks: request.user.includes('[s01') ? [task('매트로 가는 연습', ['s02'])] : [task('매트로 가는 연습과 거리를 두고 간식을 주기', ['s02', 's04'])] });
    });
    const note = await service.generate(consultation(long), info);
    expect(note.tasks.map(item => item.text)).toEqual(['매트로 가는 연습과 거리를 두고 간식을 주기']);
  });
  it('keeps two tasks one part drew from the same sentence', async () => {
    const { service } = buildLong(request => {
      if (request.user.includes('문장 목록')) return reply({ summary: [] });
      return reply({ ...blank, tasks: request.user.includes('[s01') ? [task('매트로 가는 연습', ['s02']), task('연습을 하세요', ['s02'])] : [] });
    });
    const note = await service.generate(consultation(long), info);
    expect(note.tasks).toHaveLength(2);
  });
  it('keeps the other parts and warns when one part cannot be organized', async () => {
    const { service } = buildLong(request => request.user.includes('[s03') ? reply(null) : chunkReply(request));
    const note = await service.generate(consultation(long), info);
    expect(note.fallbackUsed).toBeUndefined();
    expect(note.tasks).toHaveLength(1);
    expect(note.warnings.join()).toContain('16:00');
    expect(note.uncitedSegmentIds).toEqual(['c', 'd']);
  });
  it('gives the summary what was written under behaviors, which is where most of what a guardian said now lives', async () => {
    const { service, requests } = buildLong(request => {
      if (request.user.includes('문장 목록')) return reply({ summary: [] });
      return reply({ ...blank, behaviors: request.user.includes('[s01') ? [{ title: '초인종에 짖음', context: [{ text: '초인종이 울리면 세 번쯤 짖음', evidence: ['s01'] }], behavior: [], response: [], unknown: [] }] : [] });
    });
    await service.generate(consultation(long), info);
    expect(requests.at(-1)!.user).toContain('초인종이 울리면 세 번쯤 짖음');
  });
  it('still returns the parts when the summary fails', async () => {
    const { service } = buildLong(request => request.user.includes('문장 목록') ? reply(null) : chunkReply(request));
    const note = await service.generate(consultation(long), info);
    expect(note.summary).toEqual([]);
    expect(note.guidance).toHaveLength(1);
    expect(note.warnings.join()).toContain('요약');
  });
});

describe('a model that never answers', () => {
  const hanging = () => vi.fn((request: LlmRequest) => new Promise<LlmOutput>((_resolve, reject) => { request.signal?.addEventListener('abort', () => reject(new Error('aborted'))); }));
  it('gives up after the time limit and falls back to the blank form, so a consultation cannot stay stuck', async () => {
    const structured = hanging();
    const service = createNoteService({ llm: { name: 'fake', supportsVision: false, structured, release: async () => {} }, callTimeoutMs: 5 });
    const note = await service.generate(consultation(short), info);
    expect(structured).toHaveBeenCalledTimes(2);
    expect(note.fallbackUsed).toBe(true);
  });
  it('still treats a cancellation from outside as a cancellation', async () => {
    const controller = new AbortController();
    const service = createNoteService({ llm: { name: 'fake', supportsVision: false, structured: hanging(), release: async () => {} }, callTimeoutMs: 60_000 });
    const pending = service.generate(consultation(short), info, controller.signal);
    setTimeout(() => controller.abort(), 5);
    await expect(pending).rejects.toThrow();
  });
});

describe('answers the record cannot hold', () => {
  it('saves one copy of a repeated unknown field', async () => {
    const answer = { ...good, behaviors: [{ title: '초인종 짖음', context: [{ text: '초인종이 울리면 짖는다', evidence: ['s01'] }], behavior: [], response: [], unknown: ['duration', 'duration', 'duration', 'response', 'response', 'trigger'] }] };
    const { service } = build(reply(answer));
    const note = await service.generate(consultation(short), info);
    expect(note.behaviors[0].unknown).toEqual(['duration', 'response', 'trigger']);
  });
  it('falls back to a blank form rather than losing the review when an answer does not fit', async () => {
    const answer = { ...good, behaviors: [{ title: '초'.repeat(400), context: [{ text: '초인종이 울리면 짖는다', evidence: ['s01'] }], behavior: [], response: [], unknown: [] }] };
    const { service } = build(reply(answer));
    const note = await service.generate(consultation(short), info);
    expect(note.fallbackUsed).toBe(true);
    expect(note.warnings.join()).toContain('형식');
    expect(noteSchema.safeParse(note).success).toBe(true);
  });
});
