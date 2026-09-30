import { useEffect, useRef, useState } from 'react';
import { generateBrief } from '../feature-api';
import { computeBrief } from '../domain/brief';
import { listOwnerLogs, listPets } from '../domain/owner-storage';
import { listNotes } from '../domain/storage';
import type { BriefDraft, BriefInput, Pet, SavedOwnerLog } from '../domain/workspace-types';
import { downloadJson, message } from './workspace-utils';
import IssueReport from './IssueReport';

type Props = { aiReady: boolean };
function latestTrainerNote(name: string) {
  try { return listNotes().filter(note => note.metadata.petName.trim() === name.trim()).sort((a, b) => b.metadata.sessionDate.localeCompare(a.metadata.sessionDate))[0]; }
  catch { return undefined; }
}

export default function BriefWorkspace({ aiReady }: Props) {
  const [pets, setPets] = useState<Pet[]>([]);
  const [records, setRecords] = useState<SavedOwnerLog[]>([]);
  const [petId, setPetId] = useState('');
  const [consent, setConsent] = useState(false);
  const [draft, setDraft] = useState<BriefDraft | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refId, setRefId] = useState('');
  const abort = useRef<AbortController | null>(null);
  const version = useRef(0);
  const cancel = () => { version.current++; abort.current?.abort(); abort.current = null; setPending(false); };
  useEffect(() => { try { const values = listPets(); setPets(values); setRecords(listOwnerLogs()); setPetId(values[0]?.id ?? ''); } catch (caught) { setError(message(caught)); } return () => { version.current++; abort.current?.abort(); }; }, []);
  const selected = pets.find(pet => pet.id === petId);
  const note = selected ? latestTrainerNote(selected.name) : undefined;
  const input: BriefInput | null = selected ? { pet: selected, records, now: new Date().toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, ...(note ? { previousSession: { date: note.metadata.sessionDate, items: note.draft.items.map(item => ({ id: item.id, text: item.text, category: item.category })) } } : {}) } : null;
  let factsDraft: BriefDraft | null = null;
  try { if (input) factsDraft = computeBrief(input); } catch { factsDraft = null; }
  const generate = async () => {
    if (!input) return;
    cancel(); setError(''); setNotice(''); setDraft(null);
    if (!aiReady) { setDraft(computeBrief(input)); setNotice('저장된 기록으로 사실표를 만들었습니다.'); return; }
    if (!consent) { setError('AI 처리 동의가 필요합니다.'); return; }
    const current = version.current;
    const controller = new AbortController(); abort.current = controller; setPending(true);
    try { const result = await generateBrief(input, controller.signal); if (current !== version.current || controller.signal.aborted) return; setDraft(result.draft); setNotice(result.fallbackUsed ? 'AI 생성에 실패해 사실표 기반 요약을 표시합니다.' : '브리핑 초안을 만들었습니다. 근거를 확인해 주세요.'); if (result.warnings.length) setError(result.warnings.join(' ')); }
    catch (caught) { if (current !== version.current || controller.signal.aborted) return; setError(`${message(caught)} 사실표 기반 요약을 표시합니다.`); setDraft(computeBrief(input)); }
    finally { if (current === version.current) { abort.current = null; setPending(false); } }
  };
  const current = draft ?? factsDraft;
  const fact = current?.facts.find(item => item.id === refId);
  const event = records.flatMap(record => record.draft.events).find(item => item.id === refId);
  const noteItem = note?.draft.items.find(item => item.id === refId);
  const renderRefs = (refs: string[]) => refs.length ? <div className="ws-refs">{refs.map(id => <button className={refId === id ? 'selected' : ''} key={id} onClick={() => setRefId(id)}>{id.startsWith('task:') ? '이전 과제' : '근거 보기'}</button>)}</div> : null;
  const renderTexts = (title: string, values: BriefDraft['summary']) => values.length > 0 && <section className="ws-brief-section"><h3>{title}</h3>{values.map((item, index) => <div className="ws-item" key={`${title}-${index}`}><p>{item.text}</p>{renderRefs(item.refs)}</div>)}</section>;
  return <div className="ws-layout"><section className="input-panel ws-panel"><div className="panel-heading"><div><span className="eyebrow">TRAINER / BRIEF</span><h2>상담 전 브리핑</h2></div><span className="status-tag">훈련사 작업 영역</span></div>
    <p className="ws-muted">이 브라우저에 저장된 보호자 기록을 바탕으로 최근 14일을 정리합니다. 계정 권한 분리 기능은 아직 없습니다.</p>
    <label className="ws-label">반려동물<select value={petId} onChange={e => { cancel(); setPetId(e.target.value); setDraft(null); setRefId(''); setError(''); }}><option value="">선택하세요</option>{pets.map(pet => <option key={pet.id} value={pet.id}>{pet.name}</option>)}</select></label>
    {selected && <div className="ws-box"><h3>사용 자료</h3><p>저장된 보호자 기록 {records.filter(record => record.draft.events.some(e => e.petId === petId)).length}건</p><p>직전 상담: {note ? `${note.metadata.sessionDate} · ${note.metadata.trainerName}` : '저장된 기록 없음'}</p></div>}
    {aiReady && <label className="ws-check"><input type="checkbox" checked={consent} onChange={e => { setConsent(e.target.checked); if (!e.target.checked) cancel(); }} />선택한 기록을 AI 처리 서버로 보내는 데 동의합니다.</label>}
    <button className="button primary full" onClick={generate} disabled={!selected || pending}>{pending ? '브리핑 만드는 중' : aiReady ? 'AI 브리핑 만들기' : '기록으로 브리핑 만들기'}</button>{pending && <button className="button secondary full" onClick={cancel}>생성 취소</button>}
    {notice && <p role="status" className="ws-notice">{notice}</p>}{error && <p role="alert" className="ws-error">{error}</p>}{(draft || error) && <IssueReport feature="brief" input={input} output={draft} requestId={draft?.generation?.requestId} error={error} />}
    {current && <div className="ws-box"><h3>자료 범위</h3><p>{current.period.from} ~ {current.period.to} · 기록된 날 {current.period.daysWithRecords}일</p>{current.dataGaps.map((gap, index) => <p className="ws-muted" key={index}>{gap}</p>)}</div>}
    </section>
    <section className="review-panel ws-panel"><div className="panel-heading"><div><span className="eyebrow">FACTS / SOURCES</span><h2>사실과 근거</h2></div><span className="status-tag">{current?.mode === 'openai' ? 'AI 초안' : '코드 집계'}</span></div>
      {!current && <p className="ws-empty">반려동물을 선택하면 저장된 사건의 사실표가 나타납니다.</p>}
      {current && <><div className="ws-facts"><table><thead><tr><th>항목</th><th>최근</th><th>직전</th><th>근거</th></tr></thead><tbody>{current.facts.map(fact => <tr key={fact.id}><th>{fact.label}</th><td>{String(fact.value)}{fact.unit}</td><td>{fact.previousValue === null ? '자료 없음' : `${fact.previousValue}${fact.unit}`}</td><td>{renderRefs(fact.refs)}</td></tr>)}</tbody></table></div>
      {refId && <div className="ws-evidence" role="status"><strong>선택한 근거</strong>{fact ? <><p>{fact.label}: {String(fact.value)}{fact.unit}</p>{fact.refs.map(id => { const sourceEvent = records.flatMap(record => record.draft.events).find(item => item.id === id); const sourceNote = note?.draft.items.find(item => item.id === id); return <p key={id}>{sourceEvent?.sourceQuote ?? sourceNote?.text ?? '원문을 찾을 수 없습니다.'}</p>; })}</> : <p>{event ? event.sourceQuote : noteItem ? `${note?.metadata.sessionDate} · ${noteItem.text}` : '원문을 찾을 수 없습니다.'}</p>}</div>}
      {renderTexts('요약', current.summary)}{renderTexts('변화', current.changes)}{renderTexts('보호자에게 확인할 질문', current.questionsForOwner)}{renderTexts('이전 과제', current.previousTasks)}{renderTexts('주의 사항', current.cautions)}
      <button className="button secondary full" onClick={() => downloadJson(`hanggo-brief-${selected?.name ?? 'pet'}.json`, current)}>JSON 내보내기</button></>}
    </section></div>;
}
