import { useState } from 'react';
import { draftGuardianLog, saveGuardianLog } from '../coaching-api';
import type { OwnerDraft } from '../domain/workspace-types';
import { apiMessage } from './copy';
import { VoiceNote } from './VoiceNote';

const EVENT_NAME: Record<string, string> = { bark: '짖음', feeding: '급식', walk: '산책', excretion: '배변', rest: '휴식', activity: '활동', training: '훈련', other_behavior: '기타 행동', health_observation: '건강 관찰', other: '기타' };
/** Noon, so a date picked in any time zone stays on that day. */
const dateToIso = (date: string) => new Date(`${date}T12:00:00`).toISOString();
const localToday = () => { const now = new Date(); return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };

/** The guardian checks what was understood before anything is saved, because the record feeds the trainer's next brief. */
export function GuardianLogForm({ caseId }: { caseId: string }) {
  const [text, setText] = useState(''); const [draft, setDraft] = useState<OwnerDraft | null>(null);
  const [pending, setPending] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const today = localToday();
  const act = (work: () => Promise<void>) => {
    setPending(true); setError(''); setNotice('');
    work().catch(cause => setError(apiMessage(cause, '기록하지 못했습니다.'))).finally(() => setPending(false));
  };
  const setEventDate = (eventId: string, date: string) => setDraft(current => current && { ...current, events: current.events.map(event => event.id === eventId ? { ...event, occurredAt: date ? (date === today ? current.now : dateToIso(date)) : null, edited: true } : event) });
  return <section aria-label="일상 기록" className="delivery">
    <h2>일상 기록</h2>
    <p className="coach-hint">있었던 일을 편하게 적어 주세요. 훈련사가 다음 상담 전에 읽습니다.</p>
    {!draft && <>
      <textarea aria-label="일상 기록 내용" className="delivery-input" rows={3} maxLength={8000} value={text} onChange={event => setText(event.target.value)} />
      <div className="coach-actions">
        <button type="button" className="button primary" disabled={pending || !text.trim()} onClick={() => act(async () => setDraft(await draftGuardianLog(caseId, text.trim())))}>{pending ? '확인하는 중' : '내용 확인'}</button>
        <VoiceNote caseId={caseId} label="일상 기록" onText={spoken => setText(current => `${current}${current ? ' ' : ''}${spoken}`)} onError={setError} />
      </div>
    </>}
    {draft && <div className="delivery-task">
      <h3>이렇게 기록합니다</h3>
      <ul>{draft.events.map(event => <li key={event.id}>
        <strong>{EVENT_NAME[event.type] ?? '기타'}</strong> “{event.sourceQuote}”
        <label className="delivery-memo">언제였나요?<input type="date" max={today} aria-label="언제였나요" value={event.occurredAt ? new Date(new Date(event.occurredAt).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10) : ''} onChange={change => setEventDate(event.id, change.target.value)} /></label>
      </li>)}</ul>
      {draft.safetyFlags.length > 0 && <p role="alert" className="review-safety">몸 상태와 관련된 내용이 있습니다. 걱정되면 동물병원에 먼저 문의해 주세요.</p>}
      <div className="coach-actions">
        <button type="button" className="button primary" disabled={pending} onClick={() => act(async () => { await saveGuardianLog(caseId, draft); setDraft(null); setText(''); setNotice('저장했습니다. 훈련사가 다음 상담 전에 봅니다.'); })}>저장</button>
        <button type="button" className="button secondary" disabled={pending} onClick={() => setDraft(null)}>다시 쓰기</button>
      </div>
    </div>}
    {notice && <p role="status" className="coach-hint">{notice}</p>}
    {error && <p role="alert" className="coach-error">{error}</p>}
  </section>;
}
