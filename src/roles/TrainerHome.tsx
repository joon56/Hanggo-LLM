import { useCallback, useEffect, useState } from 'react';
import { CopyIcon, PawPrintIcon } from '@phosphor-icons/react';
import { login } from '../api';
import { createCase, getCase, getMe, listCases, reissueInvite, startConsultation } from '../coaching-api';
import type { CaseDetail } from '../coaching-api';
import { CaseBrief } from './CaseBrief';
import { apiMessage, STATE_LABEL } from './copy';
import './call.css';
import './review.css';

const POLL_MS = 3000;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const inviteLink = (token: string) => `${location.origin}/join/${token}`;

function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState(''); const [error, setError] = useState(''); const [pending, setPending] = useState(false);
  return <form className="coach-card coach-narrow" onSubmit={event => { event.preventDefault(); setPending(true); setError('');
    login(password).then(onDone, cause => setError(apiMessage(cause, '로그인하지 못했습니다.'))).finally(() => setPending(false)); }}>
    <h1>훈련사 로그인</h1>
    <label>접근 비밀번호<input type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} /></label>
    {error && <p role="alert" className="coach-error">{error}</p>}
    <button className="button primary" disabled={!password || pending}>로그인</button>
  </form>;
}

function Invite({ token, hostname, reissued }: { token: string; hostname: string; reissued: boolean }) {
  const [copied, setCopied] = useState(false);
  const link = inviteLink(token);
  return <div className="coach-invite">
    <label>보호자 초대 링크<input aria-label="보호자 초대 링크" readOnly value={link} onFocus={event => event.target.select()} /></label>
    <button type="button" className="button secondary" onClick={() => void navigator.clipboard.writeText(link).then(() => setCopied(true))}><CopyIcon size={16} />{copied ? '복사했습니다' : '링크 복사'}</button>
    <p className="coach-hint">{reissued ? '이전 링크와 이전 기기의 입장 정보는 더 이상 쓸 수 없습니다. ' : ''}이 링크는 한 번만 쓸 수 있고 7일 뒤 만료됩니다.</p>
    {LOOPBACK.has(hostname) && <p className="coach-warning">이 주소는 이 PC에서만 열립니다. 다른 기기로 시연하려면 <code>npm.cmd run demo:tunnel</code>로 실행해 주세요.</p>}
  </div>;
}

export function TrainerHome({ navigate, hostname = location.hostname }: { navigate: (path: string) => void; hostname?: string }) {
  const [state, setState] = useState<'loading' | 'login' | 'ready'>('loading');
  const [cases, setCases] = useState<CaseDetail[]>([]);
  const [form, setForm] = useState({ petName: '', guardianName: '', trainerName: '' });
  const [invite, setInvite] = useState<{ caseId: string; token: string; reissued: boolean } | null>(null);
  const [error, setError] = useState(''); const [pending, setPending] = useState(false);
  const [briefCase, setBriefCase] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const me = await getMe();
      if (me.role === 'guardian') { navigate('/guardian'); return; }
      const { cases: list } = await listCases();
      setCases(await Promise.all(list.map(item => getCase(item.id))));
      setState('ready');
    } catch (cause) {
      if ((cause as { code?: string }).code === 'AUTH') setState('login');
      else { setError(apiMessage(cause, '목록을 불러오지 못했습니다.')); setState('ready'); }
    }
  }, [navigate]);
  useEffect(() => { void load(); }, [load]);
  const organizing = cases.some(item => item.consultations.some(consultation => consultation.state === 'processing'));
  useEffect(() => {
    if (!organizing) return;
    const timer = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [load, organizing]);

  const act = async (work: () => Promise<void>) => {
    setPending(true); setError('');
    try { await work(); } catch (cause) { setError(apiMessage(cause, '요청을 처리하지 못했습니다.')); }
    finally { setPending(false); }
  };

  if (state === 'loading') return <main className="coach-page"><p role="status">불러오는 중입니다.</p></main>;
  if (state === 'login') return <main className="coach-page"><Login onDone={() => void load()} /></main>;
  return <main className="coach-page">
    <header className="coach-header"><PawPrintIcon weight="fill" size={22} /><strong>행고 화상 코칭</strong><a className="text-button" href="/">이전 도구</a></header>
    {error && <p role="alert" className="coach-error">{error}</p>}
    <section className="coach-card">
      <h1>새 상담 사례</h1>
      <p className="coach-hint">시연에는 가상 이름을 써 주세요. 화면 공유에 보일 수 있습니다.</p>
      <form className="coach-form" onSubmit={event => { event.preventDefault(); void act(async () => {
        const created = await createCase(form);
        setInvite({ caseId: created.case.id, token: created.inviteToken, reissued: false });
        setForm({ petName: '', guardianName: '', trainerName: '' });
        await load();
      }); }}>
        <label>반려동물 이름<input value={form.petName} maxLength={200} onChange={event => setForm({ ...form, petName: event.target.value })} /></label>
        <label>보호자 이름<input value={form.guardianName} maxLength={200} onChange={event => setForm({ ...form, guardianName: event.target.value })} /></label>
        <label>훈련사 이름<input value={form.trainerName} maxLength={200} onChange={event => setForm({ ...form, trainerName: event.target.value })} /></label>
        <button className="button primary" disabled={pending || !form.petName.trim() || !form.guardianName.trim() || !form.trainerName.trim()}>상담 사례 만들기</button>
      </form>
    </section>
    <section className="coach-list" aria-label="상담 사례">
      {!cases.length && <p className="coach-hint">아직 상담 사례가 없습니다.</p>}
      {cases.map(item => {
        const live = item.consultations.find(consultation => consultation.state === 'live');
        return <article className="coach-card" key={item.id}>
          <div className="coach-row"><div><h2>{item.petName}</h2><p className="coach-hint">{item.guardianName} · {item.trainerName} · 상담 {item.consultations.length}회</p></div>
            <div className="coach-actions">
              <button className="button secondary" aria-expanded={briefCase === item.id} aria-label={`${item.petName} 브리핑`} onClick={() => setBriefCase(current => current === item.id ? null : item.id)}>브리핑</button>
              <button className="button secondary" disabled={pending} onClick={() => void act(async () => { setInvite({ caseId: item.id, token: (await reissueInvite(item.id)).inviteToken, reissued: true }); })}>초대 링크 다시 만들기</button>
              {live ? <button className="button primary" aria-label={`${item.petName} 상담 다시 입장`} onClick={() => navigate(`/room/${live.id}`)}>다시 입장</button>
                : <button className="button primary" aria-label={`${item.petName} 상담 시작`} disabled={pending} onClick={() => void act(async () => navigate(`/room/${(await startConsultation(item.id)).id}`))}>상담 시작</button>}
            </div></div>
          {briefCase === item.id && <CaseBrief caseId={item.id} />}
          {invite?.caseId === item.id && <Invite token={invite.token} hostname={hostname} reissued={invite.reissued} />}
          {item.consultations.some(consultation => consultation.state !== 'live') && <ul className="coach-history" aria-label={`${item.petName} 지난 상담`}>
            {item.consultations.filter(consultation => consultation.state !== 'live').map(consultation => <li key={consultation.id}>
              <span>{new Date(consultation.createdAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })}</span>
              <span className="review-state" data-state={consultation.state}>{STATE_LABEL[consultation.state]}</span>
              <button className="call-link coach-link" onClick={() => navigate(`/review/${consultation.id}`)}>{consultation.state === 'review' ? '검토하기' : '열기'}</button>
            </li>)}
          </ul>}
        </article>;
      })}
    </section>
  </main>;
}
