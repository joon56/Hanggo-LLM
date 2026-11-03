import { useEffect, useRef, useState } from 'react';
import type { DevicePreference, MissingDevice } from '../call/devices';
import type { Speaker } from '../domain/coaching';
import { deviceAdvice } from './copy';

export type JoinChoice = { stream: MediaStream; missing: MissingDevice[]; consent: boolean; preference: DevicePreference };
type Props = {
  petName: string; role: Speaker; relayAvailable: boolean;
  openPreview: (preference: DevicePreference) => Promise<{ stream: MediaStream; missing: MissingDevice[] }>;
  onJoin: (choice: JoinChoice) => void;
};
const stop = (stream: MediaStream) => stream.getTracks().forEach(track => track.stop());

export function PreJoin({ petName, role, relayAvailable, openPreview, onJoin }: Props) {
  const [preview, setPreview] = useState<{ stream: MediaStream; missing: MissingDevice[] } | null>(null);
  const [preference, setPreference] = useState<DevicePreference>({});
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [consent, setConsent] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const handedOver = useRef(false);

  useEffect(() => {
    let stale = false; let opened: MediaStream | undefined;
    void openPreview(preference).then(result => {
      if (stale) { stop(result.stream); return; }
      opened = result.stream; setPreview(result);
      // Device names stay hidden until a permission has been granted, so list them after opening.
      void navigator.mediaDevices?.enumerateDevices?.().then(setDevices);
    });
    return () => { stale = true; if (opened && !handedOver.current) stop(opened); };
  }, [openPreview, preference]);
  useEffect(() => { if (video.current && preview) video.current.srcObject = preview.stream; }, [preview]);

  const cameras = devices.filter(device => device.kind === 'videoinput' && device.deviceId);
  const microphones = devices.filter(device => device.kind === 'audioinput' && device.deviceId);
  return <main className="coach-page"><section className="coach-card coach-narrow">
    <h1>{petName} 상담 입장</h1>
    <p className="coach-hint">{role === 'guardian' ? '보호자로 입장합니다.' : '훈련사로 입장합니다.'}</p>
    {!preview && <p role="status">카메라와 마이크를 확인하고 있습니다.</p>}
    {preview && <>
      <video ref={video} className="prejoin-preview" autoPlay muted playsInline aria-label="내 카메라 미리보기" />
      {preview.missing.map(item => <p className="coach-warning" key={item.device}>{deviceAdvice(item)}</p>)}
      {cameras.length > 1 && <label>카메라<select value={preference.cameraId ?? ''} onChange={event => setPreference({ ...preference, cameraId: event.target.value || undefined })}><option value="">기본 카메라</option>{cameras.map(device => <option key={device.deviceId} value={device.deviceId}>{device.label || '카메라'}</option>)}</select></label>}
      {microphones.length > 1 && <label>마이크<select value={preference.microphoneId ?? ''} onChange={event => setPreference({ ...preference, microphoneId: event.target.value || undefined })}><option value="">기본 마이크</option>{microphones.map(device => <option key={device.deviceId} value={device.deviceId}>{device.label || '마이크'}</option>)}</select></label>}
      {!relayAvailable && <p className="coach-warning">중계 서버가 설정되지 않아 다른 네트워크에서 연결이 실패할 수 있습니다.</p>}
      <label className="coach-check"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />AI 받아쓰기와 장면 저장에 동의합니다. 양쪽이 모두 동의해야 기록이 시작되며, 동의하지 않아도 통화할 수 있습니다.</label>
      <button className="button primary" onClick={() => { handedOver.current = true; onJoin({ ...preview, consent, preference }); }}>입장</button>
    </>}
  </section></main>;
}
