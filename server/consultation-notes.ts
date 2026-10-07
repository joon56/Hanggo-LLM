import { randomUUID } from 'node:crypto';
import { consultationSections, validateConsultationNote } from '../src/domain/consultation.ts';
import type { ConsultationSession, ConsultationNote, ConsultationSection } from '../src/domain/consultation.ts';
import { ConsultationError } from './consultation-store.ts';
import { splitNoteSentences, validateDraft } from '../src/domain/notes.ts';
import type { SourceKind, Draft } from '../src/domain/notes.ts';

export async function generateConsultationNote(session: ConsultationSession, generate: (text: string, sourceKind: SourceKind, signal?: AbortSignal) => Promise<unknown>, signal?: AbortSignal): Promise<ConsultationNote> {
  if (session.captureSource === 'camera' && session.vision?.state !== 'complete') throw new ConsultationError('VISION_REQUIRED', 'Complete camera analysis before generating notes.', 409);
  const note: ConsultationNote = { items: [], missingSections: [], coveredSegmentIds: [], createdAt: new Date().toISOString(), fallbackUsed: false, warnings: [] };
  const sources: { quote: string; segment: ConsultationSession['segments'][number] }[] = [];
  for (const segment of session.segments) {
    if (segment.state !== 'complete' || !segment.text.trim()) continue;
    for (const sentence of splitNoteSentences(segment.text)) for (let offset = 0; offset < sentence.length; offset += 2000) { const quote = sentence.slice(offset, offset + 2000).trim(); if (quote) sources.push({ quote, segment }); }
    note.coveredSegmentIds.push(segment.id);
  }
  const batches: typeof sources[] = []; let batch: typeof sources = []; let characters = 0;
  for (const source of sources) {
    if (batch.length && (batch.length >= 24 || characters + 1 + source.quote.length > 2000)) { batches.push(batch); batch = []; characters = 0; }
    characters += source.quote.length + (batch.length ? 1 : 0); batch.push(source);
  }
  if (batch.length) batches.push(batch);
  for (const group of batches) {
    signal?.throwIfAborted(); const text = group.map(source => source.quote).join('\n');
    const result = await generate(text, 'trainer_summary_voice', signal) as { draft?: Draft; fallbackUsed?: boolean };
    if (!result?.draft || validateDraft(result.draft).length) throw new Error('Invalid generated transcript group.');
    note.fallbackUsed ||= result.fallbackUsed === true;
    for (const source of group) {
      const evidence = (quote: string) => [{ kind: 'segment' as const, id: source.segment.id, quote, startMs: source.segment.startMs, endMs: source.segment.endMs }];
      const seen = new Set<string>();
      const selected = result.draft.items.filter(item => {
        const key = `${item.category}\u0000${item.sourceQuote}`;
        if (!source.quote.includes(item.sourceQuote) || seen.has(key)) return false;
        seen.add(key); return true;
      });
      for (const item of selected) note.items.push({ id: randomUUID(), section: item.category, text: item.sourceQuote, evidence: evidence(item.sourceQuote), ...(result.fallbackUsed ? { fallback: true } : {}) });
      // Full exact source remains visible even when extraction selected only part of it.
      if (!selected.some(item => item.sourceQuote === source.quote)) { note.items.push({ id: randomUUID(), section: 'follow_up', text: source.quote, evidence: evidence(source.quote), fallback: true }); note.fallbackUsed = true; }
    }
  }
  if (note.fallbackUsed) note.warnings!.push('AI 분류에서 빠진 원문은 추가 확인 항목으로 보존했습니다. 직접 분류하고 검토해 주세요.');
  for (const bookmark of session.bookmarks) {
    for (const section of ['observation', 'moments'] as ConsultationSection[]) note.items.push({ id: randomUUID(), section, text: bookmark.text, evidence: [{ kind: 'bookmark', id: bookmark.id, quote: bookmark.text, startMs: bookmark.atMs, endMs: bookmark.atMs }] });
  }
  for (const scene of session.vision?.state === 'complete' ? session.vision.scenes : []) for (const quote of scene.observations) {
    note.items.push({ id: randomUUID(), section: 'observation', text: quote, evidence: [{ kind: 'vision', id: scene.id, quote, startMs: Math.min(...scene.frameTimesMs), endMs: Math.max(...scene.frameTimesMs) }] });
  }
  note.missingSections = consultationSections.filter(section => !note.items.some(item => item.section === section));
  if (validateConsultationNote(note, session).length) throw new Error('Detailed note failed evidence validation.');
  return note;
}
