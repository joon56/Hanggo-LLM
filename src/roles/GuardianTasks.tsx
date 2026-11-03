import { useCallback, useEffect, useState } from 'react';
import { addTaskLog, listTaskLogs } from '../coaching-api';
import type { TaskLog, TaskLogStatus } from '../domain/coaching';
import type { CoachingTask } from '../domain/coaching-note';
import { apiMessage } from './copy';
import { VoiceNote } from './VoiceNote';

const STATUSES: [TaskLogStatus, string][] = [['done', '했어요'], ['partial', '일부만 했어요'], ['skipped', '못 했어요']];
const STATUS_NAME: Record<TaskLogStatus, string> = { done: '완료', partial: '일부', skipped: '못 함' };
const dateLabel = (iso: string) => new Date(iso).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });

function TaskCard({ caseId, consultationId, task, logs, onSaved }: { caseId: string; consultationId: string; task: CoachingTask; logs: TaskLog[]; onSaved(): void }) {
  const [memo, setMemo] = useState(''); const [pending, setPending] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const save = (status: TaskLogStatus) => {
    setPending(true); setError(''); setNotice('');
    addTaskLog(caseId, { consultationId, taskId: task.id, status, ...(memo.trim() ? { text: memo.trim() } : {}) })
      .then(() => { setMemo(''); setNotice('기록했습니다.'); onSaved(); }, cause => setError(apiMessage(cause, '기록하지 못했습니다.')))
      .finally(() => setPending(false));
  };
  return <div className="delivery-task" data-task={task.id}>
    <p>{task.text}</p>
    <dl><dt>담당</dt><dd>{task.who ?? '미확인'}</dd><dt>횟수</dt><dd>{task.frequency ?? '미확인'}</dd><dt>기한</dt><dd>{task.until ?? '미확인'}</dd><dt>성공 기준</dt><dd>{task.successCriteria ?? '미확인'}</dd></dl>
    <label className="delivery-memo">해 보니 어땠나요? (선택)<textarea aria-label={`${task.text} 메모`} rows={2} maxLength={2000} value={memo} onChange={event => setMemo(event.target.value)} /></label>
    <div className="coach-actions">
      {STATUSES.map(([status, label]) => <button key={status} type="button" className="button secondary" disabled={pending} onClick={() => save(status)}>{label}</button>)}
      <VoiceNote caseId={caseId} label="메모" onText={text => setMemo(current => `${current}${current ? ' ' : ''}${text}`)} onError={setError} />
    </div>
    {notice && <p role="status" className="coach-hint">{notice}</p>}
    {error && <p role="alert" className="coach-error">{error}</p>}
    {logs.length > 0 && <ul aria-label={`${task.text} 수행 기록`} className="delivery-logs">{logs.map(log => <li key={log.id}>{dateLabel(log.at)} · {STATUS_NAME[log.status]}{log.text ? ` · ${log.text}` : ''}</li>)}</ul>}
  </div>;
}

export function GuardianTasks({ caseId, consultationId, tasks }: { caseId: string; consultationId: string; tasks: CoachingTask[] }) {
  const [logs, setLogs] = useState<TaskLog[]>([]);
  const load = useCallback(() => { void listTaskLogs(caseId).then(result => setLogs(result.logs), () => {}); }, [caseId]);
  useEffect(load, [load]);
  if (!tasks.length) return <p className="coach-hint">정한 과제가 없습니다.</p>;
  return <div className="delivery">{tasks.map(task => <TaskCard key={task.id} caseId={caseId} consultationId={consultationId} task={task} logs={logs.filter(log => log.taskId === task.id)} onSaved={load} />)}</div>;
}
