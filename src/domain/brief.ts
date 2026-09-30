import type { BriefInput, BriefDraft, Fact, ReferencedText } from './workspace-types.ts';

const labels: Record<string, string> = { bark: '짖음', feeding: '급식', walk: '산책', excretion: '배변', rest: '휴식', activity: '활동', training: '훈련', other_behavior: '기타 행동', health_observation: '건강 관찰', other: '기타' };
function localDate(date: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(date));
  return ['year', 'month', 'day'].map(type => parts.find(p => p.type === type)!.value).join('-');
}
function shift(date: string, days: number): string { return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10); }
export function renderBriefFact(fact: Fact): ReferencedText {
  return { text: `${fact.label}: ${fact.value}${fact.unit}${fact.previousValue === null ? '' : ` (직전 기간 ${fact.previousValue}${fact.unit})`}.`, refs: [fact.id] };
}
export function isBriefChange(fact: Fact, days: number, previousDays: number): boolean {
  return days >= 3 && previousDays >= 3 && fact.id.startsWith('count:') && typeof fact.value === 'number' && typeof fact.previousValue === 'number' && fact.value !== fact.previousValue && (fact.previousValue === 0 || Math.abs(fact.value - fact.previousValue) / fact.previousValue >= 0.3);
}
export function computeBrief(input: BriefInput): BriefDraft {
  const to = localDate(input.now, input.timeZone), from = shift(to, -13), priorFrom = shift(to, -27);
  const all = input.records.flatMap(r => r.draft.events).filter(e => e.petId === input.pet.id);
  if (new Set(all.map(e => e.id)).size !== all.length) throw new Error('중복된 사건 ID가 있습니다.');
  const dated = all.filter(e => e.occurredAt !== null && Number.isFinite(Date.parse(e.occurredAt)) && Date.parse(e.occurredAt) <= Date.parse(input.now)).map(e => ({ event: e, date: localDate(e.occurredAt!, input.timeZone) }));
  const current = dated.filter(e => e.date >= from && e.date <= to), previous = dated.filter(e => e.date >= priorFrom && e.date < from);
  const daysWithRecords = new Set(current.map(e => e.date)).size;
  const facts: Fact[] = [{ id: 'record-days', label: '기록이 있는 날', value: daysWithRecords, unit: '일', previousValue: new Set(previous.map(e => e.date)).size, refs: [...current, ...previous].map(e => e.event.id) }];
  for (const type of Object.keys(labels)) {
    const rows = current.filter(e => e.event.type === type), prior = previous.filter(e => e.event.type === type);
    if (!rows.length && !prior.length) continue;
    facts.push({ id: `count:${type}`, label: `${labels[type]} 기록 횟수`, value: rows.length, unit: '회', previousValue: previous.length ? prior.length : null, refs: [...rows, ...prior].map(e => e.event.id) });
    if (daysWithRecords >= 3) {
      const durations = rows.filter(e => e.event.durationMin !== null), oldDurations = prior.filter(e => e.event.durationMin !== null);
      if (durations.length) facts.push({ id: `duration:${type}`, label: `${labels[type]} 기록된 시간 합계`, value: durations.reduce((sum, e) => sum + e.event.durationMin!, 0), unit: '분', previousValue: oldDurations.length ? oldDurations.reduce((sum, e) => sum + e.event.durationMin!, 0) : null, refs: [...durations, ...oldDurations].map(e => e.event.id) });
    }
  }
  const safetyFlags = [...new Set(input.records.filter(r => r.draft.events.some(e => e.petId === input.pet.id)).flatMap(r => r.draft.safetyFlags))];
  const cautions: ReferencedText[] = [];
  if (safetyFlags.length) {
    const fact: Fact = { id: 'safety', label: '안전 검토 신호 (제공된 기록 전체)', value: safetyFlags.join(', '), unit: '', previousValue: null, refs: all.map(e => e.id) };
    facts.push(fact); cautions.push(renderBriefFact(fact));
  }
  const previousTasks: ReferencedText[] = [];
  for (const [index, item] of (input.previousSession?.items.filter(i => i.category === 'task') ?? []).entries()) {
    const fact: Fact = { id: `task:${index}`, label: '이전 상담 과제 원문 (수행 여부 미확인)', value: item.text, unit: '', previousValue: null, refs: [item.id] };
    facts.push(fact); previousTasks.push(renderBriefFact(fact));
  }
  const dataGaps = [`최근 기간 중 ${14 - daysWithRecords}일은 기록이 없습니다. 기록 없음은 행동이 없었다는 뜻이 아닙니다.`];
  if (daysWithRecords < 3) dataGaps.push('기록 부족: 기록이 있는 날이 3일 미만입니다.');
  if (all.some(e => e.occurredAt === null)) dataGaps.push('시각이 불명확한 사건은 기간 집계에서 제외했습니다.');
  if (!previous.length) dataGaps.push('직전 기간에 기록이 없어 행동 수치 비교를 생략했습니다.');
  const counts = facts.filter(f => f.id.startsWith('count:'));
  return { id: crypto.randomUUID(), petId: input.pet.id, period: { from, to, daysWithRecords }, facts, summary: (counts.length ? counts : facts.slice(0, 1)).slice(0, 3).map(renderBriefFact), changes: counts.filter(f => isBriefChange(f, daysWithRecords, Number(facts[0].previousValue))).map(renderBriefFact), questionsForOwner: [], previousTasks, cautions, dataGaps, safetyFlags, mode: 'manual' };
}
