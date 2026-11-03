import { useEffect, useState } from 'react';
import { WarningIcon } from '@phosphor-icons/react';
import { frameUrl, getDelivery, type Delivery } from '../coaching-api';
import type { Claim } from '../domain/coaching-note';
import { apiMessage, clockLabel } from './copy';
import { GuardianTasks } from './GuardianTasks';
import './review.css';

function Claims({ title, claims }: { title: string; claims: Claim[] }) {
  if (!claims.length) return null;
  return <div><h3>{title}</h3><ul>{claims.map(item => <li key={item.id}>{item.text}</li>)}</ul></div>;
}

/** Only what the trainer confirmed. The server has already removed drafts, memos, and method concerns. */
export function GuardianDelivery({ caseId, consultationId }: { caseId: string; consultationId: string }) {
  const [delivery, setDelivery] = useState<Delivery | null>(null); const [error, setError] = useState('');
  useEffect(() => {
    let stopped = false;
    getDelivery(consultationId).then(value => { if (!stopped) setDelivery(value); }, cause => { if (!stopped) setError(apiMessage(cause, '상담일지를 불러오지 못했습니다.')); });
    return () => { stopped = true; };
  }, [consultationId]);
  if (error) return <p role="alert" className="coach-error">{error}</p>;
  if (!delivery) return <p role="status" className="coach-hint">상담일지를 불러오는 중입니다.</p>;
  const { note, scenes } = delivery;
  return <article className="delivery" aria-label="확정된 상담일지">
    <h2>훈련사가 확정한 상담일지</h2>
    {note.safetyFlags.length > 0 && <p role="alert" className="review-safety"><WarningIcon size={16} />{note.safetyFlags.join(', ')} 내용이 있었습니다. 과제보다 동물병원 상담을 먼저 확인해 주세요.</p>}
    <Claims title="핵심 요약" claims={note.summary} />
    <Claims title="고민" claims={note.concerns} />
    {note.behaviors.map(entry => <div key={entry.id}><h3>{entry.title}</h3><ul>{[...entry.context, ...entry.behavior, ...entry.response].map(item => <li key={item.id}>{item.text}</li>)}</ul></div>)}
    <Claims title="보호자가 말한 내용" claims={note.guardianReports} />
    <Claims title="훈련사 관찰" claims={note.trainerObservations} />
    <Claims title="훈련사 안내" claims={note.guidance} />
    <div>
      <h3>과제</h3>
      <GuardianTasks caseId={caseId} consultationId={consultationId} tasks={note.tasks} />
    </div>
    <Claims title="다음에 확인할 것" claims={note.followUps} />
    {note.aiObservations.length > 0 && <div>
      <h3>확인한 장면</h3>
      <ul>{note.aiObservations.map(item => <li key={item.id}>{item.text}</li>)}</ul>
      <div className="review-photos">{scenes.flatMap(scene => scene.frameIds.map(id => <img key={id} src={frameUrl(consultationId, id)} alt={`상담 ${clockLabel(scene.atMs)} 장면`} loading="lazy" />))}</div>
    </div>}
  </article>;
}
