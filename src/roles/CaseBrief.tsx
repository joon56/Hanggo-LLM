import { useEffect, useState } from 'react';
import { getCaseBrief, type CaseBriefResponse } from '../coaching-api';
import type { BriefSource, ReferencedText } from '../domain/workspace-types';
import { apiMessage, clockLabel } from './copy';
import './review.css';

const SOURCE_NAME: Record<BriefSource['kind'], string> = { owner: '보호자 기록', legacy_consultation: '상담', consultation: '지난 상담', task_log: '과제 수행 기록' };

function Source({ source }: { source: BriefSource }) {
  return <div className="brief-source">
    <p className="coach-hint">{SOURCE_NAME[source.kind]} · {source.date ?? '날짜 미확인'}</p>
    <blockquote>{source.sourceQuote}</blockquote>
    {source.evidence?.map((item, index) => <p key={index} className="coach-hint">상담 {clockLabel(item.startMs)} · “{item.quote}”</p>)}
  </div>;
}

function Line({ item, sources, facts }: { item: ReferencedText; sources: BriefSource[]; facts: CaseBriefResponse['brief']['facts'] }) {
  const [open, setOpen] = useState(false);
  const ids = new Set(item.refs.flatMap(ref => facts.find(fact => fact.id === ref)?.refs ?? [ref]));
  const cited = sources.filter(source => ids.has(source.id));
  return <li>
    {item.text}
    {cited.length > 0 && <button type="button" className="call-link coach-link-inline" aria-expanded={open} onClick={() => setOpen(value => !value)}>근거 {cited.length}건</button>}
    {open && cited.map(source => <Source key={source.id} source={source} />)}
  </li>;
}

/** For the trainer only. The server refuses this to a guardian as well. */
export function CaseBrief({ caseId }: { caseId: string }) {
  const [data, setData] = useState<CaseBriefResponse | null>(null); const [error, setError] = useState('');
  useEffect(() => {
    let stopped = false;
    getCaseBrief(caseId).then(result => { if (!stopped) setData(result); }, cause => { if (!stopped) setError(apiMessage(cause, '브리핑을 불러오지 못했습니다.')); });
    return () => { stopped = true; };
  }, [caseId]);
  if (error) return <p role="alert" className="coach-error">{error}</p>;
  if (!data) return <p role="status" className="coach-hint">브리핑을 만드는 중입니다.</p>;
  const { brief } = data; const sources = brief.sources ?? [];
  const list = (title: string, items: ReferencedText[]) => items.length > 0 && <div><h3>{title}</h3><ul>{items.map((item, index) => <Line key={index} item={item} sources={sources} facts={brief.facts} />)}</ul></div>;
  return <section className="case-brief delivery" aria-label="상담 전 브리핑">
    <h2>상담 전 브리핑</h2>
    <p className="coach-hint">훈련사만 봅니다. 기록을 코드로 모은 참고 자료입니다.</p>
    {brief.safetyFlags.length > 0 && <p role="alert" className="review-safety">안전 신호: {brief.safetyFlags.join(', ')}</p>}
    {list('핵심', brief.summary)}
    {list('지난 과제', brief.previousTasks)}
    {list('주의', brief.cautions)}
    {list('확인할 질문', brief.questionsForOwner)}
    {brief.dataGaps.length > 0 && <details><summary>자료의 빈틈 {brief.dataGaps.length}건</summary><ul>{brief.dataGaps.map((gap, index) => <li key={index}>{gap}</li>)}</ul></details>}
  </section>;
}
