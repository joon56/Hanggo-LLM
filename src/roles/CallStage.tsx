import { useEffect, useMemo, useRef, useState } from 'react';
import { BookmarkSimpleIcon, CameraRotateIcon, MicrophoneIcon, MicrophoneSlashIcon, MonitorArrowUpIcon, PhoneDisconnectIcon, VideoCameraIcon, VideoCameraSlashIcon } from '@phosphor-icons/react';
import type { CallSnapshot } from '../call/call-session';
import type { Caption, MomentNotice, Speaker, SpeechStatus } from '../domain/coaching';
import { consultationCoverage } from '../domain/coverage';
import { CaseBrief } from './CaseBrief';
import { SPEAKER_NAME } from './copy';

const CAPTION_LINES = 3;
const MOMENT_NOTICE_MS = 4000;
const SPEECH_NOTE: Record<SpeechStatus, string> = { off: '받아쓰기 꺼짐', idle: '', preparing: '받아쓰기 준비 중', ready: '', failed: '받아쓰기 불가 · 통화는 계속됩니다' };

type TileProps = { stream: MediaStream | null; label: string; muted?: boolean; mirrored?: boolean; main?: boolean; off?: string };
function Tile({ stream, label, muted, mirrored, main, off }: TileProps) {
  const video = useRef<HTMLVideoElement>(null);
  const [soundBlocked, setSoundBlocked] = useState(false);
  useEffect(() => {
    const element = video.current;
    if (!element || !stream) return;
    element.srcObject = stream;
    // Browsers can refuse sound until the person interacts. Keep the picture and offer a button instead of failing.
    if (!muted && stream.getTracks().length) void element.play().catch(() => setSoundBlocked(true));
  }, [stream, muted]);
  return <figure className={`call-tile${main ? ' is-main' : ''}`} {...(main ? { 'data-main': '' } : {})}>
    <video ref={video} className={mirrored ? 'is-mirrored' : undefined} autoPlay playsInline muted={muted} aria-label={label} />
    {off && <div className="call-tile-off">{off}</div>}
    {soundBlocked && <button className="button secondary call-sound" onClick={() => { void video.current?.play().then(() => setSoundBlocked(false)); }}>소리 켜기</button>}
    <figcaption>{label}</figcaption>
  </figure>;
}

function Captions({ captions }: { captions: Caption[] }) {
  const recent = captions.filter(item => !item.echoSuspect).slice(-CAPTION_LINES);
  if (!recent.length) return null;
  return <div className="call-captions" role="log" aria-label="자막">
    {recent.map(item => <p key={item.id} data-speaker={item.speaker} className={item.state === 'failed' ? 'is-failed' : undefined}>
      <strong>{SPEAKER_NAME[item.speaker]}</strong> {item.state === 'failed' ? '받아쓰지 못한 구간입니다.' : item.text}
    </p>)}
  </div>;
}

function Checklist({ captions }: { captions: Caption[] }) {
  const { items, safety } = useMemo(() => consultationCoverage(captions), [captions]);
  return <div className="call-checklist">
    <ul aria-label="상담에서 확인할 것">{items.map(item => <li key={item.key} data-covered={item.covered} aria-label={`${item.label} ${item.covered ? '들음' : '아직'}`}>{item.label}</li>)}</ul>
    {safety.length > 0 && <p role="alert">안전 신호: {safety.join(', ')}. 동물병원 상담을 먼저 안내해 주세요.</p>}
  </div>;
}

function MomentBar({ moment, role, onMemo }: { moment: MomentNotice; role: Speaker; onMemo(momentId: string, text: string): void }) {
  const [memo, setMemo] = useState(''); const [closed, setClosed] = useState(false);
  useEffect(() => {
    // The trainer may still be typing, so only the guardian's notice clears by itself.
    if (role === 'trainer') return;
    const timer = setTimeout(() => setClosed(true), MOMENT_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [role]);
  if (closed) return null;
  const notice = moment.createdBy === role ? '캐치했습니다. 앞뒤 장면을 저장합니다.' : `${SPEAKER_NAME[moment.createdBy]}가 이 장면을 표시했습니다.`;
  return <div className="call-moment">
    <p role="status">{notice}</p>
    {role === 'trainer' && <form onSubmit={event => { event.preventDefault(); onMemo(moment.id, memo); setClosed(true); }}>
      <input aria-label="장면 메모" maxLength={500} placeholder="장면 메모" value={memo} onChange={event => setMemo(event.target.value)} />
      <button className="call-link" type="submit">메모 저장</button>
      <button className="call-link" type="button" onClick={() => setClosed(true)}>닫기</button>
    </form>}
  </div>;
}

type Props = {
  /** Lets the trainer read the brief without leaving the call. */
  caseId?: string;
  relayAvailable?: boolean;
  onRetry?(): void;
  role: Speaker; petName: string; canShare: boolean; call: CallSnapshot; mirrorSelf?: boolean;
  onToggleMicrophone(): void; onToggleCamera(): void; onSwitchCamera(): void; onStartShare(): void; onStopShare(): void; onLeave(): void; onEnd(): void; onConsent(value: boolean): void; onCatch(): void; onMemo(momentId: string, text: string): void;
};

function statusMessage(call: CallSnapshot, relayAvailable?: boolean) {
  if (!call.peerOnline) return '상대를 기다리고 있습니다.';
  if (call.status === 'connecting' || call.status === 'waiting') return '상대와 연결하고 있습니다.';
  if (call.status === 'reconnecting') return '연결이 끊겨 다시 연결하고 있습니다. 기록된 내용은 보존됩니다.';
  if (call.status === 'failed') return relayAvailable === false ? '연결하지 못했습니다. 중계 서버가 설정되지 않아 서로 다른 네트워크끼리는 연결되지 않을 수 있습니다.' : '연결하지 못했습니다. 네트워크를 확인한 뒤 다시 연결해 주세요.';
  return '';
}

export function CallStage({ caseId, relayAvailable, onRetry, role, petName, canShare, call, mirrorSelf, onToggleMicrophone, onToggleCamera, onSwitchCamera, onStartShare, onStopShare, onLeave, onEnd, onConsent, onCatch, onMemo }: Props) {
  const peerSharing = !!call.remoteScreen && call.peerMedia.screen;
  const message = statusMessage(call, relayAvailable);
  const peerName = role === 'trainer' ? '보호자' : '훈련사';
  const ownConsent = call.consent[role];
  const cameraOff = !call.peerMedia.camera ? `${peerName} 카메라 꺼짐` : undefined;
  const speechNote = call.recording ? SPEECH_NOTE[call.speech] : '';
  const [briefOpen, setBriefOpen] = useState(false);
  return <div className="call-room" data-call-status={call.status} data-peer-online={String(call.peerOnline)} data-inbound-video-frames={call.stats.inboundVideoFrames} data-inbound-audio-bytes={call.stats.inboundAudioBytes} data-inbound-audio-energy={call.stats.inboundAudioEnergy}
    data-relayed={String(call.stats.relayed)} data-peer-screen={String(peerSharing)} data-recording={String(call.recording)} data-peer-camera={String(call.peerMedia.camera)} data-peer-microphone={String(call.peerMedia.microphone)}
    data-caption-count={call.captions.length} data-caption-latency-ms={call.captionLatencyMs ?? ''} data-speech-status={call.speech}>
    <header className="call-bar">
      <strong>{petName}</strong>
      <span className={`call-chip${call.recording ? ' is-recording' : ''}`}>{call.recording ? 'AI 기록 중' : `기록 꺼짐 · ${ownConsent ? `${peerName} 동의 대기` : '양쪽 동의 필요'}`}</span>
      <button className="call-link" onClick={() => onConsent(!ownConsent)}>{ownConsent ? '기록 동의 철회' : '기록 동의'}</button>
      {role === 'trainer' && caseId && <button className="call-link" aria-expanded={briefOpen} onClick={() => setBriefOpen(value => !value)}>브리핑</button>}
      {speechNote && <span className="call-chip">{speechNote}</span>}
      {call.recordingLeftMinutes !== null && <span className="call-chip">{call.recordingLeftMinutes ? `기록 ${call.recordingLeftMinutes}분 남음` : '기록 60분 도달 · 통화는 계속됩니다'}</span>}
      {call.uploadLost && <span className="call-chip is-recording">일부 기록을 보내지 못했습니다</span>}
      {call.stats.relayed && <span className="call-chip">중계 연결</span>}
      {call.stats.roundTripMs !== null && <span className="call-chip">지연 {call.stats.roundTripMs}ms</span>}
    </header>
    {message && <p role="status" className="call-status">{message}{call.status === 'failed' && onRetry && <button className="call-link" onClick={onRetry}>다시 연결</button>}</p>}
    {call.error && <p role="alert" className="call-status is-error">{call.error}</p>}
    {role === 'trainer' && call.recording && <Checklist captions={call.captions} />}
    {call.lastMoment && <MomentBar key={call.lastMoment.id} moment={call.lastMoment} role={role} onMemo={onMemo} />}
    {briefOpen && caseId && <aside className="call-brief"><CaseBrief caseId={caseId} /></aside>}
    <div className="call-stage">
      {peerSharing && <Tile stream={call.remoteScreen} label="상대 공유 화면" main />}
      <Tile stream={call.remoteStream} label="상대 카메라" main={!peerSharing} off={cameraOff} />
      <Tile stream={call.localStream} label="내 카메라" muted mirrored={mirrorSelf} off={!call.hasCamera ? '카메라 없음' : !call.cameraOn ? '카메라 꺼짐' : undefined} />
      {call.localScreen && <Tile stream={call.localScreen} label="내 공유 화면" muted />}
    </div>
    <Captions captions={call.captions} />
    <footer className="call-controls">
      <button className="call-control" disabled={!call.hasMicrophone} aria-label={!call.hasMicrophone ? '마이크 없음' : call.microphoneOn ? '마이크 끄기' : '마이크 켜기'} data-off={!call.microphoneOn} onClick={onToggleMicrophone}>{call.microphoneOn ? <MicrophoneIcon size={22} /> : <MicrophoneSlashIcon size={22} />}</button>
      <button className="call-control" disabled={!call.hasCamera} aria-label={!call.hasCamera ? '카메라 없음' : call.cameraOn ? '카메라 끄기' : '카메라 켜기'} data-off={!call.cameraOn} onClick={onToggleCamera}>{call.cameraOn ? <VideoCameraIcon size={22} /> : <VideoCameraSlashIcon size={22} />}</button>
      {call.hasCamera && <button className="call-control" aria-label="카메라 전환" onClick={onSwitchCamera}><CameraRotateIcon size={22} /></button>}
      {canShare && <button className="call-control" aria-label={call.localScreen ? '공유 중지' : '화면 공유'} data-active={!!call.localScreen} onClick={call.localScreen ? onStopShare : onStartShare}><MonitorArrowUpIcon size={22} /></button>}
      <button className="call-control is-catch" disabled={!call.recording} onClick={onCatch}><BookmarkSimpleIcon size={22} />캐치</button>
      {role === 'trainer' ? <button className="call-control is-end" aria-label="상담 종료" onClick={onEnd}><PhoneDisconnectIcon size={22} /></button>
        : <button className="call-control is-end" aria-label="나가기" onClick={onLeave}><PhoneDisconnectIcon size={22} /></button>}
    </footer>
  </div>;
}
