import { describe, expect, it } from 'vitest';
import { computeBrief } from './brief.ts';
import type { BriefInput, BriefConsultationContext, OwnerEvent, SavedOwnerLog } from './workspace-types.ts';
import fixtures from '../../fixtures/briefs.json';

export function briefInput(): BriefInput {
  const event = (id: string, occurredAt: string | null, type: OwnerEvent['type'] = 'walk'): OwnerEvent => ({ id, petId: 'p', type, occurredAt, timeHint: null, durationMin: 20, trigger: null, intervention: null, outcome: null, details: { amountText: null, isTreat: null, excretionKinds: [], placeText: null }, sourceQuote: '산책 20분', edited: false });
  const records: SavedOwnerLog[] = [{ id: 'saved', savedAt: '2026-09-30T00:00:00Z', draft: { id: 'd', sourceText: '산책 20분', sourceKind: 'nl_log_text', pets: [{ id: 'p', name: '초코', nicknames: [] }], now: '2026-09-30T00:00:00Z', timeZone: 'Asia/Seoul', events: [event('a','2026-09-29T01:00:00Z'),event('b','2026-09-28T01:00:00Z'),event('c','2026-09-27T01:00:00Z'),event('d','2026-09-10T01:00:00Z'),event('unknown',null)], safetyFlags: [], clarification: null, mode: 'manual' } }];
  return { pet: { id: 'p', name: '초코', nicknames: [] }, records, now: '2026-09-30T00:00:00Z', timeZone: 'Asia/Seoul' };
}
describe('brief deterministic facts', () => {
  it('always gives three fixed roles with explicit missing data and grounded refs', () => {
    const input = briefInput(); input.records = [];
    const draft = computeBrief(input);
    expect(draft.summary.map(line => line.text.split(':')[0])).toEqual(['핵심 상황', '변화·주의점', '이번 상담에서 확인할 일']);
    expect(draft.summary.map(line => line.text).join(' ')).toMatch(/자료 부족|미확인/);
    expect(draft.summary.every(line => line.refs.length && line.refs.every(id => draft.facts.some(f => f.id === id)))).toBe(true);
  });
  it('grounds questions in dated situations, interventions and responses', () => {
    const input = briefInput(); const event = input.records[0].draft.events[0];
    Object.assign(event, { type: 'bark', trigger: 'doorbell', intervention: '문에서 떨어져 기다렸다', outcome: 'reduced', sourceQuote: '초인종에 짖어서 문에서 떨어져 기다렸다. 짖음이 줄었다.' });
    const draft = computeBrief(input);
    expect(draft.summary[0].text).toContain('초인종');
    expect(draft.questionsForOwner[0].text).toContain('문에서 떨어져 기다렸다');
    expect(draft.questionsForOwner[0].text).toContain('줄');
    expect(draft.questionsForOwner.length).toBeLessThanOrEqual(3);
    expect(draft.sources?.find(source => source.id === event.id)).toMatchObject({ date: '2026-09-29', sourceQuote: event.sourceQuote, kind: 'owner', occurredAt: event.occurredAt });
    expect(draft.summary[2].text.length).toBeLessThan(130);
    expect(draft.summary[2].text).not.toContain(draft.questionsForOwner[0].text);
  });
  it('does not turn mixed-pet source-wide safety flags into selected-pet facts', () => {
    const input = briefInput(); const record = input.records[0];
    record.draft.pets.push({ id: 'other', name: '보리', nicknames: [] });
    record.draft.events.push({ ...record.draft.events[0], id: 'risk-other', petId: 'other', sourceQuote: '보리가 구토했다.' });
    record.draft.safetyFlags = ['vomiting'];
    const draft = computeBrief(input);
    expect(draft.safetyFlags).not.toContain('vomiting');
    expect(draft.dataGaps.join(' ')).toContain('대상');
    expect(draft.sources?.some(source => source.id === 'risk-other')).toBe(false);
  });
  it('marks old and unknown-time safety evidence separately and excludes future evidence', () => {
    const input = briefInput(); const record = input.records[0];
    record.draft.events = [{ ...record.draft.events[0], occurredAt: '2026-08-01T00:00:00Z', sourceQuote: '구토했다.' }, { ...record.draft.events[0], id: 'future-risk', occurredAt: '2026-10-01T00:00:00Z', sourceQuote: '구토했다.' }];
    record.draft.safetyFlags = ['vomiting'];
    const draft = computeBrief(input);
    expect(draft.cautions.map(line => line.text).join(' ')).toContain('과거');
    expect(draft.summary[1].text).not.toContain('최근 안전');
    expect(draft.sources?.some(source => source.id === 'future-risk')).toBe(false);
  });
  it('keeps historical and recent safety sources distinct even in one saved log', () => {
    const input = briefInput(), record = input.records[0];
    record.draft.events = [{ ...record.draft.events[0], id: 'past', occurredAt: '2026-08-01T00:00:00Z', sourceQuote: '구토했다.' }, { ...record.draft.events[0], id: 'recent', sourceQuote: '출혈이 있었다.' }];
    record.draft.safetyFlags = ['vomiting', 'bleeding'];
    const draft = computeBrief(input);
    expect(draft.cautions).toHaveLength(2);
    expect(draft.summary[1].text).toContain('최근 안전');
    expect(draft.cautions.find(line => line.text.includes('과거'))?.text).toContain('vomiting');
    expect(draft.cautions.find(line => line.text.includes('최근'))?.text).not.toContain('vomiting');
  });
  for (const fixture of fixtures) it(`fixture: ${fixture.id}`, () => {
    const d=computeBrief(fixture.input as BriefInput), expected=fixture.expect;
    expect(d.period.daysWithRecords).toBe(expected.days);
    expect(d.dataGaps.some(g=>g.includes('기록 부족'))).toBe(expected.insufficient);
    if (expected.walk!==undefined) expect(d.facts.find(f=>f.id==='count:walk')?.value).toBe(expected.walk);
    if (expected.previousWalk!==undefined) expect(d.facts.find(f=>f.id==='count:walk')?.previousValue).toBe(expected.previousWalk);
    if (expected.safetyFlag) expect(d.safetyFlags).toContain(expected.safetyFlag);
    if (expected.timeGap) expect(d.dataGaps.join(' ')).toContain('시각');
    expect(d.summary.map(s=>s.text).join(' ')).not.toMatch(/좋아졌|나빠졌|원인|때문/);
  });
  it('counts actual event dates, preserves IDs and compares prior fourteen days', () => {
    const draft = computeBrief(briefInput());
    expect(draft.period).toEqual({ from: '2026-09-17', to: '2026-09-30', daysWithRecords: 3 });
    expect(draft.facts.find(f=>f.id==='count:walk')).toMatchObject({ value:3, previousValue:1, refs:['a','b','c','d'] });
    expect(draft.dataGaps.join(' ')).toContain('시각');
    expect(draft.facts.flatMap(f=>f.refs)).not.toContain('unknown');
  });
  it('marks fewer than three record days, never fabricates lesson success or patterns', () => {
    const input=briefInput(); input.records[0].draft.events=input.records[0].draft.events.slice(0,1);
    const d=computeBrief(input); expect(d.dataGaps.join(' ')).toContain('기록 부족'); expect(d.facts.some(f=>/성공률|레슨|원인/.test(f.label))).toBe(false);
  });
  it('uses requested timezone and excludes future records', () => {
    const input=briefInput(); input.records[0].draft.events[0].occurredAt='2026-09-16T16:00:00Z'; input.records[0].draft.events[1].occurredAt='2026-10-01T00:00:00Z';
    expect(computeBrief(input).facts.find(f=>f.id==='count:walk')?.value).toBe(2);
  });
  it('does not select sparse or small differences as changes',()=>{const i=briefInput();expect(computeBrief(i).changes).toEqual([]);const events=i.records[0].draft.events;events.push({...events[0],id:'old2',occurredAt:'2026-09-11T01:00:00Z'},{...events[0],id:'old3',occurredAt:'2026-09-12T01:00:00Z'});expect(computeBrief(i).changes).toEqual([]);events.push({...events[0],id:'new4',occurredAt:'2026-09-26T01:00:00Z'});expect(computeBrief(i).changes).toHaveLength(1);});
});

for (const kind of ['legacy', 'detailed'] as const) {
  for (const category of ['observation', 'owner_report'] as const) {
    for (const date of ['2026-09-25', '2026-08-01']) it(`uses ${kind} ${category}-only consultation in core summary dated ${date}`, () => {
      const input = briefInput(); input.records = [];
      const text = '초인종 때 짖고 문에서 떨어진 뒤 줄어들었다.';
      const items = [{ id: 'situation', category, text, sourceQuote: text }];
      let context: BriefConsultationContext | undefined;
      if (kind === 'legacy') input.previousSession = { date, items };
      else {
        input.consultation = { id: 'selected', revision: 'r1' };
        context = { id: 'selected', revision: 'r1', date, petName: input.pet.name, trainerName: '김', approvedAt: `${date}T00:00:00Z`, items: items.map(item => ({ ...item, evidence: [] })), omittedItems: 0 };
      }
      const draft = computeBrief(input, context);
      expect(draft.summary[0].text).toContain(date);
      expect(draft.summary[0].text).toContain('상담');
      expect(draft.summary[0].text).toContain(text);
      expect(draft.summary[0].text).not.toContain('최근 상황 자료 부족');
      expect(draft.summary[0].refs).toEqual(['session:0']);
      expect(draft.summary[2].text).toContain('상담 기록 상황');
      expect(draft.summary[2].text).not.toContain('상황·대응·반응 자료 부족');
      expect(draft.summary[2].refs).toContain('session:0');
      expect(draft.questionsForOwner[0].text).toContain(date);
      if (date === '2026-08-01') {
        expect(draft.summary[0].text).toContain('과거 자료');
        expect(draft.summary[0].text).toContain('현재 상태 미확인');
        expect(draft.sources?.[0].scope).toBe('historical');
      }
      expect(draft.period.daysWithRecords).toBe(0);
    });
  }
}

it('discloses clipping when legacy original quote exceeds limit despite short edited text', () => {
  const input = briefInput(); input.records = [];
  input.previousSession = { date: '2026-09-25', items: [{ id: 'edited', category: 'observation', text: '초인종 때 짖었다.', sourceQuote: '긴 원문 '.repeat(100) }] };
  const draft = computeBrief(input);
  expect(draft.sources?.[0].sourceQuote).toHaveLength(400);
  expect(draft.sources?.[0].truncated).toBe(true);
  expect(draft.dataGaps.join(' ')).toContain('긴 원문은 최대 400자 발췌');
});
