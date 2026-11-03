import { useCallback, useEffect, useRef, useState } from 'react';
import { useCall } from '../call/useCall';
import { openDevices, type DevicePreference } from '../call/devices';
import { createMoment, endConsultation, getCase, getConsultation, getIce, getMe, setConsent, setMomentMemo } from '../coaching-api';
import type { IceConfig } from '../coaching-api';
import type { Speaker } from '../domain/coaching';
import { CallStage } from './CallStage';
import { apiMessage } from './copy';
import { PreJoin, type JoinChoice } from './PreJoin';
import './call.css';

const canShareScreen = () => typeof navigator.mediaDevices?.getDisplayMedia === 'function';
const isPhone = () => /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
type Room = { role: Speaker; caseId: string; petName: string; ice: IceConfig; home: string; consented: boolean };

function LiveCall({ consultationId, room, choice, forceRelay, navigate }: { consultationId: string; room: Room; choice: JoinChoice; forceRelay: boolean; navigate: (path: string) => void }) {
  const [notice, setNotice] = useState('');
  // Ending the call reaches here twice, from the request and from the socket closing. A second navigation would abort the first.
  const left = useRef(false);
  const sessionRef = useRef<{ finish(): Promise<void> } | null>(null);
  const goHome = useCallback(() => {
    if (left.current) return;
    left.current = true;
    setNotice('상담을 마치고 있습니다. 마지막 기록을 보내는 중입니다.');
    void (sessionRef.current?.finish() ?? Promise.resolve()).finally(() => navigate(room.home));
  }, [navigate, room.home]);
  const onClosedForGood = useCallback((code: number) => {
    if (code === 4001) setNotice('다른 탭이나 기기에서 입장해 이 화면의 연결을 닫았습니다.');
    else goHome();
  }, [goHome]);
  const { session, ...call } = useCall({ consultationId, role: room.role, iceServers: room.ice.iceServers, localStream: choice.stream, forceRelay, onClosedForGood });
  sessionRef.current = session;
  const [facing, setFacing] = useState<'user' | 'environment'>(choice.preference.facingMode ?? 'user');
  if (notice) return <main className="coach-page"><section className="coach-card coach-narrow"><p role="status">{notice}</p></section></main>;
  return <CallStage caseId={room.caseId} relayAvailable={room.ice.relayAvailable} onRetry={() => location.reload()} role={room.role} petName={room.petName} canShare={canShareScreen()} call={call} mirrorSelf={facing === 'user'}
    onToggleMicrophone={() => session.toggleMicrophone()} onToggleCamera={() => session.toggleCamera()}
    onSwitchCamera={() => { const next = facing === 'user' ? 'environment' : 'user'; void openDevices({ microphone: false, facingMode: next }).then(({ stream }) => {
      const [track] = stream.getVideoTracks();
      if (track) { setFacing(next); void session.replaceCamera(track); }
    }); }}
    onStartShare={() => void session.startScreenShare()} onStopShare={() => session.stopScreenShare()}
    onLeave={goHome}
    onEnd={() => { if (window.confirm('상담을 종료할까요? 양쪽 통화가 끝납니다.')) void endConsultation(consultationId).then(goHome); }}
    onConsent={value => void setConsent(consultationId, value)}
    onCatch={() => void createMoment(consultationId).catch(() => session.noteUploadLost())}
    onMemo={(momentId, text) => void setMomentMemo(consultationId, momentId, text).catch(() => session.noteUploadLost())} />;
}

export function CallRoom({ consultationId, navigate, forceRelay = new URLSearchParams(location.search).has('forceRelay') }: { consultationId: string; navigate: (path: string) => void; forceRelay?: boolean }) {
  const [room, setRoom] = useState<Room | null>(null); const [error, setError] = useState('');
  const [choice, setChoice] = useState<JoinChoice | null>(null);
  useEffect(() => {
    void (async () => {
      try {
        const me = await getMe();
        const consultation = await getConsultation(consultationId);
        const home = me.role === 'guardian' ? '/guardian' : '/coaching';
        if (consultation.state !== 'live') { navigate(home); return; }
        const [detail, ice] = await Promise.all([getCase(consultation.caseId), getIce(consultationId)]);
        setRoom({ role: me.role, caseId: consultation.caseId, petName: detail.petName, ice, home, consented: consultation.consent[me.role] });
      } catch (cause) { setError(apiMessage(cause, '상담 정보를 불러오지 못했습니다.')); }
    })();
  }, [consultationId, navigate]);
  // The guardian usually films the pet, so a phone starts on the rear camera.
  const openPreview = useCallback((preference: DevicePreference) => openDevices({ ...preference, facingMode: preference.facingMode ?? (room?.role === 'guardian' && isPhone() ? 'environment' : undefined) }), [room?.role]);
  if (error) return <main className="coach-page"><section className="coach-card coach-narrow"><p role="alert" className="coach-error">{error}</p></section></main>;
  if (!room) return <main className="coach-page"><p role="status">상담 정보를 불러오는 중입니다.</p></main>;
  if (!choice) return <PreJoin petName={room.petName} role={room.role} caseId={room.caseId} consented={room.consented} relayAvailable={room.ice.relayAvailable} openPreview={openPreview} onJoin={async next => {
    // Before connecting, so a withdrawal on this screen stops recording before this browser could start it.
    if (next.consent !== room.consented) await setConsent(consultationId, next.consent);
    setChoice(next);
  }} />;
  return <LiveCall consultationId={consultationId} room={room} choice={choice} forceRelay={forceRelay} navigate={navigate} />;
}
