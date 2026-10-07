import { useEffect, useState } from 'react';
import type { VisionAnalysis, VisionScene } from '../domain/consultation-vision';
import { visionFrameUrl } from '../consultation-api';

export function evidenceTime(ms: number) {
  const seconds = Math.floor(ms / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}
function SceneEditor({ sessionId, scene, index, disabled, onDirty, onSave, onSeek }: {
  sessionId: string; scene: VisionScene; index: number; disabled: boolean;
  onDirty: (dirty: boolean) => void; onSave: (observations: string[]) => Promise<boolean>; onSeek: (ms: number) => void;
}) {
  const persisted = scene.observations.join('\n'); const [text, setText] = useState(persisted);
  useEffect(() => { setText(persisted); }, [persisted]);
  const observations = text.split('\n').map(line => line.trim()).filter(Boolean);
  const invalid = observations.length > 12 || observations.some(line => line.length > 500);
  return <article className="consultation-scene">
    <div className="consultation-row"><h3>장면 {index + 1} · 표시 시각 {evidenceTime(scene.atMs)}</h3><span>{scene.state === 'complete' ? '분석 완료' : scene.state === 'failed' ? '분석 실패' : '분석 대기'}</span></div>
    {scene.state === 'pending' ? <p className="consultation-hint">프레임 준비·분석 중</p> : <div className="consultation-frames">{scene.frameTimesMs.map((ms, frameIndex) => <button type="button" className="consultation-frame" key={frameIndex} onClick={() => onSeek(ms)} aria-label={`장면 ${index + 1} 프레임 ${frameIndex + 1} 재생`}><img loading="lazy" src={visionFrameUrl(sessionId, scene.id, frameIndex)} alt={`장면 ${index + 1} 프레임 ${frameIndex + 1} · ${evidenceTime(ms)}`} /><span>{evidenceTime(ms)}</span></button>)}</div>}
    {scene.error && <p className="consultation-warning">{scene.error}</p>}
    {scene.state === 'complete' && <><label>장면 {index + 1} 관찰<textarea aria-label={`장면 ${index + 1} 관찰`} value={text} disabled={disabled} maxLength={6011} onChange={event => { setText(event.target.value); onDirty(event.target.value !== persisted); }} /></label>
      <p className="consultation-hint">한 줄에 관찰 하나 · 최대 12개, 각 500자. 잘못된 관찰은 지우세요. 모두 지우면 관찰 없음으로 저장됩니다.</p>
      {invalid && <p className="consultation-warning">관찰 개수 또는 글자 수를 줄여 주세요.</p>}
      <div className="consultation-actions"><button className="text-button" aria-label={`장면 ${index + 1} 저장`} disabled={disabled || text === persisted || invalid} onClick={async () => { if (await onSave(observations)) setText(observations.join('\n')); }}>관찰 수정 저장</button>{text !== persisted && <button className="text-button" aria-label={`장면 ${index + 1} 수정 취소`} disabled={disabled} onClick={() => { setText(persisted); onDirty(false); }}>수정 취소</button>}</div>
      <details><summary>최초 AI 관찰</summary>{scene.originalObservations.length ? <ul>{scene.originalObservations.map((line, i) => <li key={i}>{line}</li>)}</ul> : <p>관찰 없음</p>}</details>
    </>}
  </article>;
}
export default function ConsultationVision({ sessionId, vision, canStart, pending, dirty, reviewed, onStart, onCancel, onReview, onDirty, onSave, onSeek }: {
  sessionId: string; vision?: VisionAnalysis; canStart: boolean; pending: boolean; dirty: boolean; reviewed: boolean;
  onStart: () => void; onCancel: () => void; onReview: () => void; onDirty: (id: string, value: boolean) => void; onSave: (id: string, observations: string[]) => Promise<boolean>; onSeek: (ms: number) => void;
}) {
  const processing = vision?.state === 'processing';
  const completed = vision?.scenes.filter(scene => scene.state !== 'pending').length ?? 0;
  return <section className="consultation-panel" aria-label="장면 분석과 검토">
    <div className="consultation-row"><div><span className="eyebrow">VISION / REVIEW</span><h2>장면 분석과 검토</h2></div>{vision && <span>{vision.model}</span>}</div>
    <p className="consultation-hint">녹화가 끝난 뒤 30초 간격과 표시한 순간 주변 프레임을 분석합니다. 프레임 시각은 샘플링한 영상 위치이며 행동의 정확한 시작·종료 시각이 아닙니다. AI 관찰은 잘못될 수 있으므로 녹화와 대조해 수정하고 검토하세요.</p>
    <div className="consultation-actions">{processing ? <button className="button secondary" disabled={pending} onClick={onCancel}>장면 분석 취소</button> : <button className="button secondary" disabled={!canStart || pending || dirty} onClick={onStart}>{!vision ? '장면 분석 시작' : vision.state === 'complete' ? '장면 다시 분석' : '장면 분석 다시 시도'}</button>}</div>
    {vision && <><div role="status" className="consultation-row"><span>{processing ? '장면 분석 중' : vision.state === 'complete' ? '장면 분석 완료' : vision.state === 'cancelled' ? '장면 분석 취소됨' : '장면 분석 실패'} · {completed}/{vision.scenes.length} 장면</span><progress aria-label="장면 분석 진행" value={completed} max={vision.scenes.length} /></div>
      {vision.error && <p className="consultation-warning">{vision.error}</p>}
      {vision.state !== 'complete' && <p className="consultation-hint">녹화와 받아쓰기는 보존됩니다. 분석이 완료되어야 카메라 상담 일지를 만들 수 있습니다.</p>}
      {dirty && <p className="consultation-warning">저장하지 않은 원문·관찰 수정이 있습니다. 각 수정을 저장하거나 취소한 뒤 장면 검토·일지 생성을 진행하세요.</p>}
      {vision.scenes.map((scene, index) => <SceneEditor key={scene.id} sessionId={sessionId} scene={scene} index={index} disabled={pending || processing || vision.state !== 'complete'} onDirty={value => onDirty(scene.id, value)} onSave={observations => onSave(scene.id, observations)} onSeek={onSeek} />)}
      {vision.state === 'complete' && <div className="consultation-actions"><button className="button secondary" disabled={pending || dirty || reviewed} onClick={onReview}>장면 관찰 검토 완료</button>{reviewed ? <strong className="consultation-approved">장면 관찰 검토됨</strong> : <span className="consultation-hint">모든 프레임과 관찰을 확인한 뒤 검토 완료를 누르세요.</span>}</div>}
    </>}
  </section>;
}
