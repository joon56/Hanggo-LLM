import { useEffect, useRef, useState } from 'react';
import { generateBrief } from '../feature-api';
import { ApiError } from '../api';
import { getBriefConsultation, listBriefConsultations } from '../consultation-api';
import { computeBrief } from '../domain/brief';
import { listOwnerLogs, listPets } from '../domain/owner-storage';
import { listNotes } from '../domain/storage';
import type { ApprovedNote } from '../domain/notes';
import type { BriefDraft, BriefInput, BriefSource, BriefConsultationChoice, BriefConsultationContext, Pet, SavedOwnerLog } from '../domain/workspace-types';
import { downloadJson, message } from './workspace-utils';
import { isExternalModel, processingPhrase, type AiProvider } from '../ai-copy';
import IssueReport from './IssueReport';

type Props = { aiReady: boolean; provider?: AiProvider };
const time = (ms: number) => Math.floor(ms / 60000).toString().padStart(2, '0') + ':' + (Math.floor(ms / 1000) % 60).toString().padStart(2, '0');
const sourceKind = { owner: '보호자 기록', legacy_consultation: '확정 요약 상담', consultation: '확정 상세 상담' };
export default function BriefWorkspace({ aiReady, provider }: Props) {
  const [pets, setPets] = useState<Pet[]>([]), [records, setRecords] = useState<SavedOwnerLog[]>([]);
  const [notes, setNotes] = useState<ApprovedNote[]>([]), [consultations, setConsultations] = useState<BriefConsultationChoice[]>([]);
  const [petId, setPetId] = useState(''), [selection, setSelection] = useState('');
  const [consent, setConsent] = useState(false), [draft, setDraft] = useState<BriefDraft | null>(null), [pending, setPending] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [consultationNotice, setConsultationNotice] = useState(''), [refId, setRefId] = useState('');
  const abort = useRef<AbortController | null>(null), version = useRef(0);
  const cancel = () => { version.current++; abort.current?.abort(); abort.current = null; setPending(false); };
  const reset = () => { cancel(); setDraft(null); setRefId(''); setError(''); setNotice(''); };
  useEffect(() => {
    try { const values = listPets(); setPets(values); setRecords(listOwnerLogs()); setPetId(values[0]?.id ?? ''); } catch (caught) { setError(message(caught)); }
    try { setNotes(listNotes()); } catch (caught) { setConsultationNotice('요약 상담일지: ' + message(caught)); }
    const controller = new AbortController();
    listBriefConsultations(controller.signal).then(result => { if (!controller.signal.aborted) setConsultations(result.consultations ?? []); }).catch(caught => { if (!controller.signal.aborted) setConsultationNotice(previous => (previous + ' 상세 상담 목록: ' + message(caught)).trim()); });
    return () => { controller.abort(); version.current++; abort.current?.abort(); };
  }, []);
  const selected = pets.find(pet => pet.id === petId);
  const note = notes.find(note => 'legacy:' + note.id === selection && note.metadata.petName.trim() === selected?.name.trim());
  const consultation = consultations.find(item => 'server:' + item.id === selection && item.petName.trim() === selected?.name.trim());
  const input: BriefInput | null = selected ? { pet: selected, records, now: new Date().toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...(note ? { previousSession: { date: note.metadata.sessionDate, items: note.draft.items.map(item => ({ id: item.id, text: item.text, category: item.category, sourceQuote: item.sourceQuote })) } } : {}),
    ...(consultation ? { consultation: { id: consultation.id, revision: consultation.revision } } : {}) } : null;
  let factsDraft: BriefDraft | null = null;
  try { if (input) factsDraft = computeBrief({ ...input, consultation: undefined }); } catch { factsDraft = null; }
  const invalidate = (caught: unknown) => {
    setSelection(''); setDraft(null); setError(message(caught) + ' 확정 상담일지를 다시 선택해 주세요.');
    const current = version.current;
    listBriefConsultations().then(result => { if (current === version.current) setConsultations(result.consultations ?? []); }).catch(() => { if (current === version.current) setConsultationNotice('최신 상담 목록을 읽지 못했습니다. 화면을 다시 열어 확인해 주세요.'); });
    try { setNotes(listNotes()); } catch (storageError) { setConsultationNotice(message(storageError)); }
  };
  const generate = async () => {
    if (!input) return;
    reset();
    if (aiReady && !consent) { setError('AI 처리 동의가 필요합니다.'); return; }
    const current = version.current, controller = new AbortController(); abort.current = controller; setPending(true);
    const stillCurrent = () => current === version.current && !controller.signal.aborted;
    const readContext = () => consultation ? getBriefConsultation(consultation.id, input.pet.name, consultation.revision, controller.signal) : Promise.resolve(undefined);
    const validateLegacy = () => {
      if (!note) return;
      let stored: ApprovedNote | undefined;
      try { stored = listNotes().find(stored => stored.id === note.id); }
      catch (caught) { throw new ApiError(message(caught), 'BRIEF_CONSULTATION_INVALID'); }
      if (!stored || JSON.stringify(stored) !== JSON.stringify(note)) throw new ApiError('선택한 요약 상담일지가 변경되었습니다.', 'BRIEF_CONSULTATION_INVALID');
    };
    let context: BriefConsultationContext | undefined;
    try {
      if (selection && !note && !consultation) throw new ApiError('선택한 상담일지가 목록에 없습니다.', 'BRIEF_CONSULTATION_INVALID');
      validateLegacy();
      context = await readContext(); if (!stillCurrent()) return;
      validateLegacy();
      if (!aiReady) { setDraft(computeBrief(input, context)); setNotice('저장된 근거로 코드 브리핑을 만들었습니다.'); return; }
      const result = await generateBrief(input, controller.signal); if (!stillCurrent()) return;
      validateLegacy();
      setDraft(result.draft); setNotice(result.fallbackUsed ? 'AI 선택 실패 · 코드 기반 대체 브리핑입니다. 상세 근거와 질문을 확인해 주세요.' : `${isExternalModel(result.model) ? '외부 AI' : '로컬 AI'}가 근거 우선순위를 선택한 브리핑입니다.`);
      if (result.warnings.length) setError(result.warnings.join(' '));
    } catch (caught) {
      if (!stillCurrent()) return;
      if (caught instanceof ApiError && caught.code === 'BRIEF_CONSULTATION_INVALID') { invalidate(caught); return; }
      // Re-read selected approved context before a fallback after transport errors.
      try {
        validateLegacy();
        context = await readContext(); if (!stillCurrent()) return;
        validateLegacy();
        setDraft(computeBrief(input, context)); setNotice('AI 선택 실패 · 코드 기반 대체 브리핑입니다.');
        setError(message(caught) + ' 근거와 확인 질문을 코드로 구성했습니다.');
      } catch (validationError) { if (stillCurrent()) invalidate(validationError); }
    } finally { if (current === version.current) { abort.current = null; setPending(false); } }
  };
  const current = draft ?? factsDraft, fact = current?.facts.find(item => item.id === refId);
  const renderRefs = (refs: string[]) => refs.length ? <div className="ws-refs">{refs.slice(0, 24).map(id => <button className={refId === id ? 'selected' : ''} key={id} onClick={() => setRefId(id)}>근거 보기</button>)}{refs.length > 24 && <span>나머지 {refs.length - 24}건은 JSON에서 확인</span>}</div> : null;
  const renderTexts = (title: string, values: BriefDraft['summary']) => values.length > 0 && <section className="ws-brief-section"><h3>{title}</h3>{values.map((item, index) => <div className="ws-item" key={title + index}><p>{item.text}</p>{renderRefs(item.refs)}</div>)}</section>;
  const renderSource = (source: BriefSource) => <div className="ws-item" key={source.id}>
    <p className="ws-muted">{sourceKind[source.kind]} · {source.date ?? '날짜 미확인'}{source.occurredAt ? ' · ' + source.occurredAt : source.kind === 'owner' ? ' · 시각 미확인' : ''}{source.scope === 'historical' ? ' · 과거 자료' : source.scope === 'previous' ? ' · 직전 기간' : ''}</p>
    <p>{source.text}</p><blockquote>{source.sourceQuote}</blockquote>
    {source.evidence?.map((evidence, index) => <p key={index}>{evidence.kind === 'vision' ? '시각 관찰' : evidence.kind === 'bookmark' ? '북마크' : '상담 전사'} {time(evidence.startMs)} ~ {time(evidence.endMs)} · “{evidence.quote}”</p>)}
    {source.kind === 'legacy_consultation' && <p className="ws-muted">요약 상담에는 녹음 시간 근거가 없습니다.</p>}
    {source.truncated && <p className="ws-muted">긴 원문·근거 일부 생략. 원본 기록에서 전체 내용을 확인하세요.</p>}
  </div>;
  const evidenceSource = (id: string) => {
    const source = current?.sources?.find(source => source.id === id);
    if (source) return renderSource(source);
    const event = records.flatMap(record => record.draft.events).find(event => event.id === id && event.petId === petId);
    return event ? <p key={id}>보호자 기록 · {event.occurredAt ?? '시각 미확인'} · {event.sourceQuote.slice(0, 400)}</p> : <p key={id}>상세 발췌 범위 밖의 근거입니다. 원본 기록 또는 JSON을 확인해 주세요.</p>;
  };
  return <div className="ws-layout"><section className="input-panel ws-panel"><div className="panel-heading"><div><span className="eyebrow">TRAINER / BRIEF</span><h2>상담 전 브리핑</h2></div><span className="status-tag">훈련사 작업 영역</span></div>
    <p className="ws-muted">보호자 기록의 최근 14일과 직전 14일을 비교합니다. 확정 상담일지 한 건을 직접 연결할 수 있습니다.</p>
    <label className="ws-label">반려동물<select value={petId} onChange={e => { reset(); setPetId(e.target.value); setSelection(''); }}><option value="">선택하세요</option>{pets.map(pet => <option key={pet.id} value={pet.id}>{pet.name}</option>)}</select></label>
    <label className="ws-label">확정 상담일지 (선택 사항)<select value={selection} disabled={!selected} onChange={e => { reset(); setSelection(e.target.value); }}><option value="">상담 연결 없이 만들기</option>
      {notes.filter(note => note.metadata.petName.trim() === selected?.name.trim()).map(note => <option key={note.id} value={'legacy:' + note.id}>요약 상담 · {note.metadata.sessionDate} · {note.metadata.trainerName}</option>)}
      {consultations.filter(item => item.petName.trim() === selected?.name.trim()).map(item => <option key={item.id} value={'server:' + item.id}>상세 상담 · {item.date} · {item.trainerName}</option>)}
    </select></label>
    {consultationNotice && <p className="ws-muted">{consultationNotice}</p>}
    {selected && <div className="ws-box"><h3>사용 자료</h3><p>저장된 보호자 기록 {records.filter(record => record.draft.events.some(e => e.petId === petId)).length}건</p><p>선택 상담: {note ? '확정 요약 · ' + note.metadata.sessionDate : consultation ? '확정 상세 · ' + consultation.date : '선택 없음'}</p>{consultation && <p className="ws-muted">생성할 때 서버의 확정 상태와 현재 내용을 다시 확인합니다.</p>}</div>}
    {aiReady && <label className="ws-check"><input type="checkbox" checked={consent} onChange={e => { setConsent(e.target.checked); if (!e.target.checked) cancel(); }} />선택한 기록을 {processingPhrase(provider)}하는 데 동의합니다.</label>}
    <button className="button primary full" onClick={generate} disabled={!selected || pending}>{pending ? '브리핑 만드는 중' : aiReady ? 'AI 브리핑 만들기' : '기록으로 브리핑 만들기'}</button>{pending && <button className="button secondary full" onClick={cancel}>생성 취소</button>}
    {notice && <p role="status" className="ws-notice">{notice}</p>}{error && <p role="alert" className="ws-error">{error}</p>}{(draft || error) && <IssueReport feature="brief" input={input} output={draft} requestId={draft?.generation?.requestId} error={error} />}
    {current && <div className="ws-box"><h3>자료 범위</h3><p>{current.period.from} ~ {current.period.to} · 기록된 날 {current.period.daysWithRecords}일</p><p className="ws-muted">기록 건수는 실제 행동 횟수가 아닙니다.</p>{current.dataGaps.map((gap, index) => <p className="ws-muted" key={index}>{gap}</p>)}</div>}
    </section>
    <section className="review-panel ws-panel"><div className="panel-heading"><div><span className="eyebrow">BRIEF / SOURCES</span><h2>상담 준비 브리핑</h2></div><span className="status-tag">{current?.mode === 'ollama' ? '로컬 AI 근거 선택' : current?.generation?.fallbackUsed ? '코드 대체 결과' : '코드 브리핑'}</span></div>
      {!current && <p className="ws-empty">반려동물을 선택하면 기록에서 브리핑과 상세 근거를 확인할 수 있습니다.</p>}
      {current && <>{renderTexts('핵심 3줄', current.summary)}{renderTexts('보호자에게 확인할 질문', current.questionsForOwner)}{renderTexts('주의 사항', current.cautions)}{renderTexts('변화', current.changes)}{renderTexts('이전 과제', current.previousTasks)}
      {refId && <div className="ws-evidence" role="status"><strong>선택한 근거</strong>{fact ? <><p>{fact.label}: {String(fact.value)}{fact.unit}</p>{fact.refs.slice(0, 24).map(evidenceSource)}{!fact.refs.length && <p>집계 범위에 해당하는 기록이 없습니다.</p>}</> : evidenceSource(refId)}</div>}
      <details className="ws-brief-section"><summary>상세 근거 · 날짜와 원문</summary>{current.sources?.length ? current.sources.map(renderSource) : <p className="ws-muted">표시할 상세 근거가 없습니다.</p>}</details>
      <details className="ws-brief-section"><summary>사실표 · 기록 수치와 상담 항목</summary><div className="ws-facts"><table><thead><tr><th>항목</th><th>최근 / 원문</th><th>직전</th><th>근거</th></tr></thead><tbody>{current.facts.map(fact => <tr key={fact.id}><th>{fact.label}</th><td>{String(fact.value)}{fact.unit}</td><td>{fact.previousValue === null ? '자료 없음' : String(fact.previousValue) + fact.unit}</td><td>{renderRefs(fact.refs)}</td></tr>)}</tbody></table></div></details>
      <button className="button secondary full" onClick={() => downloadJson('hanggo-brief-' + (selected?.name ?? 'pet') + '.json', current)}>JSON 내보내기</button></>}
    </section></div>;
}
