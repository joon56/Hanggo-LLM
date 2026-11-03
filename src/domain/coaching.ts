export type Speaker = 'guardian' | 'trainer';
export type CoachingCase = { id: string; petName: string; guardianName: string; trainerName: string; createdAt: string; inviteHash: string; inviteExpiresAt: string };
export type ConsultationState = 'scheduled' | 'live' | 'processing' | 'review' | 'approved' | 'interrupted';
export type RecordingGap = { startMs: number; endMs?: number };
export type Consultation = {
  id: string; caseId: string; createdAt: string; state: ConsultationState;
  /** Whether transcription and scene capture may run. Separate from state because the call continues without it. */
  recording: boolean; consent: Record<Speaker, boolean>;
  startedAt?: number; endedAt?: number; recordingStartedAt?: number;
  recordingGaps: RecordingGap[]; errors: { code: string; message: string }[];
};
export type ConsultationEvent = 'start' | 'end' | 'processed' | 'approve' | 'interrupt';

export class TransitionError extends Error {}

export function newConsultation(input: { id: string; caseId: string; createdAt: string }): Consultation {
  return { ...input, state: 'scheduled', recording: false, consent: { guardian: false, trainer: false }, recordingGaps: [], errors: [] };
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
