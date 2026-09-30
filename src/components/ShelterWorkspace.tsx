import { useEffect, useRef, useState } from 'react';
import { generateShelterProfile } from '../feature-api';
import { createManualShelterDraft, deriveShelterProfile, validateShelterDraft } from '../domain/shelter';
import { deleteShelterProfile, listShelterProfiles, saveShelterProfile } from '../domain/shelter-storage';
import type { ShelterDraft, ShelterInput, ShelterMemo, ShelterObservation, SavedShelterProfile } from '../domain/workspace-types';
import { downloadJson, localDate, message } from './workspace-utils';
import IssueReport from './IssueReport';
import LessonMatches from './LessonMatches';

type Props = { aiReady: boolean; serverAvailable?: boolean };
const categoryLabels: Record<ShelterObservation['category'], string> = { people: '사람', dogs: '다른 개', cats: '고양이', walk: '산책', alone: '혼자 있을 때', handling: '신체 접촉', food: '먹이', noise: '소리', house: '실내', other: '기타' };
const valenceLabels = { positive: '긍정', caution: '주의', neutral: '중립' };
const socialityLabels = { observed_positive: '긍정 관찰', observed_caution: '주의 관찰', mixed: '상반된 관찰', unknown: '미확인' };
const memo = (): ShelterMemo => ({ id: crypto.randomUUID(), date: localDate(), role: 'staff', text: '' });

export default function ShelterWorkspace({ aiReady, serverAvailable = false }: Props) {
  const [animal, setAnimal] = useState<ShelterInput['animal']>({ id: crypto.randomUUID(), name: '', species: 'dog', ageMonths: null });
  const [memos, setMemos] = useState<ShelterMemo[]>([memo()]);
  const [history, setHistory] = useState<SavedShelterProfile[]>(() => { try { return listShelterProfiles(); } catch { return []; } });
  const [approvedBy, setApprovedBy] = useState('');
  const [consent, setConsent] = useState(false);
  const [draft, setDraft] = useState<ShelterDraft | null>(null);
  const [saved, setSaved] = useState<SavedShelterProfile | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [quote, setQuote] = useState('');
  const abort = useRef<AbortController | null>(null);
  const version = useRef(0);
  const cancel = () => { version.current++; abort.current?.abort(); abort.current = null; setPending(false); };
  useEffect(() => () => { version.current++; abort.current?.abort(); }, []);
  useEffect(() => { try { setHistory(listShelterProfiles()); } catch (caught) { setError(message(caught)); } }, []);
  const invalidate = () => { cancel(); setDraft(null); setSaved(null); setReviewed(false); setError(''); setQuote(''); };
  const editAnimal = (patch: Partial<ShelterInput['animal']>) => { invalidate(); setAnimal(current => ({ ...current, ...patch })); };
  const editMemo = (id: string, patch: Partial<ShelterMemo>) => { invalidate(); setMemos(current => current.map(item => item.id === id ? { ...item, ...patch } : item)); };
  const newProfile = () => { invalidate(); setAnimal({ id: crypto.randomUUID(), name: '', species: 'dog', ageMonths: null }); setMemos([memo()]); setApprovedBy(''); setConsent(false); setNotice('새 프로필을 시작합니다.'); };
  const generate = async () => {
    invalidate(); setNotice('');
    const input: ShelterInput = { animal: { ...animal, name: animal.name.trim() }, memos: memos.filter(value => value.text.trim()).map(value => ({ ...value, text: value.text.trim() })) };
    if (!input.animal.name || !input.memos.length) { setError('동물 이름과 날짜가 있는 메모를 입력해 주세요.'); return; }
    if (!aiReady) { try { setDraft(createManualShelterDraft(input)); setNotice('메모를 관찰 단위로 나눴습니다. 근거와 소개 문구를 확인해 주세요.'); } catch (caught) { setError(message(caught)); } return; }
    if (!consent) { setError('AI 처리 동의가 필요합니다.'); return; }
    const current = version.current;
    const controller = new AbortController(); abort.current = controller; setPending(true);
    try { const result = await generateShelterProfile(input, controller.signal); if (current !== version.current || controller.signal.aborted) return; setDraft(result.draft); setNotice(result.fallbackUsed ? 'AI 생성에 실패해 수동 검토 초안을 열었습니다.' : '프로필 초안을 만들었습니다. 관찰 근거와 주의 사항을 확인해 주세요.'); if (result.warnings.length) setError(result.warnings.join(' ')); }
    catch (caught) { if (current !== version.current || controller.signal.aborted) return; setError(`${message(caught)} 수동 검토 초안을 열었습니다.`); try { setDraft(createManualShelterDraft(input)); } catch { /* original error remains visible */ } }
    finally { if (current === version.current) { abort.current = null; setPending(false); } }
  };
  const editObservation = (id: string, text: string) => {
    setDraft(current => { if (!current) return null; const observations = current.observations.map(value => value.id === id ? { ...value, text, edited: true } : value); return { ...current, observations, ...deriveShelterProfile(observations) }; });
    setReviewed(false);
  };
  const save = () => {
    if (!draft) return;
    try { const value = saveShelterProfile(draft, approvedBy, reviewed); setHistory(listShelterProfiles()); setSaved(value); setError(''); setNotice('이 브라우저에 프로필을 저장했습니다. 외부에 공개되지 않습니다.'); }
    catch (caught) { setError(message(caught)); }
  };
  const open = (value: SavedShelterProfile) => { cancel(); setAnimal(value.draft.animal); setMemos(value.draft.memos); setDraft(value.draft); setSaved(value); setApprovedBy(value.approvedBy); setReviewed(true); setError(''); setQuote(''); };
  const remove = (value: SavedShelterProfile) => {
    if (!window.confirm('이 프로필을 삭제할까요? 삭제 후 복구할 수 없습니다.')) return;
    try { deleteShelterProfile(value.id); setHistory(listShelterProfiles()); if (saved?.id === value.id) { setSaved(null); setDraft(null); } setNotice('프로필을 삭제했습니다.'); }
    catch (caught) { setError(message(caught)); }
  };
  const errors = draft && !saved ? validateShelterDraft(draft) : [];
  return <div className="ws-layout"><section className="input-panel ws-panel"><div className="panel-heading"><div><span className="eyebrow">SHELTER / PROFILE</span><h2>입양 프로필</h2></div><button className="button secondary" onClick={newProfile}>새 프로필</button></div>
    <p className="ws-muted">날짜가 있는 직원·봉사자 메모만 입력하세요. 관찰이 없는 사회성은 미확인으로 표시합니다.</p>
    <div className="ws-grid"><label className="ws-label">동물 이름<input value={animal.name} onChange={e => editAnimal({ name: e.target.value })} maxLength={100} /></label><label className="ws-label">종<select value={animal.species} onChange={e => editAnimal({ species: e.target.value as 'dog' | 'cat' })}><option value="dog">개</option><option value="cat">고양이</option></select></label><label className="ws-label">나이 · 개월, 모르면 빈칸<input type="number" min="0" max="600" value={animal.ageMonths ?? ''} onChange={e => editAnimal({ ageMonths: e.target.value === '' ? null : Number(e.target.value) })} /></label></div>
    <div className="ws-box"><h3>관찰 메모</h3>{memos.map((value, index) => <div className="ws-memo" key={value.id}><div className="ws-item-head"><strong>메모 {index + 1}</strong>{memos.length > 1 && <button className="ws-link" onClick={() => { invalidate(); setMemos(current => current.filter(item => item.id !== value.id)); }}>삭제</button>}</div><div className="ws-grid"><label className="ws-label">날짜<input type="date" value={value.date} onChange={e => editMemo(value.id, { date: e.target.value })} /></label><label className="ws-label">작성자 역할<select value={value.role} onChange={e => editMemo(value.id, { role: e.target.value as ShelterMemo['role'] })}><option value="staff">직원</option><option value="volunteer">봉사자</option></select></label></div><label className="ws-label">관찰 내용<textarea value={value.text} maxLength={8000} rows={4} onChange={e => editMemo(value.id, { text: e.target.value })} placeholder="직접 관찰한 행동과 상황을 적어 주세요." /></label></div>)}<button className="button secondary" onClick={() => { invalidate(); setMemos(current => [...current, memo()]); }}>메모 추가</button></div>
    {aiReady && <label className="ws-check"><input type="checkbox" checked={consent} onChange={e => { setConsent(e.target.checked); if (!e.target.checked) cancel(); }} />메모를 AI 처리 서버로 보내는 데 동의합니다.</label>}
    <button className="button primary full" onClick={generate} disabled={pending}>{pending ? '프로필 만드는 중' : aiReady ? 'AI 프로필 초안 만들기' : '수동 검토 초안 만들기'}</button>{pending && <button className="button secondary full" onClick={cancel}>생성 취소</button>}
    {notice && <p role="status" className="ws-notice">{notice}</p>}{error && <p role="alert" className="ws-error">{error}</p>}{(draft || error) && <IssueReport feature="shelter" input={{ animal, memos }} output={draft} requestId={draft?.generation?.requestId} error={error} />}
    </section><section className="review-panel ws-panel"><div className="panel-heading"><div><span className="eyebrow">EVIDENCE / APPROVE</span><h2>근거와 최종 확인</h2></div><span className="status-tag">{saved ? '확정됨' : draft ? '검토 대기' : '입력 대기'}</span></div>
    {!draft && <p className="ws-empty">메모를 입력하면 관찰별 근거와 소개 문구가 나타납니다.</p>}
    {draft && <><p className="ws-muted">{draft.mode === 'openai' ? 'AI 초안' : '수동 검토 초안'} · 주의 관찰은 줄이거나 삭제할 수 없습니다.</p>{draft.safetyFlags.length > 0 && <p className="ws-alert">안전 확인: {draft.safetyFlags.join(', ')}</p>}
      <div className="ws-box"><h3>사회성</h3><div className="ws-chips"><span>사람: {socialityLabels[draft.sociability.people]}</span><span>다른 개: {socialityLabels[draft.sociability.dogs]}</span><span>고양이: {socialityLabels[draft.sociability.cats]}</span></div>{draft.unknowns.map((item, index) => <p className="ws-muted" key={index}>{item}</p>)}</div>
      <div className="ws-box"><h3>입양 소개 · 긍정 관찰</h3><p>{draft.adopterIntro.text}</p><h3>함께 안내할 주의 사항</h3><p>{draft.adopterIntro.cautionLine || '기록된 주의 관찰 없음'}</p></div>
      <h3>관찰 근거</h3>{draft.observations.map(value => <article className="ws-item" key={value.id}><div className="ws-item-head"><strong>{categoryLabels[value.category]} · {valenceLabels[value.valence]}</strong><button className="ws-link" onClick={() => setQuote(`${value.memoDate} · ${value.sourceQuote}`)}>메모 근거</button></div><label className="ws-label">관찰 문구<textarea rows={2} disabled={!!saved || value.valence === 'caution'} value={value.text} onChange={e => editObservation(value.id, e.target.value)} /></label><p className="ws-quote">{value.memoDate} · “{value.sourceQuote}”</p></article>)}
      {quote && <p className="ws-evidence" role="status">{quote}</p>}{errors.length > 0 && <div className="ws-error" role="alert"><strong>확정 전 확인</strong><ul>{errors.map(value => <li key={value}>{value}</li>)}</ul></div>}
      {saved ? <button className="button secondary full" onClick={() => downloadJson(`hanggo-shelter-${saved.id}.json`, saved)}>JSON 내보내기</button> : <><label className="ws-label">확정 직원 이름<input value={approvedBy} onChange={e => setApprovedBy(e.target.value)} maxLength={100} /></label><label className="ws-check"><input type="checkbox" checked={reviewed} onChange={e => setReviewed(e.target.checked)} />메모와 모든 관찰·주의 사항을 확인했습니다.</label><button className="button primary full" onClick={save} disabled={!reviewed || !approvedBy.trim() || errors.length > 0}>프로필 확정·저장</button></>}</>}
    <div className="ws-history"><h3>저장한 프로필</h3>{history.length === 0 ? <p>아직 저장한 프로필이 없습니다.</p> : history.map(value => <div className="ws-history-item" key={value.id}><span>{value.draft.animal.name} · {new Date(value.approvedAt).toLocaleDateString('ko-KR')}</span><div><button onClick={() => open(value)}>열기</button><button onClick={() => downloadJson(`hanggo-shelter-${value.id}.json`, value)}>내보내기</button><button onClick={() => remove(value)}>삭제</button></div></div>)}</div>
    {saved && <LessonMatches key={saved.id} profile={saved} available={serverAvailable} />}
    </section></div>;
}
