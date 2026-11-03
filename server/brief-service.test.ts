import { expect, it } from 'vitest';
import { createBriefService, BriefInputSchema } from './brief-service.ts';
import fixtures from '../fixtures/briefs.json' with { type: 'json' };
import type { BriefInput } from '../src/domain/workspace-types.ts';
const briefInput=():BriefInput=>structuredClone(fixtures[2].input) as BriefInput;
it('rejects invalid saved-record envelopes',()=>{const i=briefInput();i.records[0].savedAt='bad';expect(BriefInputSchema.safeParse(i).success).toBe(false);});
it('rejects impossible previous-session calendar dates',()=>{const input=briefInput();input.previousSession={date:'2026-99-99',items:[]};expect(BriefInputSchema.safeParse(input).success).toBe(false);input.previousSession.date='2026-02-30';expect(BriefInputSchema.safeParse(input).success).toBe(false);});
it('rejects unsupported fact IDs and safely falls back after retry',async()=>{let calls=0;const r=await createBriefService({model:'test',extract:async()=>{calls++;return {summary:['made-up'],changes:[],questionsForOwner:[]};}}).generate(briefInput());expect(calls).toBe(2);expect(r.fallbackUsed).toBe(true);expect(r.draft.summary[0].refs.length).toBeGreaterThan(0);});
it('uses chosen facts without letting model remove fixed roles or grounded questions',async()=>{const r=await createBriefService({model:'test',extract:async()=>({summary:['count:walk'],changes:[],questionsForOwner:['count:walk']})}).generate(briefInput());expect(r.fallbackUsed).toBe(false);expect(r.draft.summary.map(line=>line.text.split(':')[0])).toEqual(['핵심 상황','변화·주의점','이번 상담에서 확인할 일']);expect(r.draft.questionsForOwner.length).toBeGreaterThan(0);const bad=await createBriefService({model:'test',extract:async()=>({summary:[{text:'산책 99회',refs:['count:walk']}],changes:[],questionsForOwner:[]})}).generate(briefInput());expect(bad.fallbackUsed).toBe(true);});
it('rejects a consultation reference, since nothing can resolve one here',async()=>{const input=briefInput();input.consultation={id:'selected',revision:'r1'};await expect(createBriefService({model:'test',extract:async()=>{throw new Error('offline');}}).generate(input)).rejects.toThrow(/unrecognized_key/);});
it('keeps code questions and three roles when extraction fails',async()=>{const r=await createBriefService({model:'test',extract:async()=>{throw new Error('offline');}}).generate(briefInput());expect(r.fallbackUsed).toBe(true);expect(r.draft.summary).toHaveLength(3);expect(r.draft.questionsForOwner.length).toBeGreaterThan(0);});
it('keeps situation in core and diverse consultation/owner questions despite model count-only ranking', async () => {
  const input = briefInput(); input.previousSession = { date: '2026-09-25', items: [{ id: 'task', text: '거리 유지 과제를 하기로 했다.', category: 'task' }, { id: 'follow', text: '초인종 때 멈추기까지 걸린 시간을 확인하기로 했다.', category: 'follow_up' }] };
  const result = await createBriefService({ model: 'test', extract: async () => ({ summary: ['count:walk'], changes: [], questionsForOwner: ['count:walk', 'record-days'] }) }).generate(input);
  expect(result.draft.summary[0].text).toContain('상황');
  expect(result.draft.summary[0].text).not.toContain('기록 횟수');
  expect(result.draft.questionsForOwner.some(line => line.text.includes('거리 유지'))).toBe(true);
  expect(result.draft.questionsForOwner.some(line => line.text.includes('초인종'))).toBe(true);
  expect(result.draft.questionsForOwner.some(line => line.refs.some(id => id.startsWith('context:')))).toBe(true);
});
it('rejects duplicate event IDs and malformed source shape',()=>{const i=briefInput();i.records[0].draft.events.push(i.records[0].draft.events[0]);expect(BriefInputSchema.safeParse(i).success).toBe(false);const j=briefInput();j.records[0].draft.events[0].details=null as never;expect(BriefInputSchema.safeParse(j).success).toBe(false);});
it('propagates cancellation and masks prior task context',async()=>{const input=briefInput();input.previousSession={date:'2026-09-01',items:[{id:'task',category:'task',text:'연락처 test@example.com 확인'}]};const c=new AbortController();let seen='';await expect(createBriefService({model:'test',extract:async(masked)=>{seen=JSON.stringify(masked);c.abort();return {};}}).generate(input,c.signal)).rejects.toThrow();expect(seen).not.toContain('test@example.com');});

for (const failed of [false, true]) it(`keeps observation-only consultation in all three summary roles with AI ${failed ? 'fallback' : 'selection'}`, async () => {
  const input = briefInput(); input.records = [];
  input.previousSession = { date: '2026-09-25', items: [{ id: 'situation', category: 'owner_report', text: '초인종 때 짖었다.' }] };
  const result = await createBriefService({ model: 'test', extract: async () => {
    if (failed) throw new Error('offline');
    return { summary: ['record-days'], changes: [], questionsForOwner: ['record-days'] };
  } }).generate(input);
  expect(result.fallbackUsed).toBe(failed);
  expect(result.draft.summary[0].text).toContain('2026-09-25');
  expect(result.draft.summary[0].text).toContain('초인종 때 짖었다.');
  expect(result.draft.summary[0].refs).toEqual(['session:0']);
  expect(result.draft.summary[2].text).toContain('상담 기록 상황');
  expect(result.draft.summary[2].refs).toContain('session:0');
});
