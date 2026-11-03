import { useEffect, useRef, useState } from 'react';
import { CameraRotateIcon, MicrophoneIcon, MicrophoneSlashIcon, MonitorArrowUpIcon, PhoneDisconnectIcon, VideoCameraIcon, VideoCameraSlashIcon } from '@phosphor-icons/react';
import type { CallSnapshot } from '../call/call-session';
import type { Speaker } from '../domain/coaching';

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

type Props = {
  role: Speaker; petName: string; canShare: boolean; call: CallSnapshot; mirrorSelf?: boolean;
  onToggleMicrophone(): void; onToggleCamera(): void; onSwitchCamera(): void; onStartShare(): void; onStopShare(): void; onLeave(): void; onEnd(): void; onConsent(value: boolean): void;
};

function statusMessage(call: CallSnapshot) {
  if (!call.peerOnline) return '상대를 기다리고 있습니다.';
  if (call.status === 'connecting' || call.status === 'waiting') return '상대와 연결하고 있습니다.';
  if (call.status === 'reconnecting') return '연결이 끊겨 다시 연결하고 있습니다. 기록된 내용은 보존됩니다.';
  if (call.status === 'failed') return '연결하지 못했습니다. 네트워크를 확인한 뒤 다시 입장해 주세요.';
  return '';
}

export function CallStage({ role, petName, canShare, call, mirrorSelf, onToggleMicrophone, onToggleCamera, onSwitchCamera, onStartShare, onStopShare, onLeave, onEnd, onConsent }: Props) {
  const peerSharing = !!call.remoteScreen && call.peerMedia.screen;
  const message = statusMessage(call);
  const peerName = role === 'trainer' ? '보호자' : '훈련사';
  const ownConsent = call.consent[role];
  const cameraOff = !call.peerMedia.camera ? `${peerName} 카메라 꺼짐` : undefined;
  return <div className="call-room" data-call-status={call.status} data-peer-online={String(call.peerOnline)} data-inbound-video-frames={call.stats.inboundVideoFrames} data-inbound-audio-bytes={call.stats.inboundAudioBytes} data-inbound-audio-energy={call.stats.inboundAudioEnergy}
    data-relayed={String(call.stats.relayed)} data-peer-screen={String(peerSharing)} data-recording={String(call.recording)} data-peer-camera={String(call.peerMedia.camera)} data-peer-microphone={String(call.peerMedia.microphone)}>
    <header className="call-bar">
      <strong>{petName}</strong>
      <span className={`call-chip${call.recording ? ' is-recording' : ''}`}>{call.recording ? 'AI 기록 중' : `기록 꺼짐 · ${ownConsent ? `${peerName} 동의 대기` : '양쪽 동의 필요'}`}</span>
      <button className="call-link" onClick={() => onConsent(!ownConsent)}>{ownConsent ? '기록 동의 철회' : '기록 동의'}</button>
      {call.stats.relayed && <span className="call-chip">중계 연결</span>}
      {call.stats.roundTripMs !== null && <span className="call-chip">지연 {call.stats.roundTripMs}ms</span>}
    </header>
    {message && <p role="status" className="call-status">{message}</p>}
    {call.error && <p role="alert" className="call-status is-error">{call.error}</p>}
    <div className="call-stage">
      {peerSharing && <Tile stream={call.remoteScreen} label="상대 공유 화면" main />}
      <Tile stream={call.remoteStream} label="상대 카메라" main={!peerSharing} off={cameraOff} />
      <Tile stream={call.localStream} label="내 카메라" muted mirrored={mirrorSelf} off={!call.hasCamera ? '카메라 없음' : !call.cameraOn ? '카메라 꺼짐' : undefined} />
      {call.localScreen && <Tile stream={call.localScreen} label="내 공유 화면" muted />}
    </div>
    <footer className="call-controls">
      <button className="call-control" disabled={!call.hasMicrophone} aria-label={!call.hasMicrophone ? '마이크 없음' : call.microphoneOn ? '마이크 끄기' : '마이크 켜기'} data-off={!call.microphoneOn} onClick={onToggleMicrophone}>{call.microphoneOn ? <MicrophoneIcon size={22} /> : <MicrophoneSlashIcon size={22} />}</button>
      <button className="call-control" disabled={!call.hasCamera} aria-label={!call.hasCamera ? '카메라 없음' : call.cameraOn ? '카메라 끄기' : '카메라 켜기'} data-off={!call.cameraOn} onClick={onToggleCamera}>{call.cameraOn ? <VideoCameraIcon size={22} /> : <VideoCameraSlashIcon size={22} />}</button>
      {call.hasCamera && <button className="call-control" aria-label="카메라 전환" onClick={onSwitchCamera}><CameraRotateIcon size={22} /></button>}
      {canShare && <button className="call-control" aria-label={call.localScreen ? '공유 중지' : '화면 공유'} data-active={!!call.localScreen} onClick={call.localScreen ? onStopShare : onStartShare}><MonitorArrowUpIcon size={22} /></button>}
      {role === 'trainer' ? <button className="call-control is-end" aria-label="상담 종료" onClick={onEnd}><PhoneDisconnectIcon size={22} /></button>
        : <button className="call-control is-end" aria-label="나가기" onClick={onLeave}><PhoneDisconnectIcon size={22} /></button>}
    </footer>
  </div>;
}
