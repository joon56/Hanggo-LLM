import { useEffect, useRef, useState } from 'react';
import { generateOwnerLog } from '../feature-api';
import { createManualOwnerDraft, validateOwnerDraft } from '../domain/owner-log';
import { deleteOwnerLog, listOwnerLogs, listPets, saveOwnerLog, savePets } from '../domain/owner-storage';
import type { EventOutcome, EventTrigger, EventType, OwnerDraft, OwnerEvent, OwnerSourceKind, Pet, SavedOwnerLog } from '../domain/workspace-types';
import SourceInput from './SourceInput';
import IssueReport from './IssueReport';
import { downloadJson, message } from './workspace-utils';

type Props = { aiReady: boolean; localAI?: boolean; sttReady?: boolean };
const eventLabels: Record<EventType, string> = { bark: '짖음', feeding: '식사', walk: '산책', excretion: '배변', rest: '휴식', activity: '활동', training: '훈련', other_behavior: '기타 행동', health_observation: '건강 관찰', other: '기타' };
const triggerLabels: Record<EventTrigger, string> = { doorbell: '초인종', delivery: '배달', visitor: '방문자', stranger: '낯선 사람', other_dog: '다른 개', other_animal: '다른 동물', noise: '소음', left_alone: '혼자 남음', owner_return: '보호자 귀가', food: '음식', unknown: '모름', other: '기타' };
const outcomeLabels: Record<EventOutcome, string> = { stopped: '멈춤', reduced: '줄어듦', continued: '지속', escalated: '심해짐', unknown: '모름' };
const flagLabels: Record<string, string> = { bleeding: '출혈', vomiting: '구토', diarrhea: '설사', not_eating: '식욕 저하', limping: '절뚝거림', seizure: '발작', breathing: '호흡 이상', bite_injury: '물림·상처', sudden_aggression: '갑작스러운 공격성', pain_sign: '통증 신호', other_health: '건강 이상' };
const localTime = (iso: string | null) => iso && !Number.isNaN(Date.parse(iso)) ? new Date(iso).toLocaleString('sv-SE').slice(0, 16).replace(' ', 'T') : '';

export default function OwnerWorkspace({ aiReady, localAI = false, sttReady = true }: Props) {
  const [pets, setPets] = useState<Pet[]>(() => { try { return listPets(); } catch { return []; } });
  const [history, setHistory] = useState<SavedOwnerLog[]>(() => { try { return listOwnerLogs(); } catch { return []; } });
  const [petName, setPetName] = useState('');
  const [nicknames, setNicknames] = useState('');
  const [sourceText, setSourceText] = useState('');
  const [sourceKind, setSourceKind] = useState<OwnerSourceKind>('nl_log_text');
  const [sourceKey, setSourceKey] = useState(0);
  const [consent, setConsent] = useState(false);
  const [sourceReady, setSourceReady] = useState(true);
  const [draft, setDraft] = useState<OwnerDraft | null>(null);
  const [saved, setSaved] = useState<SavedOwnerLog | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [quote, setQuote] = useState('');
  const request = useRef<AbortController | null>(null);
  const version = useRef(0);
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  const cancel = () => { version.current++; request.current?.abort(); request.current = null; setPending(false); };
  useEffect(() => () => { version.current++; request.current?.abort(); }, []);
  useEffect(() => { try { setPets(listPets()); setHistory(listOwnerLogs()); } catch (caught) { setError(message(caught)); } }, []);
  const invalidate = () => { cancel(); setDraft(null); setSaved(null); setReviewed(false); setError(''); };
  const registerPet = () => {
    const name = petName.trim();
    if (!name) { setError('반려동물 이름을 입력해 주세요.'); return; }
    if (pets.some(pet => pet.name.toLocaleLowerCase() === name.toLocaleLowerCase())) { setError('같은 이름의 반려동물이 이미 있습니다.'); return; }
    const next = [...pets, { id: crypto.randomUUID(), name, nicknames: [...new Set(nicknames.split(',').map(value => value.trim()).filter(Boolean))] }];
    try { savePets(next); setPets(next); setPetName(''); setNicknames(''); setError(''); setNotice(`${name} 등록 완료`); invalidate(); }
    catch (caught) { setError(message(caught)); }
  };
  const generate = async () => {
    if (!sourceText.trim()) { setError('일상 기록을 입력해 주세요.'); return; }
    if (!pets.length) { setError('반려동물을 먼저 등록해 주세요.'); return; }
    if (!sourceReady) { setError('받아쓰기를 먼저 확인해 주세요.'); return; }
    const input = { text: sourceText, pets, now: new Date().toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, sourceKind };
    invalidate();
    if (!aiReady) {
      try { setDraft(createManualOwnerDraft(input)); setNotice('수동 검토 초안입니다. 사건과 반려동물을 직접 확인해 주세요.'); }
      catch (caught) { setError(message(caught)); }
      return;
    }
    if (!consent) { setError('AI 처리 동의가 필요합니다.'); return; }
    const current = version.current;
    const controller = new AbortController(); request.current = controller; setPending(true);
    try {
      const result = await generateOwnerLog(input, controller.signal);
      if (current !== version.current || controller.signal.aborted) return;
      setDraft(result.draft);
      setNotice(result.fallbackUsed ? 'AI 생성에 실패해 수동 검토 초안을 열었습니다. 모든 항목을 확인해 주세요.' : '사건 초안을 만들었습니다. 원문과 대조해 주세요.');
      if (result.warnings.length) setError(result.warnings.join(' '));
    } catch (caught) {
      if (current !== version.current || controller.signal.aborted) return;
      setError(`${message(caught)} 수동 검토 초안을 열었습니다.`);
      try { setDraft(createManualOwnerDraft(input)); } catch { /* original error remains visible */ }
    } finally { if (current === version.current) { request.current = null; setPending(false); } }
  };
  const updateEvent = (id: string, patch: Partial<OwnerEvent>) => {
    setDraft(current => current ? { ...current, events: current.events.map(event => event.id === id ? { ...event, ...patch, edited: true } : event) } : null);
    setReviewed(false); setError('');
  };
  const addEvent = () => {
    if (!draft) return;
    const event: OwnerEvent = { id: crypto.randomUUID(), petId: draft.pets.length === 1 ? draft.pets[0].id : null, type: 'other', occurredAt: null, timeHint: null, durationMin: null, trigger: null, intervention: null, outcome: null, details: { amountText: null, isTreat: null, excretionKinds: [], placeText: null }, sourceQuote: draft.sourceText, edited: true };
    setDraft({ ...draft, events: [...draft.events, event] }); setReviewed(false);
  };
  const showQuote = (value: string) => {
    setQuote(value);
    const index = sourceText.indexOf(value);
    if (index >= 0 && sourceRef.current) { sourceRef.current.focus(); sourceRef.current.setSelectionRange(index, index + value.length); }
  };
  const save = () => {
    if (!draft) return;
    try { const value = saveOwnerLog(draft, reviewed); setHistory(listOwnerLogs()); setSaved(value); setSourceKey(key => key + 1); setConsent(false); setError(''); setNotice('이 브라우저에 저장했습니다.'); }
    catch (caught) { setError(message(caught)); }
  };
  const open = (entry: SavedOwnerLog) => { cancel(); setSourceKey(value => value + 1); setConsent(false); setSourceText(entry.draft.sourceText); setSourceKind(entry.draft.sourceKind); setDraft(entry.draft); setSaved(entry); setReviewed(true); setError(''); setQuote(''); };
  const remove = (entry: SavedOwnerLog) => {
    if (!window.confirm('이 기록을 삭제할까요? 삭제 후 복구할 수 없습니다.')) return;
    try { deleteOwnerLog(entry.id); setHistory(listOwnerLogs()); if (saved?.id === entry.id) { setSaved(null); setDraft(null); } setNotice('기록을 삭제했습니다.'); }
    catch (caught) { setError(message(caught)); }
  };
  const newRecord = () => { invalidate(); setSourceKey(value => value + 1); setSourceText(''); setSourceKind('nl_log_text'); setQuote(''); setConsent(false); setNotice('새 기록을 시작합니다.'); };
  const errors = draft && !saved ? validateOwnerDraft(draft) : [];
  return <div className="ws-layout">
    <section className="input-panel ws-panel"><div className="panel-heading"><div><span className="eyebrow">OWNER / DAILY LOG</span><h2>반려동물 일상 기록</h2></div><button className="button secondary" onClick={newRecord}>새 기록</button></div>
      <p className="ws-muted">반려동물을 등록하고, 관찰한 내용을 기록하세요. 저장 전 사건별 내용을 확인합니다.</p>
      <div className="ws-box"><h3>반려동물 등록</h3><div className="ws-row"><label className="ws-label">이름<input value={petName} onChange={event => setPetName(event.target.value)} maxLength={40} /></label><label className="ws-label">별명 · 쉼표로 구분<input value={nicknames} onChange={event => setNicknames(event.target.value)} maxLength={120} /></label><button className="button secondary" onClick={registerPet}>등록</button></div>
        <div className="ws-chips">{pets.map(pet => <span key={pet.id}>{pet.name}{pet.nicknames.length ? ` · ${pet.nicknames.join(', ')}` : ''}</span>)}{!pets.length && <span>등록된 반려동물 없음</span>}</div></div>
      <div className="ws-box"><h3>오늘의 관찰</h3>
        <SourceInput key={sourceKey} aiReady={aiReady} localAI={localAI} sttReady={sttReady} petName={pets.map(pet => pet.name).join(', ')} text={sourceText} textAreaRef={sourceRef} onText={(text, voice) => { invalidate(); setSourceText(text); setSourceKind(voice || sourceKind === 'nl_log_voice' ? 'nl_log_voice' : 'nl_log_text'); }} onConsentChange={value => { setConsent(value); if (!value) cancel(); }} onReadyChange={setSourceReady} />
        {quote && <p className="ws-quote">원문 근거: “{quote}”</p>}
        <button className="button primary full" onClick={generate} disabled={pending || !sourceText.trim() || !sourceReady || !pets.length}>{pending ? '초안 만드는 중' : aiReady ? 'AI 사건 초안 만들기' : '수동 검토 초안 만들기'}</button>{pending && <button className="button secondary full" onClick={cancel}>생성 취소</button>}</div>
      {notice && <p role="status" className="ws-notice">{notice}</p>}{error && <p role="alert" className="ws-error">{error}</p>}{(draft || error) && <IssueReport feature="owner" input={{ sourceText, sourceKind, pets }} output={draft} requestId={draft?.generation?.requestId} error={error} />}
    </section>
    <section className="review-panel ws-panel"><div className="panel-heading"><div><span className="eyebrow">REVIEW / SAVE</span><h2>사건 확인</h2></div><span className="status-tag">{saved ? '저장됨' : draft ? `${draft.events.length}건` : '대기 중'}</span></div>
      {!draft && <p className="ws-empty">관찰을 입력하면 여기에서 사건별 반려동물·시각·내용을 확인할 수 있습니다.</p>}
      {draft && <><p className="ws-muted">{draft.mode === 'ollama' ? '로컬 AI 초안' : draft.mode === 'openai' ? 'AI 초안' : '수동 검토 초안'} · 원문 근거를 열어 사실을 확인하세요.</p>{draft.clarification && <p className="ws-alert">확인 필요: {draft.clarification}</p>}{draft.safetyFlags.length > 0 && <p className="ws-alert">안전 확인: {draft.safetyFlags.map(flag => flagLabels[flag] ?? flag).join(', ')}</p>}
        {draft.events.map((event, index) => <article className="ws-item" key={event.id}><div className="ws-item-head"><strong>사건 {index + 1}</strong><button className="ws-link" onClick={() => showQuote(event.sourceQuote)}>원문 근거</button></div>
          <div className="ws-grid"><label className="ws-label">유형<select disabled={!!saved} value={event.type} onChange={e => updateEvent(event.id, { type: e.target.value as EventType })}>{Object.entries(eventLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label className="ws-label">반려동물<select disabled={!!saved} value={event.petId ?? ''} onChange={e => updateEvent(event.id, { petId: e.target.value || null })}><option value="">확인 필요</option>{pets.map(pet => <option key={pet.id} value={pet.id}>{pet.name}</option>)}</select></label>
            <label className="ws-label">발생 시각<input type="datetime-local" disabled={!!saved} value={localTime(event.occurredAt)} onChange={e => updateEvent(event.id, { occurredAt: e.target.value ? new Date(e.target.value).toISOString() : null })} /></label>
            <label className="ws-label">지속 시간 · 분<input type="number" min="0" max="600" disabled={!!saved} value={event.durationMin ?? ''} onChange={e => updateEvent(event.id, { durationMin: e.target.value === '' ? null : Number(e.target.value) })} /></label></div>
          <div className="ws-grid"><label className="ws-label">계기<select disabled={!!saved} value={event.trigger ?? ''} onChange={e => updateEvent(event.id, { trigger: (e.target.value || null) as EventTrigger | null })}><option value="">기록 없음</option>{Object.entries(triggerLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="ws-label">결과<select disabled={!!saved} value={event.outcome ?? ''} onChange={e => updateEvent(event.id, { outcome: (e.target.value || null) as EventOutcome | null })}><option value="">기록 없음</option>{Object.entries(outcomeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
          <label className="ws-label">대응·관찰 문구<textarea disabled={!!saved} rows={2} maxLength={2000} value={event.intervention ?? ''} onChange={e => updateEvent(event.id, { intervention: e.target.value || null })} placeholder="원문에서 확인할 수 있는 내용만 적어 주세요." /></label>
          <div className="ws-grid"><label className="ws-label">양·횟수 문구<input disabled={!!saved} maxLength={300} value={event.details.amountText ?? ''} onChange={e => updateEvent(event.id, { details: { ...event.details, amountText: e.target.value || null } })} /></label><label className="ws-label">장소 문구<input disabled={!!saved} maxLength={300} value={event.details.placeText ?? ''} onChange={e => updateEvent(event.id, { details: { ...event.details, placeText: e.target.value || null } })} /></label></div>
          <div className="ws-grid"><label className="ws-label">간식 여부<select disabled={!!saved} value={event.details.isTreat === null ? '' : String(event.details.isTreat)} onChange={e => updateEvent(event.id, { details: { ...event.details, isTreat: e.target.value === '' ? null : e.target.value === 'true' } })}><option value="">기록 없음</option><option value="true">간식</option><option value="false">간식 아님</option></select></label><label className="ws-label">배변 종류<select disabled={!!saved} value={event.details.excretionKinds[0] ?? ''} onChange={e => updateEvent(event.id, { details: { ...event.details, excretionKinds: e.target.value ? [e.target.value as 'pee' | 'poop' | 'unknown'] : [] } })}><option value="">기록 없음</option><option value="pee">소변</option><option value="poop">대변</option><option value="unknown">불명</option></select></label></div>
          <label className="ws-label">이 사건의 원문 근거<textarea disabled={!!saved} rows={2} value={event.sourceQuote} onChange={e => updateEvent(event.id, { sourceQuote: e.target.value })} /></label>
          <p className="ws-quote">원문에 있는 구절을 그대로 선택해야 합니다.</p>{!saved && <button className="ws-link" onClick={() => { setDraft(current => current ? { ...current, events: current.events.filter(item => item.id !== event.id) } : null); setReviewed(false); }}>사건 삭제</button>}</article>)}
        {!saved && <button className="button secondary" onClick={addEvent}>사건 추가</button>}
        {errors.length > 0 && <div className="ws-error" role="alert"><strong>저장 전 확인</strong><ul>{[...new Set(errors)].map(value => <li key={value}>{value}</li>)}</ul></div>}
        {saved ? <button className="button secondary full" onClick={() => downloadJson(`hanggo-owner-${saved.id}.json`, saved)}>JSON 내보내기</button> : <><label className="ws-check"><input type="checkbox" checked={reviewed} onChange={e => setReviewed(e.target.checked)} />원문과 사건 내용을 확인했습니다.</label><button className="button primary full" onClick={save} disabled={!reviewed || errors.length > 0}>검토 후 저장</button></>}</>}
      <div className="ws-history"><h3>저장한 일상 기록</h3>{history.length === 0 ? <p>아직 저장한 기록이 없습니다.</p> : history.map(entry => <div className="ws-history-item" key={entry.id}><span>{new Date(entry.savedAt).toLocaleDateString('ko-KR')} · {entry.draft.events.length}건</span><div><button onClick={() => open(entry)}>열기</button><button onClick={() => downloadJson(`hanggo-owner-${entry.id}.json`, entry)}>내보내기</button><button onClick={() => remove(entry)}>삭제</button></div></div>)}</div>
    </section>
  </div>;
}
