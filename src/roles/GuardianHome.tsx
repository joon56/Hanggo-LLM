import { useEffect, useState } from 'react';
import { PawPrintIcon } from '@phosphor-icons/react';
import { getCase, getMe } from '../coaching-api';
import type { CaseDetail } from '../coaching-api';
import { apiMessage } from './copy';
import { GuardianDelivery } from './GuardianDelivery';
import { GuardianLogForm } from './GuardianLogForm';
import './call.css';

const POLL_MS = 3000;

export function GuardianHome({ navigate }: { navigate: (path: string) => void }) {
  const [detail, setDetail] = useState<CaseDetail | null>(null); const [error, setError] = useState('');
  useEffect(() => {
    let stopped = false; let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const me = await getMe();
        if (me.role !== 'guardian') { navigate('/coaching'); return; }
        const next = await getCase(me.caseId);
        if (!stopped) { setDetail(next); setError(''); }
      } catch (cause) {
        if (!stopped) setError((cause as { code?: string }).code === 'AUTH' ? '입장 정보가 없습니다. 훈련사에게 새 링크를 요청해 주세요.' : apiMessage(cause, '상담 정보를 불러오지 못했습니다.'));
      }
      if (!stopped) timer = setTimeout(() => void read(), POLL_MS);
    };
    void read();
    return () => { stopped = true; clearTimeout(timer); };
  }, [navigate]);
  const live = detail?.consultations.find(consultation => consultation.state === 'live');
  // Consultations come newest first, so this is the latest note the trainer confirmed.
  const approved = detail?.consultations.find(consultation => consultation.state === 'approved');
  return <main className="coach-page"><section className="coach-card coach-narrow">
    <PawPrintIcon weight="fill" size={28} />
    <h1>{detail ? `${detail.petName} 상담` : '행고 화상 상담'}</h1>
    {error && <p role="alert" className="coach-error">{error}</p>}
    {detail && <p className="coach-hint">{detail.trainerName} 훈련사</p>}
    {live ? <button className="button primary" onClick={() => navigate(`/room/${live.id}`)}>상담 입장</button>
      : detail && <p role="status" className="coach-hint">훈련사가 상담을 시작하면 이 화면에서 입장할 수 있습니다.</p>}
  </section>
  {approved && <section className="coach-card coach-narrow"><GuardianDelivery key={approved.id} caseId={approved.caseId} consultationId={approved.id} /></section>}
  {detail && <section className="coach-card coach-narrow"><GuardianLogForm caseId={detail.id} /></section>}
  </main>;
}
