import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeftIcon, CheckCircleIcon, PlusIcon, TrashIcon, WarningIcon } from '@phosphor-icons/react';
import { approveConsultation, frameUrl, getCase, getConsultation, getMe, regenerateNote, saveNote, setObservation, setSegment } from '../coaching-api';
import type { Consultation, Moment, Segment } from '../domain/coaching';
import type { BehaviorEntry, Claim, CoachingNote, CoachingTask, Evidence, Scene, UnknownField } from '../domain/coaching-note';
import { apiMessage, clockLabel, SPEAKER_NAME, STATE_LABEL } from './copy';
import './call.css';
import './review.css';

const POLL_MS = 3000;
const UNKNOWN_LABEL: Record<UnknownField, string> = { trigger: '계기', frequency: '빈도', duration: '지속 시간', response: '대응과 반응' };
const CLAIM_SECTIONS = [['summary', '핵심 요약'], ['concerns', '고민'], ['guardianReports', '보호자가 말한 내용'], ['trainerObservations', '훈련사 관찰'], ['guidance', '훈련사 안내'], ['followUps', '다음에 확인할 것']] as const;
type SectionKey = typeof CLAIM_SECTIONS[number][0];
const BEHAVIOR_PARTS = [['context', '상황과 계기'], ['behavior', '행동'], ['response', '보호자 대응과 이후 반응']] as const;
const TASK_FIELDS = [['who', '담당'], ['frequency', '횟수'], ['until', '기한'], ['successCriteria', '성공 기준']] as const;
const blankClaim = (): Claim => ({ id: crypto.randomUUID(), text: '', evidence: [] });
const evidenceKey = (evidence: Pick<Evidence, 'kind' | 'id'>) => `${evidence.kind}:${evidence.id}`;

function EvidenceChips({ evidence, onSelect }: { evidence: Evidence[]; onSelect(item: Evidence): void }) {
  if (!evidence.length) return <span className="review-tag">근거 없음 · 훈련사 작성</span>;
  return <>{evidence.map(item => <button key={evidenceKey(item)} type="button" className="review-chip" onClick={() => onSelect(item)}>
    {item.kind === 'scene' ? '장면' : item.kind === 'moment' ? '캐치 메모' : SPEAKER_NAME[item.speaker ?? 'trainer']} {clockLabel(item.startMs)}
  </button>)}</>;
}

function ClaimRow({ claim, label, readOnly, onChange, onDelete, onSelect }: { claim: Claim; label: string; readOnly: boolean; onChange(text: string): void; onDelete(): void; onSelect(item: Evidence): void }) {
  return <div className="review-claim">
    {readOnly ? <p>{claim.text}</p> : <textarea aria-label={`${label} 문장`} rows={2} maxLength={1000} value={claim.text} onChange={event => onChange(event.target.value)} />}
    <div className="review-meta">
      <EvidenceChips evidence={claim.evidence} onSelect={onSelect} />
      {claim.edited && <span className="review-tag">수정함</span>}
      {!readOnly && <button type="button" className="review-icon" aria-label={`${label} 문장 삭제`} onClick={onDelete}><TrashIcon size={14} /></button>}
    </div>
  </div>;
}

function ClaimList({ title, claims, readOnly, onChange, onSelect }: { title: string; claims: Claim[]; readOnly: boolean; onChange(claims: Claim[]): void; onSelect(item: Evidence): void }) {
  if (readOnly && !claims.length) return null;
  return <div className="review-section">
    <h3>{title}</h3>
    {claims.map(claim => <ClaimRow key={claim.id} claim={claim} label={title} readOnly={readOnly} onSelect={onSelect}
      onChange={text => onChange(claims.map(item => item.id === claim.id ? { ...item, text } : item))}
      onDelete={() => onChange(claims.filter(item => item.id !== claim.id))} />)}
    {!readOnly && <button type="button" className="call-link review-add" onClick={() => onChange([...claims, blankClaim()])}><PlusIcon size={13} />{title} 문장 추가</button>}
  </div>;
}

function TaskRow({ task, readOnly, onChange, onDelete, onSelect }: { task: CoachingTask; readOnly: boolean; onChange(task: CoachingTask): void; onDelete(): void; onSelect(item: Evidence): void }) {
  return <div className="review-claim">
    {readOnly ? <p>{task.text}</p> : <textarea aria-label="과제 내용" rows={2} maxLength={1000} value={task.text} onChange={event => onChange({ ...task, text: event.target.value })} />}
    <div className="review-fields">
      {TASK_FIELDS.map(([field, label]) => readOnly
        ? <p key={field}><strong>{label}</strong> {task[field] ?? '미확인'}</p>
        : <label key={field}>{label}<input placeholder="미확인" maxLength={300} value={task[field] ?? ''} onChange={event => onChange({ ...task, [field]: event.target.value.trim() ? event.target.value : null })} /></label>)}
    </div>
    <div className="review-meta">
      <EvidenceChips evidence={task.evidence} onSelect={onSelect} />
      {task.edited && <span className="review-tag">수정함</span>}
      {!readOnly && <button type="button" className="review-icon" aria-label="과제 삭제" onClick={onDelete}><TrashIcon size={14} /></button>}
    </div>
  </div>;
}

function BehaviorCard({ entry, readOnly, onChange, onDelete, onSelect }: { entry: BehaviorEntry; readOnly: boolean; onChange(entry: BehaviorEntry): void; onDelete(): void; onSelect(item: Evidence): void }) {
  return <div className="review-behavior">
    <div className="review-meta">
      {readOnly ? <strong>{entry.title}</strong> : <input aria-label="행동 이름" maxLength={200} value={entry.title} onChange={event => onChange({ ...entry, title: event.target.value })} />}
      {!readOnly && <button type="button" className="review-icon" aria-label={`${entry.title} 행동 삭제`} onClick={onDelete}><TrashIcon size={14} /></button>}
    </div>
    {BEHAVIOR_PARTS.map(([part, label]) => <ClaimList key={part} title={label} claims={entry[part]} readOnly={readOnly} onSelect={onSelect} onChange={claims => onChange({ ...entry, [part]: claims })} />)}
    {entry.unknown.length > 0 && <p className="coach-hint">전사에 없는 항목: {entry.unknown.map(item => UNKNOWN_LABEL[item]).join(', ')}</p>}
  </div>;
}

function SegmentRow({ segment, readOnly, selected, uncited, onSave }: { segment: Segment; readOnly: boolean; selected: boolean; uncited: boolean; onSave(change: { text?: string; echoSuspect?: boolean }): void }) {
  const [editing, setEditing] = useState(false); const [text, setText] = useState(segment.text);
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => { if (selected) row.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }); }, [selected]);
  return <div ref={row} className={`review-line${selected ? ' is-selected' : ''}${segment.echoSuspect ? ' is-echo' : ''}`} data-segment={segment.id} data-selected={selected}>
    <div className="review-meta"><strong>{SPEAKER_NAME[segment.speaker]}</strong><span>{clockLabel(segment.startMs)}</span>
      {uncited && !segment.echoSuspect && segment.state === 'complete' && <span className="review-tag">일지에 쓰이지 않음</span>}
      {segment.echoSuspect && <span className="review-tag">상대 소리가 들어온 것으로 보임</span>}
      {segment.text !== segment.originalText && <span className="review-tag">수정함</span>}
    </div>
    {segment.state === 'failed' ? <p className="coach-hint">받아쓰지 못한 구간입니다.</p>
      : editing ? <form onSubmit={event => { event.preventDefault(); onSave({ text }); setEditing(false); }}>
        <textarea aria-label="전사 수정" rows={3} maxLength={8000} value={text} onChange={event => setText(event.target.value)} />
        <button className="call-link" type="submit">전사 저장</button><button className="call-link" type="button" onClick={() => { setText(segment.text); setEditing(false); }}>취소</button>
      </form> : <p>{segment.text}</p>}
    {!readOnly && !editing && segment.state === 'complete' && <div className="review-meta">
      <button type="button" className="call-link" onClick={() => setEditing(true)}>전사 수정</button>
      {segment.echoSuspect && <button type="button" className="call-link" onClick={() => onSave({ echoSuspect: false })}>실제 발화로 표시</button>}
    </div>}
  </div>;
}

function SceneCard({ consultationId, scene, readOnly, selected, onObservation }: { consultationId: string; scene: Scene; readOnly: boolean; selected: boolean; onObservation(observationId: string, change: { text?: string; reviewed?: boolean }): void }) {
  return <div className={`review-scene${selected ? ' is-selected' : ''}`}>
    <div className="review-meta"><strong>장면</strong><span>{clockLabel(scene.atMs)}</span></div>
    <div className="review-photos">{scene.frameIds.map(id => <img key={id} src={frameUrl(consultationId, id)} alt={`상담 ${clockLabel(scene.atMs)} 장면`} loading="lazy" />)}</div>
    {scene.state === 'failed' && <p className="coach-hint">이 장면은 분석하지 못했습니다.</p>}
    {scene.state === 'complete' && !scene.observations.length && <p className="coach-hint">적을 만한 관찰이 없습니다.</p>}
    {scene.observations.map(item => <div key={item.id} className="review-observation">
      {readOnly ? <p>{item.text}</p> : <textarea aria-label="장면 관찰" rows={2} maxLength={1000} defaultValue={item.text} onBlur={event => { if (event.target.value !== item.text) onObservation(item.id, { text: event.target.value }); }} />}
      <label className="coach-check"><input type="checkbox" disabled={readOnly} checked={item.reviewed} onChange={event => onObservation(item.id, { reviewed: event.target.checked })} />확인한 관찰만 일지에 넣기</label>
    </div>)}
  </div>;
}

function MomentRow({ consultationId, moment, selected }: { consultationId: string; moment: Moment; selected: boolean }) {
  return <div className={`review-scene${selected ? ' is-selected' : ''}`}>
    <div className="review-meta"><strong>캐치</strong><span>{clockLabel(moment.atMs)}</span><span>{SPEAKER_NAME[moment.createdBy]}</span></div>
    {moment.text && <p>{moment.text}</p>}
    <div className="review-photos">{moment.frameIds.map(id => <img key={id} src={frameUrl(consultationId, id)} alt={`캐치 ${clockLabel(moment.atMs)} 사진`} loading="lazy" />)}</div>
  </div>;
}

export function ReviewRoom({ consultationId, navigate }: { consultationId: string; navigate: (path: string) => void }) {
  const [consultation, setConsultation] = useState<Consultation | null>(null);
  const [petName, setPetName] = useState(''); const [note, setNote] = useState<CoachingNote | null>(null);
  const [selected, setSelected] = useState<Evidence | null>(null);
  const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [pending, setPending] = useState(false);
  const dirty = useRef(false);

  const adopt = useCallback((next: Consultation) => {
    setConsultation(next);
    if (!dirty.current) setNote(next.note ?? null);
  }, []);
  useEffect(() => {
    void (async () => {
      try {
        const me = await getMe();
        if (me.role !== 'trainer') { navigate('/guardian'); return; }
        const next = await getConsultation(consultationId);
        adopt(next);
        setPetName((await getCase(next.caseId)).petName);
      } catch (cause) {
        if ((cause as { code?: string }).code === 'AUTH') navigate('/coaching');
        else setError(apiMessage(cause, '상담 기록을 불러오지 못했습니다.'));
      }
    })();
  }, [adopt, consultationId, navigate]);
  const waiting = consultation?.state === 'processing' || !!consultation?.noteGenerating;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => { void getConsultation(consultationId).then(adopt, () => {}); }, POLL_MS);
    return () => clearInterval(timer);
  }, [adopt, consultationId, waiting]);

  const act = async (work: () => Promise<void>) => {
    setPending(true); setError(''); setNotice('');
    try { await work(); } catch (cause) { setError(apiMessage(cause, '요청을 처리하지 못했습니다.')); }
    finally { setPending(false); }
  };
  const edit = (next: CoachingNote) => { dirty.current = true; setNote(next); };
  const save = async () => {
    if (!dirty.current || !note) return;
    const next = await saveNote(consultationId, note);
    dirty.current = false;
    adopt(next);
  };

  if (error && !consultation) return <main className="coach-page"><p role="alert" className="coach-error">{error}</p></main>;
  if (!consultation) return <main className="coach-page"><p role="status">상담 기록을 불러오는 중입니다.</p></main>;
  const readOnly = consultation.state !== 'review' || !!consultation.noteGenerating;
  const uncited = new Set(note?.uncitedSegmentIds ?? []);
  const selectedKey = selected && evidenceKey(selected);
  const failedCount = consultation.segments.filter(item => item.state === 'failed').length;
  return <main className="review-page">
    <header className="review-header">
      <button type="button" className="review-icon" aria-label="상담 목록으로" onClick={() => navigate('/coaching')}><ArrowLeftIcon size={18} /></button>
      <h1>{petName ? `${petName} 상담 검토` : '상담 검토'}</h1>
      <span className="review-state" data-state={consultation.state}>{consultation.noteGenerating ? '일지 다시 만드는 중' : STATE_LABEL[consultation.state]}</span>
      {consultation.state === 'review' && <div className="coach-actions review-actions">
        <button type="button" className="button secondary" disabled={pending || readOnly} onClick={() => { if (window.confirm('지금 초안을 버리고 다시 만들까요? 직접 고친 내용도 사라집니다.')) void act(async () => { dirty.current = false; adopt(await regenerateNote(consultationId)); }); }}>일지 다시 만들기</button>
        <button type="button" className="button secondary" disabled={pending || readOnly} onClick={() => void act(async () => { await save(); setNotice('저장했습니다.'); })}>임시 저장</button>
        <button type="button" className="button primary" disabled={pending || readOnly || !note} onClick={() => { if (window.confirm('확정하면 보호자에게 전달되고 더 고칠 수 없습니다. 확정할까요?')) void act(async () => { await save(); adopt(await approveConsultation(consultationId)); setNotice('확정해 보호자에게 전달했습니다.'); }); }}>확정하고 보호자에게 전달</button>
      </div>}
    </header>
    {notice && <p role="status" className="review-notice"><CheckCircleIcon size={16} />{notice}</p>}
    {error && <p role="alert" className="coach-error">{error}</p>}
    {consultation.state === 'processing' && <p role="status" className="review-notice">상담을 정리하고 있습니다. 끝나면 이 화면이 저절로 바뀝니다.</p>}
    {consultation.state === 'interrupted' && <p role="alert" className="coach-warning">서버가 다시 시작되어 상담이 중단되었습니다. 저장된 전사만 볼 수 있습니다.</p>}
    {note && note.safetyFlags.length > 0 && <p role="alert" className="review-safety"><WarningIcon size={16} />안전 신호: {note.safetyFlags.join(', ')}. 보호자에게 동물병원 상담을 먼저 안내해 주세요.</p>}
    {note?.methodReview && <p className="coach-warning">체벌이나 강압적 방법이 언급되었습니다. 보호자 전달본에서는 이 내용을 뺍니다.</p>}
    {consultation.recordingGaps.length > 0 && <p className="coach-warning">기록이 멈춘 구간: {consultation.recordingGaps.map(gap => `${clockLabel(gap.startMs)}~${gap.endMs === undefined ? '끝' : clockLabel(gap.endMs)}`).join(', ')}</p>}
    {failedCount > 0 && <p className="coach-warning">받아쓰지 못한 구간이 {failedCount}개 있습니다.</p>}
    {consultation.errors.map((item, index) => <p key={index} className="coach-warning">{item.message}</p>)}
    {note && note.warnings.length > 0 && <details className="coach-warning"><summary>자동 검사에서 뺀 내용 {note.warnings.length}건</summary><ul>{note.warnings.map((item, index) => <li key={index}>{item}</li>)}</ul></details>}
    <div className="review-grid">
      <section className="coach-card review-pane" aria-label="전사와 장면">
        <h2>전사</h2>
        {!consultation.segments.length && <p className="coach-hint">받아쓴 내용이 없습니다.</p>}
        {consultation.segments.map(segment => <SegmentRow key={`${segment.id}:${segment.text}`} segment={segment} readOnly={readOnly} selected={selectedKey === `segment:${segment.id}`} uncited={uncited.has(segment.id)}
          onSave={change => void act(async () => { adopt(await setSegment(consultationId, segment.id, change)); })} />)}
        {consultation.moments.length > 0 && <><h2>캐치</h2>{consultation.moments.map(moment => <MomentRow key={moment.id} consultationId={consultationId} moment={moment} selected={selectedKey === `moment:${moment.id}`} />)}</>}
        {consultation.scenes.length > 0 && <><h2>장면 관찰</h2><p className="coach-hint">AI가 사진에서 본 내용입니다. 확인한 관찰만 일지에 들어갑니다.</p>
          {consultation.scenes.map(scene => <SceneCard key={scene.id} consultationId={consultationId} scene={scene} readOnly={readOnly} selected={selectedKey === `scene:${scene.id}`}
            onObservation={(observationId, change) => {
              // A checkbox that waits for the server looks broken on a slow connection, so the screen changes first.
              setConsultation(current => current && { ...current, scenes: current.scenes.map(item => item.id !== scene.id ? item : { ...item, observations: item.observations.map(entry => entry.id === observationId ? { ...entry, ...change } : entry) }) });
              void act(async () => {
                try { adopt(await setObservation(consultationId, scene.id, observationId, change)); }
                catch (cause) { adopt(await getConsultation(consultationId)); throw cause; }
              });
            }} />)}</>}
      </section>
      <section className="coach-card review-pane" aria-label="상담일지">
        <h2>상담일지{consultation.state === 'review' ? ' 초안' : ''}</h2>
        {!note && <p className="coach-hint">{waiting ? '일지를 만드는 중입니다.' : '일지가 없습니다.'}</p>}
        {note?.fallbackUsed && <p className="coach-hint">자동으로 초안을 만들지 못해 빈 양식입니다. 왼쪽 전사를 보고 직접 써 주세요.</p>}
        {note && <>
          {CLAIM_SECTIONS.slice(0, 2).map(([key, title]) => <ClaimList key={key} title={title} claims={note[key as SectionKey]} readOnly={readOnly} onSelect={setSelected} onChange={claims => edit({ ...note, [key]: claims })} />)}
          {note.behaviors.length > 0 && <div className="review-section"><h3>행동</h3>{note.behaviors.map(entry => <BehaviorCard key={entry.id} entry={entry} readOnly={readOnly} onSelect={setSelected}
            onChange={next => edit({ ...note, behaviors: note.behaviors.map(item => item.id === entry.id ? next : item) })} onDelete={() => edit({ ...note, behaviors: note.behaviors.filter(item => item.id !== entry.id) })} />)}</div>}
          {CLAIM_SECTIONS.slice(2).map(([key, title]) => <ClaimList key={key} title={title} claims={note[key as SectionKey]} readOnly={readOnly} onSelect={setSelected} onChange={claims => edit({ ...note, [key]: claims })} />)}
          {note.aiObservations.length > 0 && <ClaimList title="확인한 장면 관찰" claims={note.aiObservations} readOnly onSelect={setSelected} onChange={() => {}} />}
          <div className="review-section">
            <h3>과제</h3>
            {!note.tasks.length && <p className="coach-hint">정한 과제가 없습니다.</p>}
            {note.tasks.map(task => <TaskRow key={task.id} task={task} readOnly={readOnly} onSelect={setSelected}
              onChange={next => edit({ ...note, tasks: note.tasks.map(item => item.id === task.id ? next : item) })} onDelete={() => edit({ ...note, tasks: note.tasks.filter(item => item.id !== task.id) })} />)}
            {!readOnly && <button type="button" className="call-link review-add" onClick={() => edit({ ...note, tasks: [...note.tasks, { id: crypto.randomUUID(), text: '', who: null, frequency: null, until: null, successCriteria: null, evidence: [] }] })}><PlusIcon size={13} />과제 추가</button>}
          </div>
        </>}
      </section>
    </div>
  </main>;
}
