import type { CaptureSource, VisionAnalysis } from './consultation-vision.ts';
import type { Metadata } from './notes.ts';

export const consultationSections = ['purpose', 'owner_report', 'observation', 'guidance', 'task', 'follow_up', 'moments'] as const;
export type ConsultationSection = typeof consultationSections[number];
export type TranscriptSegment = { id: string; sequence: number; startMs: number; endMs: number; text: string; originalText: string; state: 'queued' | 'processing' | 'complete' | 'failed'; model?: string; latencyMs?: number };
export type ConsultationBookmark = { id: string; atMs: number; text: string };
export type ConsultationEvidence = { kind: 'segment' | 'bookmark' | 'vision'; id: string; quote: string; startMs: number; endMs: number };
export type ConsultationNote = { items: { id: string; section: ConsultationSection; text: string; evidence: ConsultationEvidence[]; fallback?: boolean }[]; missingSections: ConsultationSection[]; coveredSegmentIds: string[]; createdAt: string; approvedAt?: string; fallbackUsed?: boolean; warnings?: string[] };
export type ConsultationSession = { id: string; captureSource?: CaptureSource; vision?: VisionAnalysis; metadata: Metadata; createdAt: string; state: 'preparing' | 'recording' | 'processing' | 'ready' | 'incomplete' | 'interrupted'; durationMs: number; segments: TranscriptSegment[]; bookmarks: ConsultationBookmark[]; recordingChunkCount: number; errors: { code: string; message: string; sequence?: number }[]; note?: ConsultationNote; noteRevision?: string };

export function validateConsultationNote(value: unknown, session: ConsultationSession): string[] {
  if (!value || typeof value !== 'object') return ['INPUT'];
  const note = value as ConsultationNote;
  if (!Array.isArray(note.items) || (!note.items.length && (session.segments.some(segment => segment.state === 'complete' && segment.text.trim()) || session.bookmarks.length > 0 || session.vision?.scenes.some(scene => scene.observations.length > 0))) || note.items.length > 10000 || !Array.isArray(note.missingSections) || !Array.isArray(note.coveredSegmentIds) || typeof note.createdAt !== 'string' || !Number.isFinite(Date.parse(note.createdAt))) return ['INPUT'];
  const errors = new Set<string>(); const ids = new Set<string>(); const covered = new Set<string>(); const visualCovered = new Set<string>();
  for (const item of note.items) {
    if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id) || !consultationSections.includes(item.section) || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 2000 || !Array.isArray(item.evidence) || !item.evidence.length || item.evidence.length > 20) { errors.add('INPUT'); continue; }
    ids.add(item.id);
    const quotes: string[] = [];
    for (const evidence of item.evidence) {
      if (!evidence || typeof evidence.quote !== 'string' || !evidence.quote.trim()) { errors.add('EVIDENCE'); continue; }
      const segment = evidence.kind === 'segment' ? session.segments.find(segment => segment.id === evidence.id && segment.state === 'complete') : undefined;
      const bookmark = evidence.kind === 'bookmark' ? session.bookmarks.find(bookmark => bookmark.id === evidence.id) : undefined;
      const scene = evidence.kind === 'vision' && session.vision?.state === 'complete' ? session.vision.scenes.find(scene => scene.id === evidence.id && scene.state === 'complete') : undefined;
      const source = segment?.text ?? bookmark?.text ?? scene?.observations.find(quote => quote === evidence.quote);
      if (!source?.includes(evidence.quote) || evidence.startMs !== (segment?.startMs ?? bookmark?.atMs ?? (scene && Math.min(...scene.frameTimesMs))) || evidence.endMs !== (segment?.endMs ?? bookmark?.atMs ?? (scene && Math.max(...scene.frameTimesMs)))) errors.add('EVIDENCE');
      else { quotes.push(evidence.quote); if (segment) covered.add(segment.id); if (scene) visualCovered.add(JSON.stringify([scene.id, evidence.quote])); }
    }
    // Source-only extraction prevents added facts, diagnoses, tasks and numbers.
    if (!quotes.includes(item.text)) errors.add('UNSUPPORTED_TEXT');
  }
  if (errors.has('INPUT')) return [...errors];
  const expected = session.segments.filter(segment => segment.state === 'complete' && segment.text.trim()).map(segment => segment.id);
  if (new Set(note.coveredSegmentIds).size !== note.coveredSegmentIds.length || expected.some(id => !note.coveredSegmentIds.includes(id) || !covered.has(id)) || note.coveredSegmentIds.some(id => !expected.includes(id))) errors.add('COVERAGE');
  if (session.vision?.state === 'complete' && session.vision.scenes.some(scene => scene.observations.some(quote => !visualCovered.has(JSON.stringify([scene.id, quote]))))) errors.add('VISION_COVERAGE');
  const missing = consultationSections.filter(section => !note.items.some(item => item.section === section));
  if (missing.length !== note.missingSections.length || missing.some(section => !note.missingSections.includes(section))) errors.add('SECTIONS');
  return [...errors];
}
