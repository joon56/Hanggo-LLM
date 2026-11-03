import { useEffect, useRef, useState } from 'react';
import { MicrophoneIcon, StopIcon } from '@phosphor-icons/react';
import { startDictation } from '../call/dictation';
import { transcribeVoice } from '../coaching-api';
import { apiMessage } from './copy';

/** Fills a text field by voice. The person still reads and sends the text themselves. */
export function VoiceNote({ caseId, label, onText, onError }: { caseId: string; label: string; onText(text: string): void; onError(message: string): void }) {
  const [state, setState] = useState<'idle' | 'starting' | 'recording' | 'finishing'>('idle');
  const session = useRef<{ stop(): void } | null>(null);
  useEffect(() => () => session.current?.stop(), []);
  if (!navigator.mediaDevices?.getUserMedia) return null;
  const start = () => {
    setState('starting');
    startDictation({ transcribe: bytes => transcribeVoice(caseId, bytes).then(result => result.text), onText,
      onError: cause => onError(apiMessage(cause, '받아쓰지 못했습니다. 글로 적어 주세요.')), onStopped: () => { session.current = null; setState('idle'); } })
      .then(started => { session.current = started; setState('recording'); },
        () => { setState('idle'); onError('마이크를 열지 못했습니다. 글로 적어 주세요.'); });
  };
  return <button type="button" className="button secondary voice-note" disabled={state === 'starting' || state === 'finishing'} aria-label={state === 'recording' ? `${label} 음성 입력 멈추기` : `${label} 음성으로 입력`}
    onClick={() => { if (state === 'recording') { setState('finishing'); session.current?.stop(); } else start(); }}>
    {state === 'recording' ? <StopIcon size={16} /> : <MicrophoneIcon size={16} />}{state === 'recording' ? '멈추기' : state === 'finishing' ? '받아쓰는 중' : '음성'}
  </button>;
}
