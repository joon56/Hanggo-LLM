import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { transcribe, verifyAudibleAudio } from '../api';
import { useRecorder } from '../hooks/useRecorder';

type Props = {
  aiReady: boolean;
  sttReady?: boolean;
  petName: string;
  text: string;
  onText: (text: string, voice: boolean) => void;
  onConsentChange?: (consent: boolean) => void;
  onReadyChange?: (ready: boolean) => void;
  textAreaRef?: RefObject<HTMLTextAreaElement | null>;
};

export default function SourceInput({ aiReady, sttReady = true, petName, text, onText, onConsentChange, onReadyChange, textAreaRef }: Props) {
  const recorder = useRecorder();
  const [mode, setMode] = useState<'text' | 'voice'>('text');
  const [consent, setConsent] = useState(false);
  const [reviewNeeded, setReviewNeeded] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const abort = useRef<AbortController | null>(null);
  const version = useRef(0);
  const cancel = () => { version.current++; abort.current?.abort(); abort.current = null; setPending(false); };

  useEffect(() => () => { version.current++; abort.current?.abort(); }, []);
  useEffect(() => { onReadyChange?.((!reviewNeeded || confirmed) && !pending && recorder.status !== 'recording' && recorder.status !== 'requesting'); }, [reviewNeeded, confirmed, pending, recorder.status, onReadyChange]);
  const changeConsent = (value: boolean) => {
    setConsent(value);
    onConsentChange?.(value);
    if (!value) cancel();
  };
  const changeMode = (value: 'text' | 'voice') => {
    if (recorder.audioBlob && value === 'text' && !window.confirm('녹음 파일을 지울까요? 받아쓴 원문은 남습니다.')) return;
    cancel(); recorder.reset(); setMode(value); setError('');
  };
  const begin = async () => {
    if (recorder.audioBlob && !window.confirm('기존 녹음을 지우고 새로 녹음할까요?')) return;
    cancel(); setError('');
    await recorder.start();
  };
  const deleteRecording = () => {
    if (!window.confirm('녹음 파일을 삭제할까요? 받아쓴 원문은 남습니다.')) return;
    cancel(); recorder.reset();
  };
  const runTranscribe = async () => {
    if (!recorder.audioBlob || !aiReady || !sttReady || !consent) { setError('AI 연결과 정보 전송 동의를 확인해 주세요.'); return; }
    cancel();
    const current = version.current;
    const controller = new AbortController(); abort.current = controller;
    setPending(true); setError('');
    try {
      await verifyAudibleAudio(recorder.audioBlob);
      if (current !== version.current || controller.signal.aborted) return;
      const result = await transcribe(recorder.audioBlob, recorder.duration, petName, controller.signal);
      if (current !== version.current || controller.signal.aborted) return;
      onText(result.text, true); setReviewNeeded(true); setConfirmed(false);
    } catch (caught) {
      if (current === version.current && !controller.signal.aborted) setError(caught instanceof Error ? caught.message : '받아쓰기에 실패했습니다.');
    } finally { if (current === version.current) { setPending(false); abort.current = null; } }
  };
  return <div className="ws-source">
    <div className="ws-switch" role="group" aria-label="입력 방식"><button type="button" className={mode === 'text' ? 'selected' : ''} onClick={() => changeMode('text')}>텍스트</button><button type="button" className={mode === 'voice' ? 'selected' : ''} onClick={() => changeMode('voice')}>음성</button></div>
    {mode === 'voice' && <div className="ws-voice">
      <p>3~60초 녹음 후 재생해 확인하세요.</p>
      {recorder.status === 'recording' ? <button type="button" className="button secondary" onClick={recorder.stop}>녹음 중지 ({recorder.duration}초)</button> : <button type="button" className="button secondary" onClick={begin} disabled={recorder.status === 'requesting'}>{recorder.status === 'requesting' ? '마이크 요청 중' : '새로 녹음'}</button>}
      {(recorder.status === 'requesting' || recorder.status === 'recording' || pending) && <button type="button" className="button secondary" onClick={() => { cancel(); recorder.reset(); }}>취소</button>}
      {recorder.audioUrl && <><audio controls src={recorder.audioUrl} aria-label="녹음 재생" /><button type="button" className="button secondary" onClick={runTranscribe} disabled={pending || !aiReady || !sttReady || !consent}>{pending ? '받아쓰기 중' : '받아쓰기'}</button><button type="button" className="button secondary" onClick={deleteRecording}>녹음 삭제</button></>}
      {!aiReady && <p>음성 받아쓰기는 AI 연결이 필요합니다. 텍스트로 직접 입력할 수 있습니다.</p>}
      {aiReady && !sttReady && <p>음성 받아쓰기를 사용할 수 없습니다. 텍스트로 직접 입력할 수 있습니다.</p>}
      {recorder.error && <p role="alert">{recorder.error}</p>}
    </div>}
    <label className="ws-label">원문 또는 받아쓰기 <textarea ref={textAreaRef} value={text} rows={6} maxLength={8000} onChange={event => { cancel(); onText(event.target.value, reviewNeeded); setConfirmed(false); }} placeholder="관찰한 내용을 적어 주세요." /></label>
    {reviewNeeded && <label className="ws-check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />받아쓰기를 듣고 원문을 확인했습니다.</label>}
    {aiReady && <label className="ws-check"><input type="checkbox" checked={consent} onChange={event => changeConsent(event.target.checked)} />입력한 내용과 음성을 이 PC의 로컬 AI 서버에서 처리하는 데 동의합니다.</label>}
    {error && <p role="alert" className="ws-error">{error}</p>}
  </div>;
}
