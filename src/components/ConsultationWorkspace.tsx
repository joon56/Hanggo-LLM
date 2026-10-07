import { useEffect, useRef, useState } from 'react';
import { addBookmark, approveConsultation, deleteConsultation, exportUrl, finishConsultation, generateConsultationNote, getConsultation, listConsultations, recordingUrl, updateConsultationNote, updateSegment } from '../consultation-api';
import { consultationSections, validateConsultationNote } from '../domain/consultation';
import type { ConsultationNote, ConsultationSection, ConsultationSession, TranscriptSegment } from '../domain/consultation';
import type { Metadata } from '../domain/notes';
import { useConsultationRecorder } from '../hooks/useConsultationRecorder';
import '../consultation.css';

const labels: Record<ConsultationSection, string> = { purpose: '상담 목적·고민', owner_report: '보호자 보고', observation: '상담 중 관찰', guidance: '훈련사 안내', task: '합의한 과제', follow_up: '후속 확인', moments: '중요 장면' };
const stateLabels = { preparing: '준비 중', recording: '녹화 중', processing: '받아쓰기 처리 중', ready: '검토 가능', incomplete: '불완전 기록', interrupted: '중단된 기록' };
const captureLabels = { idle: '공유할 탭을 선택해 주세요', requesting: '탭·마이크 권한 확인 중', preparing: '로컬 모델 준비 중 · 잠시 기다려 주세요', recording: '상담 녹화 중', finishing: '남은 녹화 저장·받아쓰기 완료 대기 중', blocked: '저장 미완료 · 재시도 필요', ready: '녹화 저장 완료' };
function time(ms: number) { const seconds = Math.floor(ms / 1000); return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`; }
function localDate() { return new Date().toLocaleDateString('sv-SE'); }
function normalizeNote(note: ConsultationNote, session: ConsultationSession): ConsultationNote {
  return { ...note, approvedAt: undefined, missingSections: consultationSections.filter(section => !note.items.some(item => item.section === section)), coveredSegmentIds: session.segments.filter(segment => segment.state === 'complete' && segment.text.trim()).map(segment => segment.id) };
}
function validationMessage(errors: string[]) {
  if (errors.includes('UNSUPPORTED_TEXT') || errors.includes('EVIDENCE')) return '원문에 있는 정확한 인용만 저장할 수 있습니다. 받아쓰기를 먼저 수정하고 일지를 다시 생성해 주세요.';
  if (errors.includes('COVERAGE')) return '일부 받아쓰기 근거가 빠졌습니다. 모든 원문 구간의 근거를 유지하거나 일지를 다시 생성해 주세요.';
  return '비어 있는 일지 항목 또는 잘못된 분류·근거가 있습니다. 원문 근거가 있는 항목을 유지해 주세요.';
}
function TranscriptEditor({ segment, index, disabled, onSave, onSeek, onDirtyChange }: { segment: TranscriptSegment; index: number; disabled: boolean; onSave: (text: string) => void; onSeek: () => void; onDirtyChange: (dirty: boolean) => void }) {
  const [text, setText] = useState(segment.text);
  useEffect(() => { setText(segment.text); }, [segment.text]);
  return <article className={`consultation-segment ${segment.state === 'failed' ? 'failed' : ''}`}>
    <div className="consultation-row"><button className="text-button" onClick={onSeek}>{time(segment.startMs)}–{time(segment.endMs)}</button><span>{segment.state === 'complete' ? `완료${segment.latencyMs !== undefined ? ` · 처리 ${(segment.latencyMs / 1000).toFixed(1)}초` : ''}` : segment.state === 'failed' ? '받아쓰기 실패 · 원본 녹화를 확인해 주세요' : segment.state === 'processing' ? '받아쓰기 처리 중' : '받아쓰기 대기'}</span></div>
    {segment.state === 'complete' && <><textarea aria-label={`받아쓰기 ${index + 1}`} value={text} maxLength={16000} onChange={event => { setText(event.target.value); onDirtyChange(event.target.value !== segment.text); }} disabled={disabled} /><div className="consultation-row"><button className="text-button" aria-label={`받아쓰기 ${index + 1} 저장`} disabled={disabled || text === segment.text} onClick={() => onSave(text)}>원문 수정 저장</button>{text !== segment.text && <button className="text-button" aria-label={`받아쓰기 ${index + 1} 수정 취소`} disabled={disabled} onClick={() => { setText(segment.text); onDirtyChange(false); }}>수정 취소</button>}{segment.text !== segment.originalText && <span>원문 수정됨 · 최초 받아쓰기 보존</span>}</div></>}
  </article>;
}

export default function ConsultationWorkspace({ ready, model, onBusyChange }: { ready: boolean; model: string; onBusyChange?: (value: boolean) => void }) {
  const recorder = useConsultationRecorder();
  const [history, setHistory] = useState<ConsultationSession[]>([]); const [selected, setSelected] = useState<ConsultationSession | null>(null);
  const [metadata, setMetadata] = useState<Metadata>({ petName: '', trainerName: '', sessionDate: localDate() }); const [consent, setConsent] = useState(false); const [microphone, setMicrophone] = useState(false);
  const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [pending, setPending] = useState(false);
  const [bookmarkText, setBookmarkText] = useState(''); const [bookmarkSeconds, setBookmarkSeconds] = useState('0');
  const [note, setNote] = useState<ConsultationNote | undefined>(); const [dirty, setDirty] = useState(false); const [reviewed, setReviewed] = useState(false);
  const [dirtySegments, setDirtySegments] = useState<Set<string>>(new Set());
  const previewRef = useRef<HTMLVideoElement>(null); const replayRef = useRef<HTMLVideoElement>(null); const selectedId = useRef<string | undefined>(undefined); const mounted = useRef(true);
  const busy = recorder.busy || pending;
  const refresh = async () => { try { const result = await listConsultations(); if (mounted.current) setHistory(result.sessions); } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : '저장한 상담을 읽지 못했습니다.'); } };
  const receive = (session: ConsultationSession, resetNote = true) => { if (selectedId.current !== session.id) setDirtySegments(new Set()); selectedId.current = session.id; setSelected(session); if (resetNote) { setNote(session.note); setDirty(false); setReviewed(false); } };
  const markTranscriptDirty = (id: string, value: boolean) => { setReviewed(false); setDirtySegments(current => { if (current.has(id) === value) return current; const next = new Set(current); if (value) next.add(id); else next.delete(id); return next; }); };
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; }; }, []);
  useEffect(() => { onBusyChange?.(busy); return () => { onBusyChange?.(false); }; }, [busy, onBusyChange]);
  useEffect(() => { if (previewRef.current) previewRef.current.srcObject = recorder.preview; }, [recorder.preview]);
  useEffect(() => { if (recorder.session) { receive(recorder.session); void refresh(); } }, [recorder.session]);
  useEffect(() => {
    if (!selected || !(['recording', 'processing', 'preparing'].includes(selected.state) || recorder.busy)) return;
    const id = selected.id; let running = false; let disposed = false;
    const timer = setInterval(async () => { if (running) return; running = true; try { const value = await getConsultation(id); if (!disposed && mounted.current && selectedId.current === id) receive(value, false); } catch (cause) { if (!disposed) setError(`상태 확인 실패: ${cause instanceof Error ? cause.message : String(cause)}. 녹화가 끝날 때까지 탭을 유지해 주세요.`); } finally { running = false; } }, 2000);
    return () => { disposed = true; clearInterval(timer); };
  }, [selected?.id, selected?.state, recorder.busy]);
  const run = async (action: () => Promise<ConsultationSession>, message = '') => {
    setPending(true); setError(''); setNotice('');
    try { const value = await action(); if (mounted.current) { receive(value); setNotice(message); void refresh(); } } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : '요청에 실패했습니다.'); } finally { if (mounted.current) setPending(false); }
  };
  const open = (session: ConsultationSession) => { if (busy) return; setError(''); setNotice(''); setConsent(false); setBookmarkText(''); setBookmarkSeconds('0'); receive(session); void run(() => getConsultation(session.id)); };
  const remove = async (session: ConsultationSession) => {
    if (busy || !window.confirm(`${session.metadata.petName} 상담의 녹화·받아쓰기·일지를 영구 삭제합니다. 삭제 후 복구할 수 없습니다. 계속할까요?`)) return;
    setPending(true); setError('');
    try { await deleteConsultation(session.id); if (selectedId.current === session.id) { selectedId.current = undefined; setSelected(null); setNote(undefined); } await refresh(); } catch (cause) { setError(cause instanceof Error ? cause.message : '삭제에 실패했습니다.'); } finally { setPending(false); }
  };
  const seek = (ms: number) => { if (replayRef.current) { replayRef.current.currentTime = ms / 1000; replayRef.current.focus(); } };
  const changeNote = (next: ConsultationNote) => { if (!selected) return; setNote(normalizeNote(next, selected)); setDirty(true); setReviewed(false); setError(''); };
  const saveNote = () => { if (!selected || !note) return; const next = normalizeNote(note, selected); const errors = validateConsultationNote(next, selected); if (errors.length) { setError(validationMessage(errors)); return; } void run(() => updateConsultationNote(selected.id, next), '원문 근거를 확인해 일지 수정을 저장했습니다.'); };
  const finished = selected && !['recording', 'processing', 'preparing'].includes(selected.state);
  const noteErrors = selected && note ? validateConsultationNote(note, selected) : ['INPUT'];
  const captureDuration = recorder.busy ? recorder.durationMs : selected?.durationMs ?? recorder.durationMs;
  const completedEnd = Math.max(0, ...(selected?.segments.filter(segment => segment.state === 'complete').map(segment => segment.endMs) ?? []));
  const delay = Math.max(0, captureDuration - completedEnd);
  return <div className="consultation-workspace">
    <section className="page-intro"><div><span className="eyebrow">LIVE CONSULTATION / LOCAL</span><h1>상담을 함께 보고,<br />원문으로 기록하세요.</h1><p>최대 60분 · Windows Chrome/Edge 탭 공유 · 로컬 받아쓰기 {model}</p></div></section>
    <div className="consultation-layout">
      <aside className="consultation-panel consultation-history" aria-label="저장한 상담"><div className="consultation-row"><h2>저장한 상담</h2><button className="text-button" onClick={() => void refresh()} disabled={pending}>새로고침</button></div>
        <p className="consultation-hint">녹화·받아쓰기·일지는 이 PC 서버에 저장됩니다. 페이지를 다시 열면 저장된 구간을 확인할 수 있습니다.</p>
        {!history.length && <p>저장한 상담이 없습니다.</p>}
        {history.map(session => <div className={`consultation-history-item ${session.id === selected?.id ? 'selected' : ''}`} key={session.id}><button onClick={() => open(session)} disabled={busy} aria-label={`${session.metadata.petName} ${session.metadata.sessionDate} 열기`}><strong>{session.metadata.petName}</strong><small>{session.metadata.sessionDate} · {time(session.durationMs)} · {stateLabels[session.state]}</small></button><button className="text-button" aria-label={`${session.metadata.petName} 상담 삭제`} onClick={() => void remove(session)} disabled={busy}>삭제</button></div>)}
      </aside>
      <div className="consultation-main">
        <section className="consultation-panel"><div className="consultation-row"><div><span className="eyebrow">01 / CAPTURE</span><h2>새 상담 녹화</h2></div><span className="consultation-local">LOCAL ONLY</span></div>
          <div className="session-fields"><label>반려동물 이름<input value={metadata.petName} maxLength={200} disabled={busy} onChange={event => setMetadata({ ...metadata, petName: event.target.value })} /></label><label>상담 날짜<input type="date" value={metadata.sessionDate} disabled={busy} onChange={event => setMetadata({ ...metadata, sessionDate: event.target.value })} /></label><label>훈련사 이름<input value={metadata.trainerName} maxLength={200} disabled={busy} onChange={event => setMetadata({ ...metadata, trainerName: event.target.value })} /></label></div>
          <p className="consultation-hint">공유 창에서 <strong>브라우저 탭</strong>과 <strong>탭 오디오 공유</strong>를 선택하세요. 공유 전 상담 참여자에게 녹화·로컬 처리 동의를 받으세요.</p>
          <label className="review-checkbox"><input type="checkbox" checked={microphone} disabled={busy} onChange={event => setMicrophone(event.target.checked)} />내 마이크 함께 녹음</label>
          <p className="consultation-hint">내 목소리가 탭 오디오에 포함되지 않으면 마이크를 켜세요. 이어폰 사용 권장. 공유 미리보기는 음소거됩니다.</p>
          <label className="review-checkbox"><input type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} />상담 참여자 동의를 받았으며 녹화·음성을 이 PC의 로컬 AI 서버에서 처리하는 데 동의합니다.</label>
          {!ready && <p role="status" className="consultation-hint">로컬 받아쓰기 모델을 준비해 주세요. 저장된 상담은 검토할 수 있습니다.</p>}
          <div className="consultation-actions"><button className="button primary" disabled={!ready || busy || !consent || !metadata.petName.trim() || !metadata.trainerName.trim() || !metadata.sessionDate} onClick={() => { setError(''); setNotice(''); selectedId.current = undefined; setSelected(null); setNote(undefined); setDirty(false); setReviewed(false); setBookmarkText(''); void recorder.start(metadata, microphone); }}>탭 공유·녹화 시작</button>
            {['recording', 'requesting', 'preparing'].includes(recorder.status) && <button className="button secondary" onClick={() => void recorder.stop()}>녹화 종료·저장</button>}
            {recorder.status === 'blocked' && <button className="button secondary" onClick={() => void recorder.retry()}>저장 재시도</button>}
          </div>
          <div className="consultation-capture-status" role="status"><strong>{captureLabels[recorder.status]}</strong><span>{time(recorder.durationMs)} / 60:00</span><span>업로드 대기 {(recorder.pendingBytes / 1024 / 1024).toFixed(1)}MB</span></div>
          {recorder.status === 'recording' && <label className="consultation-audio-level">입력 소리 수준<meter aria-label="입력 소리 수준" min="0" max="1" value={recorder.audioLevel} />{recorder.audioLevel > 0 ? '소리 감지됨' : '조용함 · 탭 오디오·마이크를 확인하세요'}</label>}
          {recorder.busy && <p className="consultation-hint">저장 완료까지 이 탭을 유지하세요. 창을 닫으면 전송되지 않은 구간은 복구할 수 없으며 저장된 구간만 남습니다.</p>}
          {recorder.preview && <video ref={previewRef} autoPlay playsInline muted className="consultation-video" aria-label="공유 탭 미리보기" />}
        </section>
        {(error || recorder.error) && <p role="alert" className="error-notice">{error || recorder.error}</p>}{notice && <p role="status" className="notice">{notice}</p>}
        {selected && <>
          <section className="consultation-panel"><div className="consultation-row"><div><span className="eyebrow">02 / SOURCE</span><h2>{selected.metadata.petName} · 상담 원문</h2></div><strong>{stateLabels[selected.state]}</strong></div>
            <p className="consultation-hint">{selected.metadata.sessionDate} · {selected.metadata.trainerName} · {time(captureDuration)} · 받아쓰기 지연 {(delay / 1000).toFixed(1)}초 · 실패 {selected.segments.filter(segment => segment.state === 'failed').length}구간</p>
            {!recorder.busy && ['recording', 'processing'].includes(selected.state) && <div className="consultation-warning"><p>이 화면에서는 녹화가 진행되고 있지 않습니다. 이전 공유 탭이 닫혔다면 저장된 구간만 남겨 중단된 상담을 정리하세요. 다른 탭에서 녹화 중이면 그 탭에서 종료하세요.</p><button className="button secondary" disabled={pending} onClick={() => { if (!window.confirm('다른 탭에서 이 상담을 녹화하고 있지 않은지 확인해 주세요. 저장된 구간만 남겨 불완전 기록으로 종료할까요?')) return; const durationMs = Math.max(selected.durationMs, 0, ...selected.segments.map(segment => segment.endMs), ...selected.bookmarks.map(bookmark => bookmark.atMs)); void run(() => finishConsultation(selected.id, durationMs, '이전 공유 탭이 닫혀 저장된 구간만 복구했습니다. 전송되지 않은 구간은 누락될 수 있습니다.'), '중단된 상담을 정리했습니다. 저장된 구간과 누락 상태를 확인해 주세요.'); }}>중단된 상담 정리</button></div>}
            {['interrupted', 'incomplete'].includes(selected.state) && <p className="consultation-warning">중단 또는 누락된 구간이 있습니다. 저장된 녹화·원문을 검토할 수 있으며 일지 확정은 차단됩니다. 녹화 이어하기는 지원하지 않습니다.</p>}
            {selected.errors.map((item, index) => <p className="consultation-warning" key={index}>{item.code}: {item.message}{item.sequence !== undefined ? ` · 구간 ${item.sequence + 1}` : ''}</p>)}
            {finished && selected.recordingChunkCount > 0 && <><video key={selected.id} ref={replayRef} controls playsInline preload="metadata" className="consultation-video" src={recordingUrl(selected.id)} aria-label="상담 녹화 재생" onError={() => setError('녹화 재생을 준비하지 못했습니다. 서버 연결·저장 상태를 확인해 주세요.')} /><div className="consultation-actions"><a className="text-button" href={recordingUrl(selected.id)} download="consultation.webm">녹화 내려받기</a><a className="text-button" href={exportUrl(selected.id)} download="consultation.json">JSON 내보내기</a></div></>}
            <div className="consultation-bookmark"><h3>수동 순간 메모</h3><div className="consultation-bookmark-fields"><label>순간 시각 · 초<input type="number" min="0" max={Math.ceil(captureDuration / 1000)} step="0.001" value={recorder.busy ? (recorder.durationMs / 1000).toFixed(3) : bookmarkSeconds} disabled={recorder.busy || pending} onChange={event => setBookmarkSeconds(event.target.value)} /></label><label>순간 메모<input value={bookmarkText} maxLength={2000} disabled={pending} placeholder="직접 본 장면·들은 말" onChange={event => setBookmarkText(event.target.value)} /></label><button className="button secondary" disabled={!bookmarkText.trim() || pending || !['recording', 'ready', 'incomplete', 'interrupted'].includes(selected.state)} onClick={() => { const atMs = recorder.busy ? recorder.durationMs : Math.round(Number(bookmarkSeconds) * 1000); if (!Number.isFinite(atMs) || atMs < 0 || atMs > captureDuration) { setError('메모 시각은 상담 시간 안에서 지정해 주세요.'); return; } void run(() => addBookmark(selected.id, atMs, bookmarkText), '순간 메모를 저장했습니다. 일지를 다시 생성해 주세요.'); setBookmarkText(''); }}>순간 메모 저장</button></div>
              {selected.bookmarks.map(bookmark => <div className="consultation-row" key={bookmark.id}><button className="text-button" onClick={() => seek(bookmark.atMs)}>{time(bookmark.atMs)}</button><span>{bookmark.text}</span></div>)}
            </div>
            <h3>받아쓰기 · 직접 수정</h3><p className="consultation-hint">화자 자동 식별·영상 자동 해석은 하지 않습니다. 원문을 수정하면 기존 일지를 다시 생성해야 합니다.</p>
            {dirtySegments.size > 0 && <p className="consultation-warning">저장하지 않은 받아쓰기 수정이 있습니다. 각 구간의 원문 수정을 저장하거나 취소한 뒤 일지 생성·검토를 진행하세요.</p>}
            {!selected.segments.length && <p>첫 받아쓰기 구간을 기다리고 있습니다.</p>}
            {selected.segments.map((segment, index) => <TranscriptEditor key={segment.id} segment={segment} index={index} disabled={busy || !finished} onSeek={() => seek(segment.startMs)} onDirtyChange={value => markTranscriptDirty(segment.id, value)} onSave={text => void run(async () => { const value = await updateSegment(selected.id, segment.id, text); markTranscriptDirty(segment.id, false); return value; }, '받아쓰기를 수정했습니다. 일지를 다시 생성해 주세요.')} />)}
          </section>
          <section className="consultation-panel"><div className="consultation-row"><div><span className="eyebrow">03 / REVIEW</span><h2>근거가 연결된 상담 일지</h2></div><button className="button secondary" disabled={!finished || busy || dirtySegments.size > 0 || !selected.segments.some(segment => segment.state === 'complete' && segment.text.trim()) && !selected.bookmarks.length} onClick={() => void run(() => generateConsultationNote(selected.id), '초안을 만들었습니다. 원문 근거와 분류를 검토해 주세요.')}>상담 일지 만들기</button></div>
            <p className="consultation-hint">원문에 있는 정확한 인용만 저장할 수 있습니다. 내용 수정은 받아쓰기 원문부터, 분류 수정은 아래 항목에서 진행하세요.</p>
            {note?.fallbackUsed && <p className="consultation-warning">일부 구간을 원문 인용으로 대체했습니다. 분류와 전체 원문을 검토해 주세요.</p>}{note?.warnings?.map((warning, index) => <p className="consultation-warning" key={index}>{warning}</p>)}
            {consultationSections.map(section => <section className="consultation-note-section" key={section}><h3>{labels[section]}</h3>{!note?.items.some(item => item.section === section) && <p className="consultation-missing">분류된 항목 없음 · 원문을 확인해 주세요</p>}
              {note?.items.map((item, index) => item.section === section && <article className="consultation-note-item" key={item.id}><div className="consultation-row"><label>분류<select aria-label={`일지 항목 ${index + 1} 분류`} value={item.section} disabled={busy} onChange={event => changeNote({ ...note, items: note.items.map(current => current.id === item.id ? { ...current, section: event.target.value as ConsultationSection } : current) })}>{consultationSections.map(value => <option key={value} value={value}>{labels[value]}</option>)}</select></label><button className="text-button" aria-label={`일지 항목 ${index + 1} 삭제`} disabled={busy} onClick={() => changeNote({ ...note, items: note.items.filter(current => current.id !== item.id) })}>삭제</button></div>
                <textarea aria-label={`일지 항목 ${index + 1}`} value={item.text} maxLength={2000} disabled={busy} onChange={event => { const text = event.target.value; changeNote({ ...note, items: note.items.map(current => current.id !== item.id ? current : { ...current, text, evidence: current.evidence.map(evidence => { const source = evidence.kind === 'segment' ? selected.segments.find(segment => segment.id === evidence.id)?.text : selected.bookmarks.find(bookmark => bookmark.id === evidence.id)?.text; return source?.includes(text) && text.trim() ? { ...evidence, quote: text } : evidence; }) }) }); }} />
                {item.fallback && <p className="consultation-hint">원문 인용으로 대체한 항목입니다.</p>}{item.evidence.map((evidence, index) => <div className="consultation-evidence" key={index}><button className="text-button" onClick={() => seek(evidence.startMs)}>{time(evidence.startMs)} · {evidence.kind === 'segment' ? '받아쓰기 근거' : '수동 메모 근거'}</button><blockquote>{evidence.quote}</blockquote></div>)}
              </article>)}
            </section>)}
            {note && <><div className="consultation-actions"><button className="button secondary" disabled={busy || !dirty} onClick={saveNote}>일지 수정 저장</button>{note.approvedAt && <strong className="consultation-approved">검토·확정됨</strong>}</div>
              <label className="review-checkbox"><input type="checkbox" checked={reviewed} disabled={busy || dirty || dirtySegments.size > 0 || !!note.approvedAt} onChange={event => setReviewed(event.target.checked)} />녹화·받아쓰기·모든 일지 항목의 원문 근거를 확인했습니다.</label><button className="button primary" disabled={busy || dirty || dirtySegments.size > 0 || !reviewed || noteErrors.length > 0 || selected.state !== 'ready' || !!note.approvedAt} onClick={() => void run(() => approveConsultation(selected.id), '상담 일지를 검토·확정했습니다.')}>검토 후 확정</button>
            </>}
          </section>
        </>}
      </div>
    </div>
  </div>;
}
