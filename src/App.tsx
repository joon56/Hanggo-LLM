import { useEffect, useRef, useState } from 'react';
import { ArrowRightIcon, BookOpenTextIcon, CheckIcon, FileTextIcon, InfoIcon, MicrophoneIcon, NotebookIcon, PawPrintIcon, PlusIcon, ShieldCheckIcon, StopIcon, TextAlignLeftIcon, TrashIcon, XIcon } from '@phosphor-icons/react';
import { approveDraft, createDraft, createManualDraft } from './domain/notes';
import type { ApprovedNote, Draft, Metadata, NoteItem, SourceKind } from './domain/notes';
import { deleteNote, listNotes, saveNote } from './domain/storage';
import { useRecorder } from './hooks/useRecorder';
import NoteReview from './components/NoteReview';
import ConnectionPanel from './components/ConnectionPanel';
import { generateNote, getSession, login, logout, transcribe, verifyAudibleAudio } from './api';
import type { Session } from './api';
import OwnerWorkspace from './components/OwnerWorkspace';
import BriefWorkspace from './components/BriefWorkspace';
import ShelterWorkspace from './components/ShelterWorkspace';
import LessonMatches from './components/LessonMatches';
import IssueReport from './components/IssueReport';
import './workspace.css';
import './navigation.css';

const example = '보호자는 초코가 현관 소리에 짖는다고 말했습니다.\n오늘 훈련 중 초코가 앉아 신호에 반응하는 모습을 관찰했습니다.\n신호를 짧고 일정하게 말하도록 안내했습니다.\n이번 주 과제는 상담에서 연습한 앉아를 같은 조건에서 반복하기로 했습니다.\n다음 상담에서 현관 소리에 반응한 상황을 확인하기로 했습니다.';

function localDate() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function initialHistory() {
  try { return { notes: listNotes(), error: '' }; }
  catch (error) { return { notes: [], error: error instanceof Error ? error.message : '저장한 기록을 읽지 못했습니다.' }; }
}

export default function App() {
  const publicDemo = import.meta.env.VITE_PUBLIC_DEMO === 'true';
  const [workspace, setWorkspace] = useState<'notes' | 'ownerLog' | 'brief' | 'shelter'>('notes');
  const [history, setHistory] = useState<ApprovedNote[]>([]);
  const [error, setError] = useState('');
  const [session, setSession] = useState<Session | null>(publicDemo ? {
    authenticated: true, requirePassword: false, aiEnabled: false, configured: false, textModel: '', sttModel: '', features: { ownerLog: true, brief: true, shelter: true },
  } : null);
  const [sessionError, setSessionError] = useState('');
  const [sessionLoading, setSessionLoading] = useState(!publicDemo);
  const [localDemo, setLocalDemo] = useState(false);
  const [consent, setConsent] = useState(false);
  const [pending, setPending] = useState<'note' | 'transcribe' | null>(null);
  const [transcriptNeedsReview, setTranscriptNeedsReview] = useState(false);
  const [transcriptConfirmed, setTranscriptConfirmed] = useState(false);
  const [notice, setNotice] = useState('');
  const [inputMode, setInputMode] = useState<'text' | 'voice'>('voice');
  const [sourceKind, setSourceKind] = useState<SourceKind>('trainer_summary_text');
  const [sourceText, setSourceText] = useState('');
  const [metadata, setMetadata] = useState<Metadata>({ petName: '', trainerName: '', sessionDate: localDate() });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState<ApprovedNote | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [highlight, setHighlight] = useState('');
  const [deletePending, setDeletePending] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  const requestVersion = useRef(0);
  const requestAbort = useRef<AbortController | null>(null);
  const recorder = useRecorder();
  const recording = recorder.status === 'recording' || recorder.status === 'requesting';
  const aiReady = !!session?.aiEnabled && !!session.configured && !localDemo;

  useEffect(() => {
    if (publicDemo) return;
    let active = true;
    const controller = new AbortController();
    getSession(controller.signal).then(value => {
      if (!active) return;
      setSession(value); setSessionError(''); setSessionLoading(false);
    }).catch(caught => {
      if (!active) return;
      setSessionError(caught instanceof Error ? caught.message : '서버 연결 오류'); setSessionLoading(false);
    });
    return () => { active = false; controller.abort(); requestVersion.current++; requestAbort.current?.abort(); };
  }, []);

  useEffect(() => {
    if ((!session && !(import.meta.env.DEV && localDemo)) || session?.requirePassword && !session.authenticated) return;
    const initial = initialHistory();
    setHistory(initial.notes); setError(initial.error);
  }, [session, localDemo]);

  const retrySession = async () => {
    setSessionLoading(true); setSessionError('');
    try { setSession(await getSession()); }
    catch (caught) { setSessionError(caught instanceof Error ? caught.message : '서버 연결 오류'); }
    finally { setSessionLoading(false); }
  };
  const loginSession = async (password: string) => {
    try { setSession(await login(password)); setSessionError(''); }
    catch (caught) { setSessionError(caught instanceof Error ? caught.message : '로그인 실패'); }
  };
  const logoutSession = async () => {
    cancelPending();
    try { setSession(await logout()); setHistory([]); setDraft(null); setSaved(null); setSourceText(''); recorder.reset(); }
    catch (caught) { setSessionError(caught instanceof Error ? caught.message : '로그아웃 실패'); }
  };
  const cancelPending = () => {
    requestVersion.current++;
    requestAbort.current?.abort(); requestAbort.current = null;
    setPending(null);
  };

  const invalidate = () => {
    if (pending) setNotice('입력이 바뀌어 이전 요청 결과를 사용하지 않습니다.');
    cancelPending();
    if (draft) setNotice('원문이 바뀌었습니다. 일지 초안을 다시 만들어 주세요.');
    setDraft(null); setSaved(null); setReviewed(false); setHighlight(''); setError('');
  };
  const changeSource = (value: string) => {
    invalidate(); setSourceText(value);
    if (transcriptNeedsReview) setTranscriptConfirmed(false);
    else setSourceKind('trainer_summary_text');
  };
  const changeMetadata = (field: keyof Metadata, value: string) => { invalidate(); setMetadata(current => ({ ...current, [field]: value })); };

  const newNote = () => {
    cancelPending(); setTranscriptNeedsReview(false); setTranscriptConfirmed(false); setConsent(false);
    recorder.reset(); setSourceText(''); setDraft(null); setSaved(null); setReviewed(false); setHighlight('');
    setMetadata(current => ({ petName: '', trainerName: current.trainerName, sessionDate: localDate() }));
    setError(''); setNotice('새 상담 기록을 시작합니다.'); setSourceKind('trainer_summary_text');
  };
  const loadExample = () => {
    setTranscriptNeedsReview(false); setTranscriptConfirmed(false);
    recorder.reset(); invalidate(); setInputMode('text'); setSourceKind('trainer_summary_text'); setSourceText(example);
    setMetadata({ petName: '초코', trainerName: '김행고', sessionDate: localDate() });
    setNotice('가상의 예시를 불러왔습니다. 직접 수정하며 흐름을 살펴보세요.');
  };
  const generate = async () => {
    if (transcriptNeedsReview && !transcriptConfirmed) { setError('받아쓰기 내용을 확인해 주세요.'); return; }
    let version = requestVersion.current;
    try {
      if (!aiReady) {
        setDraft(createDraft(sourceText, sourceKind)); setSaved(null); setReviewed(false); setHighlight(''); setError('');
        setNotice('규칙으로 초안을 정리했습니다. 분류와 내용을 직접 확인해 주세요.');
        return;
      }
      if (!consent) { setError('외부 AI 처리에 동의해 주세요.'); return; }
      cancelPending();
      version = requestVersion.current;
      const controller = new AbortController(); requestAbort.current = controller;
      setDraft(null); setSaved(null); setReviewed(false); setHighlight('');
      setPending('note'); setError(''); setNotice('AI가 초안을 정리하고 있습니다.');
      const result = await generateNote(sourceText, sourceKind, controller.signal);
      if (version !== requestVersion.current) return;
      setDraft(result.draft); setSaved(null); setReviewed(false); setHighlight('');
      setNotice(result.fallbackUsed ? 'AI 처리에 실패해 수동 검토 초안을 만들었습니다. 모든 항목을 확인해 주세요.' : 'AI 초안을 만들었습니다. 원문과 모든 항목을 확인해 주세요.');
      if (result.warnings.length) setError(result.warnings.join(' '));
    } catch (caught) {
      if (!aiReady || version !== requestVersion.current || requestAbort.current?.signal.aborted) return;
      try {
        setDraft(createManualDraft(sourceText, sourceKind));
        setSaved(null); setReviewed(false);
        setError(caught instanceof Error ? caught.message : 'AI 요청에 실패했습니다.');
        setNotice('수동 검토 초안을 만들었습니다. 원문을 보존하고 모든 항목을 추가 확인으로 표시했습니다.');
      } catch (fallbackError) { setError(fallbackError instanceof Error ? fallbackError.message : '초안을 만들지 못했습니다.'); }
    } finally { if (version === requestVersion.current) { setPending(null); requestAbort.current = null; } }
  };

  const transcribeRecording = async () => {
    if (!recorder.audioBlob) return;
    if (!consent) { setError('외부 AI 처리에 동의해 주세요.'); return; }
    cancelPending();
    const version = requestVersion.current;
    const controller = new AbortController(); requestAbort.current = controller;
    setDraft(null); setSaved(null); setReviewed(false); setHighlight('');
    setPending('transcribe'); setError(''); setNotice('음성을 받아쓰는 중입니다.');
    try {
      await verifyAudibleAudio(recorder.audioBlob);
      if (version !== requestVersion.current) return;
      const result = await transcribe(recorder.audioBlob, recorder.duration, metadata.petName, controller.signal);
      if (version !== requestVersion.current) return;
      setSourceText(result.text); setSourceKind('trainer_summary_voice'); setDraft(null); setSaved(null); setReviewed(false);
      setTranscriptNeedsReview(true); setTranscriptConfirmed(false);
      setNotice('받아쓰기를 확인하고 필요하면 수정해 주세요.');
    } catch (caught) {
      if (version !== requestVersion.current) return;
      setError(caught instanceof Error ? caught.message : '받아쓰기에 실패했습니다. 원본 녹음은 남아 있습니다.');
    } finally { if (version === requestVersion.current) { setPending(null); requestAbort.current = null; } }
  };
  const updateItem = (id: string, patch: Partial<NoteItem>) => {
    setDraft(current => current ? { ...current, items: current.items.map(item => item.id === id ? { ...item, ...patch } : item) } : null);
    setReviewed(false); setError('');
  };
  const removeItem = (id: string) => {
    setDraft(current => current ? { ...current, items: current.items.filter(item => item.id !== id) } : null);
    setReviewed(false);
  };
  const approve = () => {
    if (!draft) return;
    try {
      const note = approveDraft(draft, metadata, reviewed);
      saveNote(note); setHistory(listNotes()); setSaved(note); setDraft(note.draft);
      setNotice('이 브라우저에 저장했습니다.'); setError(''); recorder.reset();
    } catch (caught) { setError(caught instanceof Error ? caught.message : '저장하지 못했습니다.'); }
  };
  const openNote = (note: ApprovedNote) => {
    cancelPending(); setTranscriptNeedsReview(false); setTranscriptConfirmed(false);
    recorder.reset(); setMetadata(note.metadata); setSourceText(note.draft.sourceText); setSourceKind(note.draft.sourceKind);
    setDraft(note.draft); setSaved(note); setReviewed(true); setError(''); setNotice('저장한 기록을 열었습니다.'); setHighlight('');
  };
  const removeSaved = (id: string) => {
    try {
      deleteNote(id); setHistory(listNotes()); setDeletePending(null);
      if (saved?.id === id) newNote();
      setNotice('이 브라우저에서 기록을 삭제했습니다.');
    } catch (caught) { setError(caught instanceof Error ? caught.message : '삭제하지 못했습니다.'); }
  };
  const showSource = (quote: string) => {
    setHighlight(quote);
    const index = sourceText.indexOf(quote);
    if (index >= 0 && sourceRef.current) {
      sourceRef.current.focus(); sourceRef.current.setSelectionRange(index, index + quote.length);
      sourceRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };
  const exportNote = () => {
    if (!saved) return;
    const blob = new Blob([JSON.stringify(saved, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `hanggo-note-${saved.metadata.sessionDate}-${saved.id.slice(0, 8)}.json`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const startRecording = async () => {
    invalidate(); setTranscriptConfirmed(false);
    if (!transcriptNeedsReview) setSourceKind('trainer_summary_text');
    setNotice(''); await recorder.start();
  };
  const changeInputMode = (mode: 'text' | 'voice') => { setInputMode(mode); if (mode === 'text') { cancelPending(); recorder.reset(); } };
  const workspaceLabels = { notes: '상담일지', ownerLog: '보호자 일상 기록', brief: '상담 전 브리핑', shelter: '보호소 프로필' };
  const changeWorkspace = (next: typeof workspace) => {
    if (next === workspace) return;
    if (recording || recorder.audioBlob) {
      if (!window.confirm('다른 기능으로 이동하면 현재 녹음이 삭제됩니다. 이동할까요?')) return;
    }
    cancelPending(); recorder.reset(); setWorkspace(next);
  };

  const connection = publicDemo
    ? <section className="connection-panel" aria-label="공개 체험판"><strong>공개 체험판 · AI 연결 없음</strong><span>텍스트 정리·녹음 재생·검토·저장을 체험하세요. AI 생성·받아쓰기는 제공하지 않습니다. 가상 자료를 사용하세요.</span></section>
    : <ConnectionPanel session={session} loading={sessionLoading} error={sessionError} onRetry={retrySession} onLogin={loginSession} onLogout={logoutSession} localDemo={localDemo} onDemo={value => { cancelPending(); setLocalDemo(value); }} />;
  if (sessionLoading || (!session && !(import.meta.env.DEV && localDemo)) || (session?.requirePassword && !session.authenticated)) return <div className="connection-gate">{connection}</div>;

  return <div className="app-shell">
    <aside className="sidebar" aria-label="상담 기록 탐색">
      <a className="brand" href="#main"><span className="brand-symbol"><PawPrintIcon weight="fill" size={25} /></span><span>행고<span className="brand-dot">.</span></span></a>
      <div className="workspace-label">TRAINER WORKSPACE</div>
      <nav className="workspace-nav" aria-label="기능 선택">{(Object.keys(workspaceLabels) as (keyof typeof workspaceLabels)[]).filter(key => key === 'notes' || publicDemo || localDemo || session?.features?.[key]).map(key => <button key={key} className={workspace === key ? 'active-nav' : 'workspace-nav-button'} aria-current={workspace === key ? 'page' : undefined} onClick={() => changeWorkspace(key)}><NotebookIcon size={20} /><span>{workspaceLabels[key]}</span></button>)}</nav>
      {workspace === 'notes' && <>
      <button className="new-note button secondary" onClick={newNote}><PlusIcon size={17} />새 상담 기록</button>
      <div className="history-heading"><span>저장한 기록</span><span>{history.length}</span></div>
      <nav className="history-list" aria-label="저장한 기록">
        {!history.length && <div className="history-empty"><FileTextIcon size={24} weight="light" /><p>승인한 기록이<br />여기에 모입니다.</p></div>}
        {history.map(note => <div className={`history-entry ${saved?.id === note.id ? 'selected' : ''}`} key={note.id}>
          <button className="history-open" onClick={() => openNote(note)} aria-label={`${note.metadata.petName} ${note.metadata.sessionDate} 기록 열기`}><span className="pet-initial">{note.metadata.petName.slice(0, 1)}</span><span><strong>{note.metadata.petName}</strong><small>{note.metadata.sessionDate}</small></span></button>
          <button className="icon-button history-delete" aria-label={`${note.metadata.petName} 기록 삭제`} onClick={() => setDeletePending(note.id)}><TrashIcon size={15} /></button>
          {deletePending === note.id && <div className="delete-confirm"><span>이 기록을 삭제할까요?</span><button onClick={() => removeSaved(note.id)}>삭제</button><button onClick={() => setDeletePending(null)}>취소</button></div>}
        </div>)}
      </nav>
      </>}
      <div className="sidebar-bottom"><div className="local-status"><span />승인한 기록은 이 브라우저에 보관</div><p>상담의 기록이<br />다음 훈련의 시작이 되도록.</p><span className="sidebar-version">HANGGO / 0.2</span></div>
    </aside>

    <div className="workspace">
      <header className="topbar"><div className="breadcrumbs">행고 기록 공간<span>/</span><strong>{workspaceLabels[workspace]}</strong></div><div className="topbar-actions"><span className="demo-badge">{aiReady ? 'AI' : 'DEMO'}</span>{workspace === 'notes' && <button className="help-button" onClick={() => setShowHelp(value => !value)} aria-expanded={showHelp}><InfoIcon size={18} />사용 안내</button>}</div></header>
      <main id="main">
        {connection}
        {workspace === 'ownerLog' && <OwnerWorkspace aiReady={aiReady} />}
        {workspace === 'brief' && <BriefWorkspace aiReady={aiReady} />}
        {workspace === 'shelter' && <ShelterWorkspace aiReady={aiReady} serverAvailable={!publicDemo && !localDemo} />}
        {workspace === 'notes' && <>
        <section className="page-intro"><div><span className="eyebrow">AFTER THE SESSION</span><h1>대화의 끝에서,<br className="mobile-break" /> 기록의 시작.</h1><p>짧게 남긴 상담 요약을, 다음 훈련으로 이어지는 일지로.</p></div><div className="intro-caption"><BookOpenTextIcon size={27} weight="light" /><span>말하고, 확인하고,<br /><strong>기록으로 남기세요.</strong></span></div></section>
        <div className="flow-strip" aria-label="진행 단계"><span className={!draft ? 'current' : 'complete'}><i>{draft ? <CheckIcon size={13} /> : '1'}</i>요약 남기기</span><ArrowRightIcon /><span className={draft && !saved ? 'current' : saved ? 'complete' : ''}><i>{saved ? <CheckIcon size={13} /> : '2'}</i>원문과 초안 확인</span><ArrowRightIcon /><span className={saved ? 'current' : ''}><i>3</i>승인하고 보관</span><span className="flow-note">{aiReady ? 'AI 초안 · 훈련사 최종 검토' : '로컬 규칙 분류'}</span></div>
        {showHelp && <section className="help-panel"><button className="icon-button help-close" aria-label="사용 안내 닫기" onClick={() => setShowHelp(false)}><XIcon /></button><h2>상담 기록 흐름</h2><p>텍스트를 입력하거나 3~60초 녹음 후 받아쓰기를 확인하세요. 외부 AI 처리는 동의한 뒤 실행됩니다. 원문 근거와 초안을 검토하고 승인하면 이 브라우저에 저장됩니다.</p><p>녹음은 새 기록을 열거나 페이지를 닫으면 사라집니다. 승인한 기록은 목록에서 삭제할 수 있습니다. 안전 표시는 전문가 검토를 대신하지 않습니다.</p></section>}
        <div className="announcements" aria-live="polite">{notice && <p className="notice"><CheckCircleSmall />{notice}</p>}{error && <p role="alert" className="error-notice">{error}</p>}</div>

        <div className="editor-grid">
          <section className="input-panel" aria-labelledby="input-title">
            <div className="panel-heading"><div><span className="eyebrow">01 / CAPTURE</span><h2 id="input-title">상담 요약 남기기</h2></div>{!saved && <button className="text-button" onClick={loadExample} disabled={recording}>예시 불러오기<ArrowRightIcon size={14} /></button>}</div>
            <div className="session-fields"><label>반려동물 이름<input value={metadata.petName} placeholder="이름 입력" maxLength={40} onChange={event => changeMetadata('petName', event.target.value)} readOnly={!!saved} /></label><label>상담 날짜<input type="date" value={metadata.sessionDate} onChange={event => changeMetadata('sessionDate', event.target.value)} readOnly={!!saved} /></label><label>훈련사 이름<input value={metadata.trainerName} placeholder="이름 입력" maxLength={40} onChange={event => changeMetadata('trainerName', event.target.value)} readOnly={!!saved} /></label></div>
            {!saved && <>
              <div className="input-tabs" role="group" aria-label="입력 방식"><button aria-pressed={inputMode === 'voice'} className={inputMode === 'voice' ? 'selected' : ''} onClick={() => changeInputMode('voice')} disabled={recording}><MicrophoneIcon size={17} />음성으로 남기기</button><button aria-pressed={inputMode === 'text'} className={inputMode === 'text' ? 'selected' : ''} onClick={() => changeInputMode('text')} disabled={recording}><TextAlignLeftIcon size={17} />직접 입력하기</button></div>
              {inputMode === 'voice' && <div className={`recorder ${recording ? 'is-recording' : ''}`}>
                <span className="recorder-label">상담이 끝난 뒤, 기억나는 내용을 짧게</span>
                <button className="record-button" aria-label={recorder.status === 'recording' ? '녹음 정지' : '녹음 시작'} onClick={recorder.status === 'recording' ? recorder.stop : startRecording} disabled={recorder.status === 'requesting'}>{recorder.status === 'recording' ? <StopIcon size={25} weight="fill" /> : <MicrophoneIcon size={28} weight="fill" />}</button>
                <strong>{recorder.status === 'requesting' ? '마이크 권한을 확인해 주세요' : recorder.status === 'recording' ? '요약을 듣고 있어요' : recorder.status === 'ready' ? '녹음을 다시 들어보세요' : '눌러서 녹음을 시작하세요'}</strong>
                <div className="record-timer"><span>{String(Math.floor(recorder.duration / 60)).padStart(2, '0')}:{String(recorder.duration % 60).padStart(2, '0')}</span><span>/ 01:00</span></div>
                {recorder.status === 'requesting' && <button className="text-button" onClick={() => { cancelPending(); recorder.reset(); }}>요청 취소</button>}
                {recorder.audioUrl && <div className="audio-preview"><audio controls src={recorder.audioUrl} aria-label="상담 요약 녹음 재생" /><button className="icon-button" onClick={() => { if (!window.confirm('녹음을 삭제할까요?\n삭제한 녹음은 복구할 수 없습니다.')) return; cancelPending(); recorder.reset(); }} aria-label="녹음 삭제"><TrashIcon size={18} /></button></div>}
                {aiReady && recorder.audioBlob && <button className="button secondary" onClick={transcribeRecording} disabled={!!pending || !consent}>음성 받아쓰기</button>}
                <p>녹음은 재생 전에는 이 기기에만 있습니다. 받아쓰기를 누르면 동의한 음성이 외부 AI로 전송됩니다.</p>
                {recorder.error && <p className="recorder-error" role="alert">{recorder.error}</p>}
              </div>}
            </>}
            <div className="source-heading"><label htmlFor="source-text">{inputMode === 'voice' && !saved ? '받아쓰기 · 직접 입력' : '상담 요약 원문'}</label><span>{sourceText.length.toLocaleString()} / 8,000</span></div>
            <textarea ref={sourceRef} id="source-text" aria-label="상담 요약 원문" className="source-text" value={sourceText} maxLength={8000} readOnly={!!saved} onChange={event => changeSource(event.target.value)} placeholder={'어떤 이야기를 나눴나요?\n\n보호자가 말한 상황, 직접 관찰한 내용, 안내와 합의한 과제를 편하게 남겨 주세요.\n\n음성으로 녹음했다면 다시 들으며 입력해 주세요.'} />
            {transcriptNeedsReview && !saved && <label className="review-checkbox"><input type="checkbox" checked={transcriptConfirmed} onChange={event => setTranscriptConfirmed(event.target.checked)} />받아쓰기 내용을 듣고 확인했습니다.</label>}
            {highlight && <div className="source-highlight"><span>선택한 항목의 원문 근거</span><blockquote>{highlight}</blockquote></div>}
            <div className="source-caption"><ShieldCheckIcon size={17} /><span>훈련사의 사후 요약입니다. 실제 상담 녹취가 아닙니다.</span></div>
            {!saved && <>{aiReady && <label className="review-checkbox consent-checkbox"><input type="checkbox" checked={consent} onChange={event => { if (!event.target.checked) cancelPending(); setConsent(event.target.checked); }} />음성·텍스트를 외부 AI에 보내 처리하는 데 동의합니다.</label>}{pending && <div className="pending-actions" role="status">{pending === 'note' ? 'AI 초안 생성 중…' : '음성 받아쓰기 중…'} <button className="text-button" onClick={() => { cancelPending(); setNotice('요청을 취소했습니다. 이미 시작된 AI 처리는 비용이 발생할 수 있습니다.'); }}>취소</button></div>}<button className="button primary full generate-button" onClick={generate} disabled={!sourceText.trim() || recording || !!pending || (aiReady && !consent) || (transcriptNeedsReview && !transcriptConfirmed)}><FileTextIcon size={19} />일지 초안 만들기<ArrowRightIcon className="button-end" size={19} /></button><p className="input-footnote">{aiReady ? 'AI 초안은 원문과 비교해 직접 확인해 주세요.' : '로컬 규칙으로 입력 문장을 분류합니다.'}</p></>}
          </section>
          <NoteReview draft={draft} saved={saved} reviewed={reviewed} canApprove={!pending && !recording && !!metadata.petName.trim() && !!metadata.trainerName.trim() && !!metadata.sessionDate} onReview={setReviewed} onChange={updateItem} onRemove={removeItem} onSource={showSource} onApprove={approve} onExport={exportNote} />
        </div>
        {(draft || error) && <IssueReport feature="session-notes" input={{ sourceText, sourceKind }} output={draft} requestId={draft?.generation?.requestId} error={error} />}
        {saved && <LessonMatches key={saved.id} note={saved} available={!publicDemo && !localDemo} />}
        </>}
        <footer className="page-footer"><span>행고 · 우리아이 행동고민</span><span>관찰을 기록하고, 다음 만남으로 연결합니다.</span></footer>
      </main>
    </div>
  </div>;
}

function CheckCircleSmall() { return <CheckIcon size={15} weight="bold" />; }
