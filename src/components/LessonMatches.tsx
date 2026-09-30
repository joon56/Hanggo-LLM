import { useEffect, useState } from 'react';
import { request } from '../api';
import type { ApprovedNote } from '../domain/notes';
import type { Lesson, LessonSuggestion } from '../domain/lessons';
import type { SavedShelterProfile } from '../domain/workspace-types';

export default function LessonMatches({ note, profile, available }: { note?: ApprovedNote; profile?: SavedShelterProfile; available: boolean }) {
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [error, setError] = useState('');
  const [species, setSpecies] = useState<'dog' | 'cat'>(profile?.draft.animal.species ?? 'dog');
  const [age, setAge] = useState(profile?.draft.animal.ageMonths?.toString() ?? '');
  const [completed, setCompleted] = useState<string[]>([]);
  const [health, setHealth] = useState<string[]>([]);
  const [candidates, setCandidates] = useState<LessonSuggestion[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [checked, setChecked] = useState(false);
  const [queried, setQueried] = useState(false);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!available) return;
    const controller = new AbortController();
    request<{ lessons: Lesson[] }>('/api/lessons', { signal: controller.signal }).then(data => setLessons(data.lessons)).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [available]);
  useEffect(() => {
    setCandidates([]); setChosen([]); setChecked(false); setQueried(false); setPending(false);
    if ((!note && !profile) || !age || !Number.isInteger(Number(age)) || Number(age) < 0 || Number(age) > 600 || !lessons.length) return;
    const controller = new AbortController(); setPending(true); setError('');
    const input = profile ? { draft: profile.draft, completedLessonIds: completed, healthFlags: health } : { draft: note!.draft, species, ageMonths: Number(age), completedLessonIds: completed, healthFlags: health };
    request<{ suggestions: LessonSuggestion[] }>(profile ? '/api/lessons/shelter-match' : '/api/lessons/match', { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }).then(data => { if (!controller.signal.aborted) { setCandidates(data.suggestions); setQueried(true); } }).catch(error => { if (!controller.signal.aborted) setError(error.message); }).finally(() => { if (!controller.signal.aborted) setPending(false); });
    return () => controller.abort();
  }, [age, species, completed, health, lessons, note, profile]);
  const toggle = (values: string[], value: string) => values.includes(value) ? values.filter(v => v !== value) : [...values, value];
  const exportAssignment = () => {
    const selected = candidates.filter(item => chosen.includes(`${item.itemId}:${item.lessonId}`));
    if (!checked || !selected.length) return;
    const blob = new Blob([JSON.stringify({ ...(profile ? { profile } : { note }), lessonAssignments: selected, approvedBy: profile?.approvedBy ?? note!.metadata.trainerName, approvedAt: new Date().toISOString() }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = `hanggo-tasks-${profile?.id ?? note!.id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <section className="ws-card lesson-matches"><h2>{profile ? '관찰 근거와 레슨 연결' : '합의한 과제와 레슨 연결'}</h2>
    {!lessons.length ? <p>{available ? '연결된 레슨 카탈로그가 없습니다. 승인 기록은 원문으로 보관됩니다.' : '공개 체험판에는 실제 레슨 카탈로그가 연결되지 않았습니다.'}</p> : <>
      <p>승인한 {profile ? '관찰' : '과제'}의 원문과 일치하고, 입력한 조건에 맞는 레슨만 표시합니다.</p>
      {profile && !age && <p>월령이 없어 후보를 표시하지 않습니다. 동물 정보를 확인한 새 프로필을 승인해 주세요.</p>}
      <div className="ws-fields"><label>동물 종류<select disabled={!!profile} value={species} onChange={e => setSpecies(e.target.value as typeof species)}><option value="dog">개</option><option value="cat">고양이</option></select></label><label>월령<input disabled={!!profile} type="number" min="0" max="600" value={age} onChange={e => setAge(e.target.value)} /></label></div>
      <fieldset><legend>완료한 레슨</legend>{lessons.map(lesson => <label className="ws-check" key={lesson.id}><input type="checkbox" checked={completed.includes(lesson.id)} onChange={() => setCompleted(toggle(completed, lesson.id))} />{lesson.title}</label>)}</fieldset>
      {!!lessons.flatMap(l => l.contraindications).length && <fieldset><legend>현재 해당하는 건강·금기 조건</legend>{[...new Set(lessons.flatMap(l => l.contraindications))].map(flag => <label className="ws-check" key={flag}><input type="checkbox" checked={health.includes(flag)} onChange={() => setHealth(toggle(health, flag))} />{flag}</label>)}</fieldset>}
      {pending && <p role="status">조건 확인 중…</p>}
      {queried && !candidates.length && <p>조건에 맞는 레슨이 없습니다. 맞춤 과제는 원문 그대로 유지합니다.</p>}
      {candidates.map(item => { const id = `${item.itemId}:${item.lessonId}`; return <article key={id}><label className="ws-check"><input type="checkbox" checked={chosen.includes(id)} onChange={() => { setChosen(toggle(chosen, id)); setChecked(false); }} />{item.title}</label><p>{item.ownerDescription}</p><blockquote>{item.sourceQuote}</blockquote></article>; })}
      {!!chosen.length && <><label className="ws-check"><input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} />조건과 원문을 확인했으며 이 레슨 연결을 승인합니다.</label><button className="button secondary" disabled={!checked || pending} onClick={exportAssignment}>승인한 과제·레슨 파일 다운로드</button><p>다운로드한 파일을 직접 전달할 수 있습니다. 보호자에게 자동 전송되지 않습니다.</p></>}
    </>}{error && <p role="alert">{error}</p>}</section>;
}
