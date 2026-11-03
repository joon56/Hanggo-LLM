import { describe, expect, it } from 'vitest';
import { newConsultation, setConsent, transition, TransitionError } from './coaching';

const base = () => newConsultation({ id: 'c1', caseId: 'case-1', createdAt: '2026-11-03T00:00:00.000Z' });
const live = (now = 1000) => transition(base(), 'start', now);

describe('transition', () => {
  it('walks the normal path from scheduled to approved', () => {
    let current = base();
    expect(current.state).toBe('scheduled');
    for (const [event, state] of [['start', 'live'], ['end', 'processing'], ['processed', 'review'], ['approve', 'approved']] as const) {
      current = transition(current, event, 5000);
      expect(current.state).toBe(state);
    }
  });
  it.each([
    ['scheduled', 'approve'], ['scheduled', 'end'], ['scheduled', 'processed'], ['scheduled', 'interrupt'],
    ['live', 'start'], ['live', 'approve'], ['live', 'processed'],
    ['processing', 'start'], ['processing', 'approve'], ['processing', 'end'],
    ['review', 'start'], ['review', 'end'], ['review', 'interrupt'],
    ['approved', 'start'], ['approved', 'approve'], ['approved', 'interrupt'],
    ['interrupted', 'start'], ['interrupted', 'approve'],
  ] as const)('rejects %s + %s', (state, event) => {
    expect(() => transition({ ...base(), state }, event, 1)).toThrow(TransitionError);
  });
  it('interrupts live and processing consultations and stops recording', () => {
    const recording = setConsent(setConsent(live(), 'guardian', true, 1100), 'trainer', true, 1200);
    const interrupted = transition(recording, 'interrupt', 1300);
    expect(interrupted).toMatchObject({ state: 'interrupted', recording: false });
    expect(transition({ ...base(), state: 'processing' }, 'interrupt', 1).state).toBe('interrupted');
  });
  it('does not mutate its input', () => {
    const input = base();
    transition(input, 'start', 1);
    expect(input.state).toBe('scheduled');
  });
  it('stamps start and end times', () => {
    const ended = transition(live(1000), 'end', 4000);
    expect(ended).toMatchObject({ startedAt: 1000, endedAt: 4000 });
  });
});

describe('setConsent', () => {
  it('starts recording only when both sides consent during a live consultation', () => {
    const first = setConsent(live(), 'guardian', true, 2000);
    expect(first).toMatchObject({ recording: false, consent: { guardian: true, trainer: false } });
    const both = setConsent(first, 'trainer', true, 3000);
    expect(both).toMatchObject({ recording: true, recordingStartedAt: 3000, recordingGaps: [] });
  });
  it('waits for the start when consent arrives before the consultation is live', () => {
    const consented = setConsent(setConsent(base(), 'guardian', true, 100), 'trainer', true, 200);
    expect(consented.recording).toBe(false);
    expect(transition(consented, 'start', 900)).toMatchObject({ recording: true, recordingStartedAt: 900 });
  });
  it('stops on withdrawal, keeps the call live, and records the gap on the same clock', () => {
    const recording = setConsent(setConsent(live(), 'guardian', true, 2000), 'trainer', true, 3000);
    const withdrawn = setConsent(recording, 'guardian', false, 8000);
    expect(withdrawn).toMatchObject({ state: 'live', recording: false, recordingGaps: [{ startMs: 5000 }] });
    const resumed = setConsent(withdrawn, 'guardian', true, 10000);
    expect(resumed).toMatchObject({ recording: true, recordingStartedAt: 3000, recordingGaps: [{ startMs: 5000, endMs: 7000 }] });
  });
  it('closes an open gap when the consultation ends during withdrawal', () => {
    const recording = setConsent(setConsent(live(), 'guardian', true, 2000), 'trainer', true, 3000);
    const ended = transition(setConsent(recording, 'trainer', false, 4000), 'end', 9000);
    expect(ended.recordingGaps).toEqual([{ startMs: 1000, endMs: 6000 }]);
  });
  it('stops recording when the consultation ends', () => {
    const recording = setConsent(setConsent(live(), 'guardian', true, 2000), 'trainer', true, 3000);
    expect(transition(recording, 'end', 9000)).toMatchObject({ recording: false, recordingGaps: [] });
  });
  it('is idempotent for repeated identical consent', () => {
    const recording = setConsent(setConsent(live(), 'guardian', true, 2000), 'trainer', true, 3000);
    expect(setConsent(recording, 'trainer', true, 5000)).toEqual(recording);
  });
  it('rejects consent changes after the live phase', () => {
    expect(() => setConsent({ ...base(), state: 'approved' }, 'guardian', true, 1)).toThrow(TransitionError);
  });
});
