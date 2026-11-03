// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setConsent } from '../../src/domain/coaching.ts';
import type { Speaker } from '../../src/domain/coaching.ts';
import type { SpeechProvider, SpeechResult } from '../ai/speech/types.ts';
import { createFileStore, type CoachingStore } from './store.ts';
import { createTranscription } from './transcription.ts';

let directory: string; let store: CoachingStore; let consultationId: string;
const wav = () => Buffer.from([1, 2, 3]);
type Deferred = { wav: Buffer; resolve: (text: string) => void; reject: (error: Error) => void };

beforeEach(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'hanggo-transcription-'));
  store = createFileStore(directory);
  const created = await store.createCase({ petName: '초코', guardianName: '가상 보호자', trainerName: '가상 훈련사' });
  consultationId = (await store.startConsultation(created.case.id)).id;
  const now = 1000;
  await store.updateConsultation(consultationId, current => setConsent(setConsent(current, 'guardian', true, now), 'trainer', true, now));
});
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

function controlledSpeech() {
  const calls: Deferred[] = [];
  const speech: SpeechProvider & { prepare: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> } = {
    prepare: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
    transcribe: bytes => new Promise<SpeechResult>((resolve, reject) => {
      calls.push({ wav: bytes, resolve: text => resolve({ text, model: 'fake', latencyMs: 5 }), reject });
    }),
  };
  return { speech, calls };
}
function build(speech: SpeechProvider | undefined, options: { now?: () => number; graceMs?: number } = {}) {
  const broadcast = vi.fn<(id: string, message: any) => void>();
  const transcription = createTranscription({ store, speech, broadcast, graceMs: options.graceMs ?? 1, now: options.now });
  return { transcription, broadcast };
}
const times = (startMs: number, endMs = startMs + 3000) => ({ startMs, endMs });
const accept = (transcription: ReturnType<typeof build>['transcription'], speaker: Speaker, startMs: number, bytes = wav()) => transcription.accept(consultationId, speaker, times(startMs), bytes);
const segments = async () => (await store.getConsultation(consultationId)).segments;
/** Reads share the store's queue, so each one waits for the writes already started. */
const settle = async () => { for (let index = 0; index < 8; index++) { await store.getConsultation(consultationId); await new Promise(resolve => setImmediate(resolve)); } };
const captions = (broadcast: ReturnType<typeof build>['broadcast']) => broadcast.mock.calls.filter(call => call[1].type === 'caption').flatMap(call => call[1].segments);

describe('queue', () => {
  it('transcribes one window at a time, in arrival order', async () => {
    const { speech, calls } = controlledSpeech(); const { transcription } = build(speech);
    await accept(transcription, 'guardian', 0, Buffer.from([1]));
    await accept(transcription, 'trainer', 100, Buffer.from([2]));
    await settle();
    expect(calls).toHaveLength(1);
    calls[0].resolve('첫 구간'); await settle();
    expect(calls).toHaveLength(2);
    calls[1].resolve('둘째 구간'); await settle();
    expect((await segments()).map(item => [item.speaker, item.text, item.state])).toEqual([['guardian', '첫 구간', 'complete'], ['trainer', '둘째 구간', 'complete']]);
  });
  it('keeps segments in speaking order when a later window was accepted first', async () => {
    const { speech, calls } = controlledSpeech(); const { transcription } = build(speech);
    await accept(transcription, 'trainer', 5000);
    await accept(transcription, 'guardian', 1000);
    expect((await segments()).map(item => item.startMs)).toEqual([1000, 5000]);
    calls[0]?.resolve('');
  });
  it('sends a caption only once the text exists', async () => {
    const { speech, calls } = controlledSpeech(); const { transcription, broadcast } = build(speech);
    await accept(transcription, 'guardian', 0); await settle();
    expect(captions(broadcast)).toEqual([]);
    calls[0].resolve('어제 초인종에 짖었어요'); await settle();
    expect(captions(broadcast)).toEqual([expect.objectContaining({ speaker: 'guardian', startMs: 0, endMs: 3000, text: '어제 초인종에 짖었어요', state: 'complete' })]);
    expect(captions(broadcast)[0]).not.toHaveProperty('originalText');
  });
  it('wipes the audio from memory once it has been processed', async () => {
    const { speech, calls } = controlledSpeech(); const { transcription } = build(speech);
    const bytes = Buffer.from([9, 9, 9]);
    await accept(transcription, 'guardian', 0, bytes); await settle();
    calls[0].resolve('구간'); await settle();
    expect([...bytes]).toEqual([0, 0, 0]);
  });
  it('removes a window the model heard nothing in', async () => {
    const { speech, calls } = controlledSpeech(); const { transcription, broadcast } = build(speech);
    await accept(transcription, 'guardian', 0); await settle();
    calls[0].resolve('  '); await settle();
    expect(await segments()).toEqual([]);
    expect(captions(broadcast)).toEqual([]);
  });
  it('ignores a retried window', async () => {
    const { speech, calls } = controlledSpeech(); const { transcription } = build(speech);
    const first = await accept(transcription, 'guardian', 0);
    const second = await accept(transcription, 'guardian', 0);
    expect(second.id).toBe(first.id);
    await settle();
    expect(calls).toHaveLength(1);
    expect(await segments()).toHaveLength(1);
  });
  it('lets each speaker use the same time, but not the same speaker twice', async () => {
    const { speech } = controlledSpeech(); const { transcription } = build(speech);
    await accept(transcription, 'guardian', 0);
    await expect(accept(transcription, 'trainer', 0)).resolves.toMatchObject({ speaker: 'trainer' });
    await expect(accept(transcription, 'guardian', 1000)).rejects.toMatchObject({ code: 'OVERLAP', status: 409 });
    await expect(accept(transcription, 'guardian', 2800)).resolves.toMatchObject({ speaker: 'guardian' });
  });
  it('refuses new windows when too many are waiting, so a stuck model cannot fill memory', async () => {
    const { speech } = controlledSpeech(); const { transcription } = build(speech);
    for (let index = 0; index < 65; index++) await accept(transcription, 'guardian', index * 4000);
    await expect(accept(transcription, 'guardian', 400000)).rejects.toMatchObject({ code: 'BUSY', status: 429 });
  });
});

describe('failures', () => {
  it('marks a failed window, tells both sides, and continues with a freshly prepared model', async () => {
    const { speech, calls } = controlledSpeech(); const { transcription, broadcast } = build(speech);
    await accept(transcription, 'guardian', 0);
    await accept(transcription, 'guardian', 4000);
    await settle();
    expect(speech.prepare).toHaveBeenCalledTimes(1);
    calls[0].reject(new Error('model died')); await settle();
    expect(speech.prepare).toHaveBeenCalledTimes(2);
    calls[1].resolve('다음 구간'); await settle();
    expect((await segments()).map(item => item.state)).toEqual(['failed', 'complete']);
    expect(captions(broadcast).map(item => item.state)).toEqual(['failed', 'complete']);
  });
  it('shows preparation status and keeps the call out of it when the model will not start', async () => {
    const { speech } = controlledSpeech();
    speech.prepare.mockRejectedValue(new Error('not installed'));
    const { transcription, broadcast } = build(speech);
    transcription.start(consultationId); await settle();
    expect(broadcast.mock.calls.filter(call => call[1].type === 'speech').map(call => call[1].status)).toEqual(['preparing', 'failed']);
    expect(transcription.status()).toBe('failed');
  });
  it('does not reload a broken model for every window, but tries again later', async () => {
    let time = 1000;
    const { speech } = controlledSpeech();
    speech.prepare.mockRejectedValue(new Error('not installed'));
    const { transcription } = build(speech, { now: () => time });
    await accept(transcription, 'guardian', 0); await settle();
    await accept(transcription, 'guardian', 4000); await settle();
    expect(speech.prepare).toHaveBeenCalledTimes(1);
    expect((await segments()).map(item => item.state)).toEqual(['failed', 'failed']);
    time += 31_000;
    await accept(transcription, 'guardian', 8000); await settle();
    expect(speech.prepare).toHaveBeenCalledTimes(2);
  });
  it('reports off and refuses windows when the deployment has no speech provider', async () => {
    const { transcription } = build(undefined);
    expect(transcription.status()).toBe('off');
    await expect(accept(transcription, 'guardian', 0)).rejects.toMatchObject({ code: 'SPEECH_OFF', status: 503 });
  });
});

describe('echo', () => {
  const heard = '매트로 가면 바로 간식을 주세요';
  it('flags the later window when the other speaker said the same words first', async () => {
    const { speech, calls } = controlledSpeech(); const { transcription, broadcast } = build(speech);
    await accept(transcription, 'trainer', 0);
    await accept(transcription, 'guardian', 1000);
    await settle(); calls[0].resolve(heard); await settle(); calls[1].resolve(heard); await settle();
    const [trainer, guardian] = await segments();
    expect(trainer.echoSuspect).toBeUndefined();
    expect(guardian).toMatchObject({ echoSuspect: true, text: heard, originalText: heard });
    expect(captions(broadcast).at(-1)).toMatchObject({ speaker: 'guardian', echoSuspect: true });
  });
  it('flags the later window even when its transcription finished first', async () => {
    const { speech, calls } = controlledSpeech(); const { transcription, broadcast } = build(speech);
    await accept(transcription, 'guardian', 1000);
    await accept(transcription, 'trainer', 0);
    await settle(); calls[0].resolve(heard); await settle(); calls[1].resolve(heard); await settle();
    const [trainer, guardian] = await segments();
    expect(trainer.echoSuspect).toBeUndefined();
    expect(guardian.echoSuspect).toBe(true);
    expect(captions(broadcast).filter(item => item.echoSuspect).map(item => item.speaker)).toEqual(['guardian']);
  });
});

describe('finish', () => {
  async function ending() {
    await store.updateConsultation(consultationId, current => ({ ...current, state: 'processing', recording: false, endedAt: 5000 }));
  }
  it('prepares the model when recording starts and not before', async () => {
    const { speech } = controlledSpeech(); const { transcription, broadcast } = build(speech);
    expect(speech.prepare).not.toHaveBeenCalled();
    transcription.start(consultationId); await settle();
    expect(speech.prepare).toHaveBeenCalledTimes(1);
    expect(broadcast.mock.calls.at(-1)?.[1]).toEqual({ type: 'speech', status: 'ready' });
    expect(transcription.status()).toBe('ready');
  });
  it('waits for the last windows, then frees the model', async () => {
    const { speech, calls } = controlledSpeech(); const { transcription } = build(speech, { graceMs: 20 });
    await ending();
    const settled = transcription.settle(consultationId);
    await accept(transcription, 'guardian', 0); await settle();
    expect(speech.release).not.toHaveBeenCalled();
    calls[0].resolve('마지막 구간');
    await settled;
    expect(speech.release).toHaveBeenCalledTimes(1);
    expect((await store.getConsultation(consultationId)).segments[0]).toMatchObject({ text: '마지막 구간' });
    expect(transcription.status()).toBe('idle');
  });
  it('records the problem when the model will not go away', async () => {
    const { speech } = controlledSpeech();
    speech.release.mockRejectedValue(new Error('still running'));
    const { transcription } = build(speech);
    await ending();
    await transcription.settle(consultationId);
    expect((await store.getConsultation(consultationId)).errors).toEqual([expect.objectContaining({ code: 'SPEECH_RELEASE' })]);
  });
  it('leaves the model alone when the server is shutting down', async () => {
    const { speech } = controlledSpeech(); const { transcription } = build(speech, { graceMs: 5 });
    await ending();
    const settled = transcription.settle(consultationId);
    await transcription.close();
    await settled;
    expect(speech.release).not.toHaveBeenCalled();
  });
  it('turns windows lost to a restart into visible failures instead of leaving them queued', async () => {
    const { speech } = controlledSpeech(); const { transcription } = build(speech);
    await accept(transcription, 'guardian', 0);
    await store.recoverInterrupted();
    const consultation = await store.getConsultation(consultationId);
    expect(consultation.state).toBe('interrupted');
    expect(consultation.segments[0].state).toBe('failed');
  });
});
