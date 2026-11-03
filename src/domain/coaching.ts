import type { CoachingNote, Scene } from './coaching-note.ts';

export type Speaker = 'guardian' | 'trainer';
export type CoachingCase = {
  id: string; petName: string; guardianName: string; trainerName: string; createdAt: string; inviteHash: string; inviteExpiresAt: string;
  /** Reissuing an invite bumps this so sessions from an earlier device stop working. */
  guardianGeneration: number;
};
export type ConsultationState = 'scheduled' | 'live' | 'processing' | 'review' | 'approved' | 'interrupted';
export type RecordingGap = { startMs: number; endMs?: number };
export type SegmentState = 'queued' | 'complete' | 'failed';
export type Segment = {
  id: string; speaker: Speaker; startMs: number; endMs: number; text: string; originalText: string; state: SegmentState;
  /** Likely the other speaker heard through this microphone. The text stays, but notes must not cite it. */
  echoSuspect?: boolean; model?: string; latencyMs?: number;
};
export type SpeechStatus = 'off' | 'idle' | 'preparing' | 'ready' | 'failed';
export type MomentNotice = Pick<Moment, 'id' | 'atMs' | 'createdBy'>;
export type Caption = Pick<Segment, 'id' | 'speaker' | 'startMs' | 'endMs' | 'text' | 'state' | 'echoSuspect'>;
export type Moment = { id: string; atMs: number; createdBy: Speaker; text?: string; frameIds: string[] };
export type FrameRef = { id: string; atMs: number; source: 'camera' | 'screen'; speaker: Speaker; bytes: number };
/** How long one consultation is recorded. Calls can go on past it. */
export const MAX_RECORDING_MS = 60 * 60 * 1000;
export type OrganizingProgress = { stage: 'scenes' | 'note'; done: number; total: number };
export type Consultation = {
  id: string; caseId: string; createdAt: string; state: ConsultationState;
  /** Whether transcription and scene capture may run. Separate from state because the call continues without it. */
  recording: boolean; consent: Record<Speaker, boolean>;
  startedAt?: number; endedAt?: number; recordingStartedAt?: number;
  recordingGaps: RecordingGap[]; errors: { code: string; message: string }[];
  segments: Segment[]; moments: Moment[]; frames: FrameRef[];
  scenes: Scene[]; note?: CoachingNote;
  /** A draft is being generated, so the review screen waits instead of offering stale text. */
  noteGenerating?: boolean;
  /** How far work after the call has got, since a long consultation can take many minutes. */
  organizing?: OrganizingProgress;
};
export const captionOf = ({ id, speaker, startMs, endMs, text, state, echoSuspect }: Segment): Caption => ({ id, speaker, startMs, endMs, text, state, echoSuspect });
export type TaskLogStatus = 'done' | 'partial' | 'skipped';
export type TaskLog = { id: string; caseId: string; consultationId: string; taskId: string; at: string; status: TaskLogStatus; text?: string };
export type ConsultationEvent = 'start' | 'end' | 'processed' | 'approve' | 'interrupt';

export class TransitionError extends Error {}

export function newConsultation(input: { id: string; caseId: string; createdAt: string }): Consultation {
  return { ...input, state: 'scheduled', recording: false, consent: { guardian: false, trainer: false }, recordingGaps: [], errors: [], segments: [], moments: [], frames: [], scenes: [] };
}

const nextState: Partial<Record<ConsultationState, Partial<Record<ConsultationEvent, ConsultationState>>>> = {
  scheduled: { start: 'live' },
  live: { end: 'processing', interrupt: 'interrupted' },
  processing: { processed: 'review', interrupt: 'interrupted' },
  review: { approve: 'approved' },
};

/** Keeps one clock across withdrawals so evidence times stay comparable after a recording gap. */
function syncRecording(consultation: Consultation, now: number): Consultation {
  const wanted = consultation.state === 'live' && consultation.consent.guardian && consultation.consent.trainer;
  if (wanted === consultation.recording) return consultation;
  if (wanted) {
    if (consultation.recordingStartedAt === undefined) return { ...consultation, recording: true, recordingStartedAt: now };
    const elapsed = now - consultation.recordingStartedAt;
    return { ...consultation, recording: true, recordingGaps: consultation.recordingGaps.map(gap => gap.endMs === undefined ? { ...gap, endMs: elapsed } : gap) };
  }
  const elapsed = now - consultation.recordingStartedAt!;
  // Ending the consultation is not a gap. Only a live withdrawal leaves one.
  return { ...consultation, recording: false, recordingGaps: consultation.state === 'live' ? [...consultation.recordingGaps, { startMs: elapsed }] : consultation.recordingGaps };
}

export function transition(consultation: Consultation, event: ConsultationEvent, now: number): Consultation {
  const state = nextState[consultation.state]?.[event];
  if (!state) throw new TransitionError(`Cannot ${event} a ${consultation.state} consultation.`);
  let next: Consultation = { ...consultation, state };
  if (event === 'start') next.startedAt = now;
  if (event === 'end' || event === 'interrupt') {
    next.endedAt = now;
    if (next.recordingStartedAt !== undefined) {
      const elapsed = now - next.recordingStartedAt;
      next.recordingGaps = next.recordingGaps.map(gap => gap.endMs === undefined ? { ...gap, endMs: elapsed } : gap);
    }
  }
  next = syncRecording(next, now);
  return next;
}

export function setConsent(consultation: Consultation, role: Speaker, value: boolean, now: number): Consultation {
  if (consultation.state !== 'scheduled' && consultation.state !== 'live') throw new TransitionError(`Cannot change consent on a ${consultation.state} consultation.`);
  if (consultation.consent[role] === value) return consultation;
  return syncRecording({ ...consultation, consent: { ...consultation.consent, [role]: value } }, now);
}

const ECHO_WINDOW_MS = 3000;
const ECHO_MIN_CHARACTERS = 6;
const ECHO_MIN_SIMILARITY = 0.7;
const comparable = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
export function similarity(left: string, right: string) {
  const counts = new Map<string, number>();
  for (let index = 0; index < left.length - 1; index += 1) { const pair = left.slice(index, index + 2); counts.set(pair, (counts.get(pair) ?? 0) + 1); }
  let shared = 0;
  for (let index = 0; index < right.length - 1; index += 1) {
    const pair = right.slice(index, index + 2); const remaining = counts.get(pair) ?? 0;
    if (remaining) { shared += 1; counts.set(pair, remaining - 1); }
  }
  return 2 * shared / (left.length + right.length - 2);
}

/** Short replies repeat naturally in conversation, so only longer text counts as an echo. */
export function findEchoSource(segments: Segment[], candidate: Segment): Segment | undefined {
  const words = comparable(candidate.text);
  if (words.length < ECHO_MIN_CHARACTERS) return undefined;
  return segments.find(other => {
    if (other.speaker === candidate.speaker || other.state !== 'complete') return false;
    if (candidate.startMs - other.endMs > ECHO_WINDOW_MS || other.startMs - candidate.endMs > ECHO_WINDOW_MS) return false;
    const heard = comparable(other.text);
    return heard.length >= ECHO_MIN_CHARACTERS && similarity(words, heard) >= ECHO_MIN_SIMILARITY;
  });
}
