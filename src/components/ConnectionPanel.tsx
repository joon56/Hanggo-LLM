import { useState } from 'react';
import type { Session } from '../api';

type Props = {
  session: Session | null;
  loading: boolean;
  error: string;
  onRetry: () => void;
  onLogin: (password: string) => Promise<void>;
  onLogout: () => void;
  localDemo: boolean;
  onDemo: (value: boolean) => void;
};

export default function ConnectionPanel({ session, loading, error, onRetry, onLogin, onLogout, localDemo, onDemo }: Props) {
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const locked = !session || (session.requirePassword && !session.authenticated);
  return <section className={`connection-panel ${locked ? 'connection-locked' : ''}`} aria-label="서버 연결">
    <strong>{loading ? '서버 연결 확인 중' : error ? '서버 연결 오류' : session?.requirePassword && !session.authenticated ? '운영자 로그인' : localDemo ? '로컬 데모' : session?.aiEnabled && session.configured ? '로컬 AI 연결됨' : 'AI 비활성'}</strong>
    {error && <><p role="alert">{error}</p><button className="button secondary" onClick={onRetry}>다시 연결</button></>}
    {!session && error && import.meta.env.DEV && <button className="button secondary" onClick={() => onDemo(!localDemo)}>{localDemo ? '로컬 데모 닫기' : '로컬 데모 사용'}</button>}
    {session?.requirePassword && !session.authenticated && <form onSubmit={async event => { event.preventDefault(); setSubmitting(true); try { await onLogin(password); setPassword(''); } finally { setSubmitting(false); } }}>
      <label>운영자 비밀번호<input type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} /></label>
      <button className="button primary" disabled={!password || submitting}>{submitting ? '확인 중…' : '로그인'}</button>
    </form>}
    {session && (!session.requirePassword || session.authenticated) && <div className="connection-actions">
      <span>{session.aiEnabled && session.configured ? `텍스트 ${session.textModel} · 음성 ${session.sttReady === false ? '사용 불가' : session.sttModel}` : 'AI 기능이 꺼져 있습니다.'}</span>
      {session.statusMessage && <span>{session.statusMessage}</span>}
      {!error && session.aiEnabled && (!session.configured || session.sttReady === false) && <button className="text-button" onClick={onRetry} disabled={loading}>다시 연결</button>}
      {session.aiEnabled && session.configured && <button className="text-button" onClick={() => onDemo(!localDemo)}>{localDemo ? 'AI 사용' : '로컬 데모 사용'}</button>}
      {session.requirePassword && <button className="text-button" onClick={onLogout}>로그아웃</button>}
    </div>}
  </section>;
}
