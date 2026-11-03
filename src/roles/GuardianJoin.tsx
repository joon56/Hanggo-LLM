import { useState } from 'react';
import { PawPrintIcon } from '@phosphor-icons/react';
import { joinWithInvite } from '../coaching-api';
import { apiMessage, isInAppBrowser } from './copy';
import './call.css';

export function GuardianJoin({ token, navigate, userAgent = navigator.userAgent }: { token: string; navigate: (path: string) => void; userAgent?: string }) {
  const [error, setError] = useState(''); const [pending, setPending] = useState(false);
  const inApp = isInAppBrowser(userAgent);
  return <main className="coach-page"><section className="coach-card coach-narrow">
    <PawPrintIcon weight="fill" size={28} />
    <h1>행고 화상 상담</h1>
    {inApp ? <div role="alert" className="coach-warning"><p>이 앱 안의 브라우저에서는 카메라를 쓰지 못할 수 있습니다. 메뉴의 "다른 브라우저로 열기"로 Chrome이나 Safari에서 열어 주세요.</p></div>
      : <>
        <p className="coach-hint">훈련사가 보낸 초대 링크입니다. 이 기기로 상담에 들어갑니다. 링크는 한 번만 쓸 수 있습니다.</p>
        {error && <p role="alert" className="coach-error">{error}</p>}
        <button className="button primary" disabled={pending} onClick={() => { setPending(true); setError('');
          joinWithInvite(token).then(() => navigate('/guardian'), cause => setError(apiMessage(cause, '입장 준비를 하지 못했습니다.'))).finally(() => setPending(false)); }}>상담 입장 준비</button>
      </>}
  </section></main>;
}
