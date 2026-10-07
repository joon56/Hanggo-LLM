import type { BriefInput, BriefDraft, BriefSource, BriefConsultationContext, Fact, ReferencedText } from './workspace-types.ts';
import { ownerRiskFlags, resolveOwnerPet } from './owner-log.ts';

const labels: Record<string, string> = { bark: '짖음', feeding: '급식', walk: '산책', excretion: '배변', rest: '휴식', activity: '활동', training: '훈련', other_behavior: '기타 행동', health_observation: '건강 관찰', other: '기타' };
const triggers: Record<string, string> = { doorbell: '초인종', delivery: '배달', visitor: '방문객', stranger: '낯선 사람', other_dog: '다른 개', other_animal: '다른 동물', noise: '소음', left_alone: '혼자 있음', owner_return: '보호자 귀가', food: '음식', unknown: '상황 미확인', other: '기타 상황' };
const outcomes: Record<string, string> = { stopped: '멈춤', reduced: '줄어듦', continued: '계속됨', escalated: '더 심해짐', unknown: '반응 미확인' };
export const BRIEF_OWNER_SOURCE_LIMIT = 24;
export const BRIEF_CONSULTATION_ITEM_LIMIT = 12;
export const BRIEF_QUOTE_LIMIT = 400;
const clip = (text: string, limit = BRIEF_QUOTE_LIMIT) => text.slice(0, limit);
export function prioritizeBriefConsultationItems<T extends { category: string }>(items: T[]): T[] {
  const representative = ['task', 'purpose', 'follow_up'].map(category => items.find(item => item.category === category)).filter((item): item is T => !!item);
  return [...representative, ...items.filter(item => !representative.includes(item))].slice(0, BRIEF_CONSULTATION_ITEM_LIMIT);
}
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
export function questionForBriefFact(draft: BriefDraft, fact: Fact): ReferencedText {
  const source = draft.sources?.find(source => fact.refs.includes(source.id) && (source.kind !== 'owner' || source.scope === 'current'));
  let text: string;
  if (source?.kind === 'owner') {
    const context = source.trigger ? triggers[source.trigger] : '발생 상황 미확인';
    const response = source.outcome ? outcomes[source.outcome] : '반응 미확인';
    text = source.intervention
      ? `${source.date} ${context} 기록의 대응 “${clip(source.intervention, 100)}” 뒤 반응은 ${response}으로 기록됐습니다. 반응까지 걸린 시간과 같은 상황의 다른 기록이 있나요?`
      : `${source.date} 기록 “${clip(source.sourceQuote, 100)}”에서 ${context}입니다. 당시 발생 상황, 보호자의 대응과 그 뒤 반응을 확인할 수 있나요?`;
  } else if (source) {
    text = source.category === 'task'
      ? `${source.date} 상담 과제 “${clip(source.text, 120)}”의 시도 여부를 확인할 수 있나요? 시도했다면 상황과 반응 기록이 있나요? 수행 여부는 미확인입니다.`
      : `${source.date} 상담 기록 “${clip(source.text, 120)}”과 관련해 이번 상담에서 추가로 확인할 상황이나 반응 기록이 있나요?`;
  } else text = '최근 기록이 빠진 날의 발생 상황과 대응·반응을 확인할 자료가 있나요? 기록 없음은 행동 없음으로 판단할 수 없습니다.';
  return { text, refs: [fact.id] };
}
export function selectBriefSummary(draft: BriefDraft, priorities: string[] = []): ReferencedText[] {
  const coverage = draft.facts.find(f => f.id === 'record-days')!;
  const contexts = draft.facts.filter(f => f.id.startsWith('context:'));
  const purposes = draft.facts.filter(f => draft.sources?.some(source => f.refs.includes(source.id) && source.category === 'purpose'));
  const situations = draft.facts.filter(f => draft.sources?.some(source => f.refs.includes(source.id) && (source.category === 'owner_report' || source.category === 'observation')));
  const candidates = contexts.length ? contexts : purposes.length ? purposes : situations.length ? situations : draft.facts.filter(f => f.id.startsWith('count:') && Number(f.value) > 0);
  const first = priorities.map(id => candidates.find(f => f.id === id)).find(Boolean) ?? candidates[0];
  const mainSource = draft.sources?.find(source => first?.refs.includes(source.id));
  const caution = draft.cautions[0], change = draft.changes[0];
  const questionRefs = [...new Set(draft.questionsForOwner.flatMap(question => question.refs))];
  const questionSources = questionRefs.flatMap(id => { const fact = draft.facts.find(f => f.id === id); return draft.sources?.filter(source => fact?.refs.includes(source.id)) ?? []; });
  const checkItems = [questionSources.some(source => source.category === 'task') ? '이전 과제 시도 여부' : '', questionSources.some(source => source.category === 'follow_up') ? '상담 후속 확인' : '', questionSources.some(source => source.kind === 'owner') ? '기록된 상황의 대응·반응' : '', questionSources.some(source => source.category === 'owner_report' || source.category === 'observation') ? '상담 기록 상황·반응' : ''].filter(Boolean);
  return [
    { text: `핵심 상황: ${mainSource ? `${mainSource.date}${mainSource.kind !== 'owner' ? ' · 상담 기록' + (mainSource.scope !== 'current' ? ' · 과거 자료 · 현재 상태 미확인' : '') : ''} · “${clip(mainSource.sourceQuote, 140)}”` : first ? `${first.label} · ${first.value}${first.unit}` : '최근 상황 자료 부족 · 미확인'}.`, refs: [first?.id ?? coverage.id] },
    { text: `변화·주의점: ${caution?.text ?? change?.text ?? '두 기간의 기록으로 확인할 변화 자료 부족.'} 최근 ${coverage.value}일 / 직전 ${coverage.previousValue}일 기록. 기록 건수는 실제 행동 횟수와 다릅니다.`, refs: [...new Set([...(caution?.refs ?? change?.refs ?? []), coverage.id])] },
    { text: `이번 상담에서 확인할 일: ${checkItems.length ? checkItems.join(' · ') + ' 확인.' : '상황·대응·반응 자료 부족 · 기록 누락 확인.'}`, refs: questionRefs.length ? questionRefs : [coverage.id] },
  ];
}
export function selectBriefQuestions(draft: BriefDraft, priorities: string[] = []): ReferencedText[] {
  const eligible = draft.facts.filter(f => /^(context|task|session):/.test(f.id));
  const ordered = [...priorities.map(id => eligible.find(f => f.id === id)).filter((fact): fact is Fact => !!fact), ...eligible];
  const sourceFor = (fact: Fact) => draft.sources?.find(source => fact.refs.includes(source.id));
  const task = ordered.find(f => f.id.startsWith('task:'));
  const follow = ordered.find(f => sourceFor(f)?.category === 'follow_up');
  const owner = ordered.find(f => f.id.startsWith('context:'));
  const picked = [task, follow, owner].filter((fact): fact is Fact => !!fact);
  const signatures = new Set(picked.map(f => { const s = sourceFor(f); return s?.kind === 'owner' ? JSON.stringify([s.trigger, s.intervention, s.outcome]) : s?.text; }));
  for (const fact of ordered) {
    if (picked.length >= 3) break;
    const source = sourceFor(fact), signature = source?.kind === 'owner' ? JSON.stringify([source.trigger, source.intervention, source.outcome]) : source?.text;
    if (signatures.has(signature)) continue;
    signatures.add(signature); picked.push(fact);
  }
  return (picked.length ? picked : [draft.facts[0]]).slice(0, 3).map(fact => questionForBriefFact(draft, fact));
}
export function computeBrief(input: BriefInput, consultation?: BriefConsultationContext): BriefDraft {
  if (input.consultation && (!consultation || consultation.id !== input.consultation.id || consultation.revision !== input.consultation.revision || consultation.petName.trim() !== input.pet.name.trim())) throw new Error('선택한 확정 상담을 다시 확인해 주세요.');
  if (input.consultation && input.previousSession) throw new Error('상담은 한 건만 선택해 주세요.');
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
  const dataGaps = [`최근 기간 중 ${14 - daysWithRecords}일은 기록이 없습니다. 기록 없음은 행동이 없었다는 뜻이 아닙니다.`];
  if (daysWithRecords < 3) dataGaps.push('기록 부족: 기록이 있는 날이 3일 미만입니다.');
  if (all.some(e => !e.occurredAt || !Number.isFinite(Date.parse(e.occurredAt)))) dataGaps.push('시각이 불명확한 사건은 기간 집계에서 제외했습니다.');
  if (all.some(e => e.occurredAt && Date.parse(e.occurredAt) > Date.parse(input.now))) dataGaps.push('미래 사건은 집계와 상세 근거에서 제외했습니다.');
  if (!previous.length) dataGaps.push('직전 기간에 기록이 없어 행동 수치 비교를 생략했습니다.');
  const sources: BriefSource[] = [];
  const rows = input.records.flatMap(record => record.draft.events.filter(event => event.petId === input.pet.id && (!event.occurredAt || !Number.isFinite(Date.parse(event.occurredAt)) || Date.parse(event.occurredAt) <= Date.parse(input.now))).map(event => ({ record, event, date: event.occurredAt && Number.isFinite(Date.parse(event.occurredAt)) ? localDate(event.occurredAt, input.timeZone) : null })));
  const scope = (date: string | null): NonNullable<BriefSource['scope']> => date === null ? 'unknown' : date >= from ? 'current' : date >= priorFrom ? 'previous' : 'historical';
  const rank = { current: 0, previous: 1, unknown: 2, historical: 3 };
  rows.sort((a, b) => rank[scope(a.date)] - rank[scope(b.date)] || Number(!!b.event.trigger || !!b.event.intervention) - Number(!!a.event.trigger || !!a.event.intervention) || (b.date ?? '').localeCompare(a.date ?? ''));
  for (const { record, event, date } of rows.slice(0, BRIEF_OWNER_SOURCE_LIMIT)) {
    const context = `${date ?? '시각 미확인'} · ${labels[event.type]} · “${clip(event.sourceQuote, 120)}” · 상황 ${event.trigger ? triggers[event.trigger] : '미확인'} · 대응 ${event.intervention ? clip(event.intervention, 100) : '미확인'} · 반응 ${event.outcome ? outcomes[event.outcome] : '미확인'}`;
    sources.push({ id: event.id, kind: 'owner', date, occurredAt: event.occurredAt, timeHint: event.timeHint, recordId: record.id, sourceQuote: clip(event.sourceQuote), text: context, trigger: event.trigger, intervention: event.intervention ? clip(event.intervention, 200) : null, outcome: event.outcome, scope: scope(date), truncated: event.sourceQuote.length > BRIEF_QUOTE_LIMIT || (event.intervention?.length ?? 0) > 200 });
    if (scope(date) === 'current') facts.push({ id: `context:${event.id}`, label: '발생 상황·대응·반응', value: context, unit: '', previousValue: null, refs: [event.id] });
  }
  if (rows.length > BRIEF_OWNER_SOURCE_LIMIT) dataGaps.push(`상세 보호자 근거는 우선순위 ${BRIEF_OWNER_SOURCE_LIMIT}건만 표시합니다. ${rows.length - BRIEF_OWNER_SOURCE_LIMIT}건 생략; 기간 수치는 전체 사건으로 집계합니다.`);
  const safetyFlags: string[] = [], cautions: ReferencedText[] = [];
  for (const record of input.records) {
    const selectedRows = rows.filter(row => row.record.id === record.id);
    if (!selectedRows.length || !record.draft.safetyFlags.length) continue;
    const unambiguous = record.draft.pets.length === 1 && record.draft.events.every(event => event.petId === input.pet.id);
    const matched = selectedRows.filter(row => ownerRiskFlags(row.event.sourceQuote).length && resolveOwnerPet(row.event.sourceQuote, { ...record.draft, text: record.draft.sourceText }) === input.pet.id);
    if (!matched.length && !unambiguous) { dataGaps.push('여러 동물 또는 대상 불명 기록의 전체 안전 신호는 선택한 동물의 사실로 연결하지 않았습니다. 대상 확인이 필요합니다.'); continue; }
    const groups = matched.length ? (['current', 'previous', 'unknown', 'historical'] as const).map(period => {
      const applicable = matched.filter(row => scope(row.date) === period);
      return { period, applicable, flags: [...new Set(applicable.flatMap(row => ownerRiskFlags(row.event.sourceQuote)))] };
    }) : [{ period: 'unknown' as const, applicable: selectedRows, flags: record.draft.safetyFlags }];
    const unmatched = record.draft.safetyFlags.filter(flag => !groups.some(group => group.flags.includes(flag)));
    if (unambiguous && unmatched.length) {
      const unknown = groups.find(group => group.period === 'unknown')!;
      unknown.flags.push(...unmatched); unknown.applicable = selectedRows;
    }
    for (const { period, applicable, flags } of groups) {
      if (!flags.length) continue;
      safetyFlags.push(...flags);
      const label = period === 'current' ? '최근 안전 검토 신호 (기록 원문 확인 필요)' : period === 'unknown' ? '안전 신호 · 대상/시각 미확인 (기록 전체)' : '과거 안전 신호 · 현재 상태 미확인';
      facts.push({ id: `safety:${record.id}:${period}`, label, value: flags.join(', '), unit: '', previousValue: null, refs: applicable.map(row => row.event.id) });
      cautions.push(renderBriefFact(facts.at(-1)!));
    }
  }
  cautions.sort((a, b) => Number(b.text.startsWith('최근')) - Number(a.text.startsWith('최근')));
  const previousTasks: ReferencedText[] = [];
  const session = consultation ?? input.previousSession;
  if (session && session.date > to) dataGaps.push('선택한 상담 날짜가 브리핑 시점 이후여서 상담 근거를 제외했습니다.');
  else if (session) {
    const items = prioritizeBriefConsultationItems<(typeof session.items)[number]>(session.items);
    for (const [index, item] of items.entries()) {
      const sourceId = `${consultation ? 'consultation' : 'legacy'}:${JSON.stringify([consultation?.id ?? session.date, item.id])}`;
      const evidence = 'evidence' in item ? item.evidence : undefined;
      const quote = 'sourceQuote' in item && item.sourceQuote ? item.sourceQuote : item.text;
      sources.push({ id: sourceId, kind: consultation ? 'consultation' : 'legacy_consultation', date: session.date, sourceQuote: clip(quote), text: clip(item.text), category: item.category, scope: scope(session.date), ...(evidence ? { evidence } : {}), truncated: item.text.length > BRIEF_QUOTE_LIMIT || quote.length > BRIEF_QUOTE_LIMIT || ('truncated' in item && item.truncated === true) });
      const fact: Fact = { id: item.category === 'task' ? `task:${index}` : `session:${index}`, label: item.category === 'task' ? '이전 상담 과제 원문 (수행 여부 미확인)' : '선택한 상담 원문', value: `${session.date} · ${clip(item.text, 200)}`, unit: '', previousValue: null, refs: [sourceId] };
      facts.push(fact); if (item.category === 'task') previousTasks.push(renderBriefFact(fact));
    }
    const omitted = session.items.length - items.length + (consultation?.omittedItems ?? 0);
    if (omitted > 0) dataGaps.push(`상담 상세 근거는 과제를 우선해 ${items.length}건만 표시합니다. ${omitted}건 생략했습니다.`);
  } else dataGaps.push('확정 상담일지를 선택하지 않았습니다. 이전 상담과 과제는 미확인입니다.');
  if (sources.some(source => source.truncated)) dataGaps.push(`긴 원문은 최대 ${BRIEF_QUOTE_LIMIT}자 발췌로 표시합니다. 생략된 내용은 원본 기록에서 확인해 주세요.`);
  if (new Set(sources.map(source => source.id)).size !== sources.length || facts.some(fact => sources.some(source => source.id === fact.id))) throw new Error('근거 ID가 충돌합니다. 기록을 확인해 주세요.');
  const draft: BriefDraft = { id: crypto.randomUUID(), petId: input.pet.id, period: { from, to, daysWithRecords }, facts, sources, summary: [], changes: facts.filter(f => isBriefChange(f, daysWithRecords, Number(facts[0].previousValue))).map(renderBriefFact), questionsForOwner: [], previousTasks, cautions, dataGaps, safetyFlags: [...new Set(safetyFlags)], mode: 'manual', ...(consultation ? { consultation: { id: consultation.id, date: consultation.date, petName: consultation.petName, trainerName: consultation.trainerName, revision: consultation.revision, approvedAt: consultation.approvedAt } } : {}) };
  draft.questionsForOwner = selectBriefQuestions(draft);
  draft.summary = selectBriefSummary(draft);
  return draft;
}
