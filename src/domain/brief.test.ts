import { describe, expect, it } from 'vitest';
import { computeBrief } from './brief.ts';
import type { BriefInput, OwnerEvent, SavedOwnerLog } from './workspace-types.ts';
import fixtures from '../../fixtures/briefs.json';

export function briefInput(): BriefInput {
  const event = (id: string, occurredAt: string | null, type: OwnerEvent['type'] = 'walk'): OwnerEvent => ({ id, petId: 'p', type, occurredAt, timeHint: null, durationMin: 20, trigger: null, intervention: null, outcome: null, details: { amountText: null, isTreat: null, excretionKinds: [], placeText: null }, sourceQuote: '산책 20분', edited: false });
  const records: SavedOwnerLog[] = [{ id: 'saved', savedAt: '2026-09-30T00:00:00Z', draft: { id: 'd', sourceText: '산책 20분', sourceKind: 'nl_log_text', pets: [{ id: 'p', name: '초코', nicknames: [] }], now: '2026-09-30T00:00:00Z', timeZone: 'Asia/Seoul', events: [event('a','2026-09-29T01:00:00Z'),event('b','2026-09-28T01:00:00Z'),event('c','2026-09-27T01:00:00Z'),event('d','2026-09-10T01:00:00Z'),event('unknown',null)], safetyFlags: [], clarification: null, mode: 'manual' } }];
  return { pet: { id: 'p', name: '초코', nicknames: [] }, records, now: '2026-09-30T00:00:00Z', timeZone: 'Asia/Seoul' };
}
describe('brief deterministic facts', () => {
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
