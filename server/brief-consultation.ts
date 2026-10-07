import { prioritizeBriefConsultationItems, BRIEF_QUOTE_LIMIT } from '../src/domain/brief.ts';
import { validateConsultationNote } from '../src/domain/consultation.ts';
import type { ConsultationSession } from '../src/domain/consultation.ts';
import type { BriefConsultationChoice, BriefConsultationContext } from '../src/domain/workspace-types.ts';
import { ConsultationError, consultationNoteRevision } from './consultation-store.ts';
import type { ConsultationStore } from './consultation-store.ts';

function approved(session: ConsultationSession): boolean {
  return session.state === 'ready' && !!session.note?.approvedAt && Number.isFinite(Date.parse(session.note.approvedAt)) && validateConsultationNote(session.note, session).length === 0;
}
export function briefConsultationChoice(session: ConsultationSession): BriefConsultationChoice | undefined {
  if (!approved(session)) return undefined;
  return { id: session.id, date: session.metadata.sessionDate, petName: session.metadata.petName, trainerName: session.metadata.trainerName, approvedAt: session.note!.approvedAt!, revision: consultationNoteRevision(session)! };
}
export async function resolveBriefConsultation(store: ConsultationStore, reference: { id: string; revision: string }, petName: string): Promise<BriefConsultationContext> {
  let session: ConsultationSession;
  try { session = await store.get(reference.id); }
  catch { throw new ConsultationError('BRIEF_CONSULTATION_INVALID', '선택한 상담일지를 읽을 수 없습니다. 확정 상담일지를 다시 선택해 주세요.', 409); }
  const choice = briefConsultationChoice(session);
  if (!choice || choice.petName.trim() !== petName.trim() || choice.revision !== reference.revision) throw new ConsultationError('BRIEF_CONSULTATION_INVALID', '선택한 상담일지가 변경되었거나 확정 상태·반려동물 이름이 다릅니다. 다시 선택해 주세요.', 409);
  const items = prioritizeBriefConsultationItems(session.note!.items.map(item => ({ ...item, category: item.section }))).map(item => ({ id: item.id, text: item.text.slice(0, BRIEF_QUOTE_LIMIT), category: item.section, evidence: item.evidence.slice(0, 2).map(source => ({ kind: source.kind, quote: source.quote.slice(0, BRIEF_QUOTE_LIMIT), startMs: source.startMs, endMs: source.endMs })), truncated: item.text.length > BRIEF_QUOTE_LIMIT || item.evidence.length > 2 || item.evidence.some(source => source.quote.length > BRIEF_QUOTE_LIMIT) }));
  return { ...choice, items, omittedItems: session.note!.items.length - items.length };
}
