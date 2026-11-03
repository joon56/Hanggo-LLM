// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { Consultation, Segment } from '../../src/domain/coaching.ts';
import { newConsultation } from '../../src/domain/coaching.ts';
import type { RawNote } from '../../src/domain/coaching-note.ts';
import type { LlmOutput, LlmRequest } from '../ai/llm/types.ts';
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
  it('tells the model what was wrong and tries once more', async () => {
    const { service, requests, structured } = build(reply(bad), reply(good));
    const note = await service.generate(consultation(short), info);
    expect(structured).toHaveBeenCalledTimes(2);
    expect(requests[1].user).toContain('초인종에 하루 다섯 번 짖는다');
    expect(requests[1].user).toContain('근거에 없는 숫자');
    expect(note.warnings).toEqual([]);
    expect(note.summary).toEqual([]);
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
  it('keeps whichever attempt had fewer problems', async () => {
    const worse: RawNote = { ...blank, summary: [{ text: '다섯 번 짖는다', evidence: ['s01'] }], concerns: [{ text: '여섯 번 짖는다', evidence: ['s01'] }] };
    const { service } = build(reply(bad), reply(worse));
    const note = await service.generate(consultation(short), info);
    expect(note.guardianReports).toHaveLength(1);
    expect(note.warnings).toHaveLength(1);
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
  const long = [segment('a', 'guardian', 0, '초인종이 울리면 세 번쯤 짖어요'), segment('b', 'trainer', 10 * minute, '매트로 가는 연습을 하세요'), segment('c', 'guardian', 16 * minute, '산책할 때 다른 개를 보면 짖어요'), segment('d', 'trainer', 31 * minute, '거리를 두고 간식을 주세요')];
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
  it('splits at fifteen minutes, merges the parts, and summarizes from them', async () => {
    const { service, requests } = buildLong(chunkReply);
    const note = await service.generate(consultation(long), info);
    expect(requests).toHaveLength(4);
    expect(requests[0].user).toContain('[s02');
    expect(requests[0].user).not.toContain('[s03');
    expect(requests[1].user).toContain('[s03');
    expect(requests[2].user).toContain('[s04');
    expect(note.guardianReports.map(item => item.text)).toEqual(['초인종이 울리면 세 번쯤 짖는다', '다른 개를 보면 짖는다']);
    expect(note.tasks).toHaveLength(1);
    expect(note.summary[0].evidence.map(item => item.id)).toEqual(['a', 'c']);
    expect(note.uncitedSegmentIds).toEqual([]);
  });
  it('removes a sentence two parts both produced', async () => {
    const { service } = buildLong(request => {
      if (request.user.includes('문장 목록')) return reply({ summary: [] });
      const evidence = request.user.includes('[s01') ? ['s01'] : ['s02'];
      return reply({ ...blank, concerns: [{ text: '짖어요', evidence }] });
    });
    const note = await service.generate(consultation([long[0], long[2]]), info);
    expect(note.concerns).toHaveLength(1);
  });
  it('keeps the other parts and warns when one part cannot be organized', async () => {
    const { service } = buildLong(request => request.user.includes('[s03') ? reply(null) : chunkReply(request));
    const note = await service.generate(consultation(long), info);
    expect(note.fallbackUsed).toBeUndefined();
    expect(note.guidance).toHaveLength(1);
    expect(note.warnings.join()).toContain('15:00');
    expect(note.uncitedSegmentIds).toEqual(['c']);
  });
  it('still returns the parts when the summary fails', async () => {
    const { service } = buildLong(request => request.user.includes('문장 목록') ? reply(null) : chunkReply(request));
    const note = await service.generate(consultation(long), info);
    expect(note.summary).toEqual([]);
    expect(note.guidance).toHaveLength(1);
    expect(note.warnings.join()).toContain('요약');
  });
});
