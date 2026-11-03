import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { captionOf, findEchoSource } from '../../src/domain/coaching.ts';
import type { Consultation, Segment, Speaker, SpeechStatus } from '../../src/domain/coaching.ts';
import type { SpeechProvider, SpeechResult } from '../ai/speech/types.ts';
import { StoreError, type CoachingStore } from './store.ts';

const MAX_WAITING = 64;
const OVERLAP_TOLERANCE_MS = 500;
const PREPARE_RETRY_MS = 30_000;
type Item = { consultationId: string; segmentId: string; wav: Buffer };
type Deps = {
  store: CoachingStore; speech?: SpeechProvider;
  broadcast: (consultationId: string, message: unknown) => void;
  /** How long after the end to accept what browsers still hold. */
  graceMs: number;
  now?: () => number;
};
export type Transcription = ReturnType<typeof createTranscription>;

/** Audio stays in memory for this queue only. One GPU serves one window at a time, and the model cannot take a second request. */
export function createTranscription({ store, speech, broadcast, graceMs, now = Date.now }: Deps) {
  const waiting: Item[] = [];
  let status: SpeechStatus = speech ? 'idle' : 'off';
  let running: Promise<void> | undefined;
  let preparing: Promise<boolean> | undefined;
  let retryPrepareAt = 0;
  let closed = false;

  function setStatus(consultationId: string, next: SpeechStatus) { status = next; broadcast(consultationId, { type: 'speech', status: next }); }

  function prepare(consultationId: string) {
    preparing ??= (async () => {
      setStatus(consultationId, 'preparing');
      try { await speech!.prepare(); setStatus(consultationId, 'ready'); return true; }
      catch { retryPrepareAt = now() + PREPARE_RETRY_MS; setStatus(consultationId, 'failed'); return false; }
      finally { preparing = undefined; }
    })();
    return preparing;
  }

  async function complete({ consultationId, segmentId }: Item, { text: raw, model, latencyMs }: SpeechResult) {
    const text = raw.trim();
    const changed: Segment[] = [];
    await store.updateConsultation(consultationId, current => {
      if (!text) return { ...current, segments: current.segments.filter(item => item.id !== segmentId) };
      const segment: Segment = { ...current.segments.find(item => item.id === segmentId)!, text, originalText: text, state: 'complete', model, latencyMs };
      const source = findEchoSource(current.segments, segment);
      // Sound reaches the far microphone after the near one, whichever window the queue happened to finish first.
      const echoId = source && (source.startMs > segment.startMs ? source.id : segment.id);
      const segments = current.segments.map(item => {
        const next = item.id === segmentId ? segment : item;
        const marked = next.id === echoId ? { ...next, echoSuspect: true } : next;
        if (marked !== item) changed.push(marked);
        return marked;
      });
      return { ...current, segments };
    });
    if (changed.length) broadcast(consultationId, { type: 'caption', segments: changed.map(captionOf) });
  }

  async function fail({ consultationId, segmentId }: Item) {
    let failed: Segment | undefined;
    await store.updateConsultation(consultationId, current => ({ ...current, segments: current.segments.map(item => {
      if (item.id !== segmentId) return item;
      failed = { ...item, state: 'failed' };
      return failed;
    }) }));
    if (failed) broadcast(consultationId, { type: 'caption', segments: [captionOf(failed)] });
  }

  async function ready(consultationId: string) {
    if (status === 'ready') return true;
    if (status === 'failed' && now() < retryPrepareAt) return false;
    return prepare(consultationId);
  }

  async function process(item: Item) {
    try {
      if (!await ready(item.consultationId)) { await fail(item); return; }
      await complete(item, await speech!.transcribe(item.wav));
    } catch {
      // The provider ends its process after a failed request, so the next window has to prepare it again.
      status = 'idle';
      await fail(item).catch(() => {});
    } finally { item.wav.fill(0); }
  }

  async function run() {
    while (waiting.length && !closed) await process(waiting.shift()!);
  }

  async function drain() { while (running) await running; }

  return {
    status: () => status,
    start(consultationId: string) {
      if (speech && (status === 'idle' || status === 'failed')) void prepare(consultationId);
    },
    /** The start time identifies a window, so a browser retrying after a lost reply cannot transcribe it twice. */
    async accept(consultationId: string, speaker: Speaker, times: { startMs: number; endMs: number }, wav: Buffer) {
      if (!speech) throw new StoreError('SPEECH_OFF', '받아쓰기를 사용할 수 없습니다.', 503);
      if (waiting.length >= MAX_WAITING) throw new StoreError('BUSY', '받아쓰기가 밀려 있습니다. 잠시 후 다시 보냅니다.', 429);
      let segment!: Segment; let added = false;
      await store.updateConsultation(consultationId, current => {
        const mine = current.segments.filter(item => item.speaker === speaker);
        const same = mine.find(item => item.startMs === times.startMs);
        if (same) { segment = same; return current; }
        // Audio time per speaker cannot exceed real time, which also caps how much one browser can make the GPU do.
        if (mine.some(item => times.startMs < item.endMs - OVERLAP_TOLERANCE_MS && item.startMs < times.endMs - OVERLAP_TOLERANCE_MS)) throw new StoreError('OVERLAP', '이미 받은 구간과 겹칩니다.', 409);
        segment = { id: randomUUID(), speaker, ...times, text: '', originalText: '', state: 'queued' };
        added = true;
        return { ...current, segments: [...current.segments, segment].sort((left, right) => left.startMs - right.startMs) };
      });
      if (added) {
        waiting.push({ consultationId, segmentId: segment.id, wav });
        running ??= run().finally(() => { running = undefined; });
      }
      return segment;
    },
    /** GPU order from the design: the speech model leaves before anything else needs the card. */
    async settle(consultationId: string) {
      await delay(graceMs, undefined, { ref: false });
      await drain();
      if (closed) return;
      try { await speech?.release(); }
      catch { await store.updateConsultation(consultationId, current => ({ ...current, errors: [...current.errors, { code: 'SPEECH_RELEASE', message: '음성 모델을 내리지 못했습니다.' }] })); }
      if (speech) status = 'idle';
    },
    async close() {
      closed = true;
      await drain();
    },
  };
}
