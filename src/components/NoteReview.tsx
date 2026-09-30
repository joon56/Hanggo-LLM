import { ArrowSquareOutIcon, CheckCircleIcon, DownloadSimpleIcon, FileTextIcon, ShieldWarningIcon, TrashIcon } from '@phosphor-icons/react';
import type { ApprovedNote, Category, Draft, NoteItem } from '../domain/notes';
import { getReviewSignals, validateDraft } from '../domain/notes';

export const categoryLabels: Record<Category, string> = {
  owner_report: '보호자 보고', observation: '훈련사 관찰', guidance: '안내한 내용', task: '합의한 과제', follow_up: '추가 확인',
};

type Props = {
  draft: Draft | null;
  saved: ApprovedNote | null;
  reviewed: boolean;
  canApprove: boolean;
  onReview: (value: boolean) => void;
  onChange: (id: string, patch: Partial<NoteItem>) => void;
  onRemove: (id: string) => void;
  onSource: (quote: string) => void;
  onApprove: () => void;
  onExport: () => void;
};

export default function NoteReview(props: Props) {
  const { draft, saved, reviewed, canApprove, onReview, onChange, onRemove, onSource, onApprove, onExport } = props;
  const errors = draft ? validateDraft(draft) : [];
  const signals = draft ? getReviewSignals(draft) : { safetyFlags: [], methodReview: false };
  const hasRisk = signals.safetyFlags.length > 0 || signals.methodReview;

  return <section className="review-panel" aria-labelledby="review-title">
    <div className="panel-heading">
      <div><span className="eyebrow">02 / REVIEW</span><h2 id="review-title">{saved ? '승인한 상담일지' : '상담일지 초안'}</h2></div>
      <span className={`status-tag ${saved ? 'green' : ''}`}>{saved ? '승인 완료' : draft ? '검토 대기' : '입력 대기'}</span>
    </div>
    {!draft ? <div className="review-empty">
      <div className="empty-document"><FileTextIcon size={38} weight="light" /><span /><span /><span /></div>
      <h3>상담의 맥락을,<br />다음 만남까지.</h3>
      <p>왼쪽에 상담 요약을 남겨 주세요.<br />원문을 바탕으로 다섯 항목을 정리합니다.</p>
      <div className="empty-categories">{Object.values(categoryLabels).map((label, index) => <div key={label}><span>0{index + 1}</span>{label}</div>)}</div>
      <small>입력 문장을 초안으로 정리합니다.<br />원문과 결과를 직접 확인해 주세요.</small>
    </div> : <>
      <div className="review-intro"><FileTextIcon size={17} /><span>훈련사의 사후 요약 · {draft.items.length}개 항목</span><span className="demo-word">{draft.mode === 'ollama' ? '로컬 AI 초안' : draft.mode === 'openai' ? '이전 AI 초안' : draft.mode === 'manual' ? '수동 검토 필요' : '규칙 기반 데모'}</span></div>
      {draft.generation && <p className="generation-meta">{draft.generation.model} · {draft.generation.latencyMs}ms · 요청 {draft.generation.requestId}{draft.generation.fallbackUsed ? ' · 대체 초안' : ''}</p>}
      {hasRisk && <div className="warning-box" role="status">
        <ShieldWarningIcon size={23} weight="bold" />
        <div><strong>{signals.safetyFlags.length ? '동물병원 확인이 먼저 필요한 신호가 있습니다.' : '훈련 방법을 먼저 검토해 주세요.'}</strong>
          <p>{signals.safetyFlags.join(' · ')}{signals.methodReview ? ' · 훈련 방법 검토' : ''}</p>
          <p>관련 기록을 보존하되, 과제로 전달하지 않습니다. 키워드로 표시한 참고 신호이며 전문가 확인이 필요합니다.</p>
        </div>
      </div>}
      <div className="note-sections">
        {(Object.entries(categoryLabels) as [Category, string][]).map(([category, label], groupIndex) => {
          const items = draft.items.filter(item => item.category === category);
          return <section className="note-section" key={category}>
            <div className="section-heading"><span className="section-number">0{groupIndex + 1}</span><h3>{label}</h3><span className="item-count">{items.length}</span></div>
            {!items.length && <p className="no-items">{category === 'task' && hasRisk ? '안전 확인 후 훈련사가 결정합니다.' : '원문에서 확인된 내용이 없습니다.'}</p>}
            {items.map(item => <article className="note-item" key={item.id}>
              {saved ? <p className="saved-item-text">{item.text}</p> : <textarea aria-label={`${label} 내용`} value={item.text} rows={Math.max(2, Math.ceil(item.text.length / 38))} maxLength={2000} onChange={event => onChange(item.id, { text: event.target.value, edited: true })} />}
              <div className="item-actions">
                <button className="source-link" onClick={() => onSource(item.sourceQuote)}><ArrowSquareOutIcon size={14} />원문 근거</button>
                {item.edited && <span className="edited-label">훈련사 수정</span>}
                {!saved && <div className="item-edit-actions"><select aria-label={`${label} 분류 변경`} value={item.category} onChange={event => onChange(item.id, { category: event.target.value as Category, edited: true })}>
                  {(Object.entries(categoryLabels) as [Category, string][]).map(([value, name]) => <option value={value} key={value} disabled={value === 'task' && hasRisk}>{name}</option>)}
                </select><button className="icon-button" aria-label={`${label} 항목 삭제`} onClick={() => onRemove(item.id)}><TrashIcon size={16} /></button></div>}
              </div>
            </article>)}
          </section>;
        })}
      </div>
      {errors.length > 0 && <div className="validation-errors" role="alert"><strong>저장 전에 확인해 주세요.</strong><ul>{[...new Set(errors)].map(error => <li key={error}>{error}</li>)}</ul></div>}
      <footer className="approval-area">
        {saved ? <><div className="approved-stamp"><CheckCircleIcon size={22} weight="fill" /><div><strong>{saved.metadata.trainerName} 훈련사 승인</strong><small>{new Date(saved.approvedAt).toLocaleString('ko-KR')}</small></div></div><button className="button secondary full" onClick={onExport}><DownloadSimpleIcon size={18} />JSON 다운로드</button><p>승인된 {saved.mode === 'ollama' ? '로컬 AI' : saved.mode === 'openai' ? '이전 AI' : saved.mode === 'manual' ? '수동 검토' : '데모'} 기록입니다. 보호자에게 전송되지 않았습니다.</p></> : <>
          <label className="review-checkbox"><input type="checkbox" checked={reviewed} onChange={event => onReview(event.target.checked)} /><span>원문과 일지를 확인했으며, 이 브라우저에 저장합니다.</span></label>
          <button className="button primary full" onClick={onApprove} disabled={!reviewed || !canApprove || errors.length > 0}><CheckCircleIcon size={20} />승인하고 저장</button>
          <p>반려동물·훈련사 정보를 입력해야 저장할 수 있습니다.<br />승인한 기록은 이 브라우저에 저장되며 직접 삭제할 수 있습니다.</p>
        </>}
      </footer>
    </>}
  </section>;
}
