import { setTimeout as delay } from 'node:timers/promises';
import { transition } from '../../src/domain/coaching.ts';
import type { Consultation, OrganizingProgress } from '../../src/domain/coaching.ts';
import { buildNoteSource, emptyNote } from '../../src/domain/coaching-note.ts';
import type { LlmProvider } from '../ai/llm/types.ts';
import { createNoteService } from './note-service.ts';
import { createSceneService } from './scene-service.ts';
import type { CoachingStore } from './store.ts';
import type { Transcription } from './transcription.ts';

const OPEN_REVIEW_ATTEMPTS = 3;
type Deps = {
  store: CoachingStore; transcription: Pick<Transcription, 'settle' | 'close'>; llm?: LlmProvider;
  /** Slower machines can raise the limit on a single model call. */
  callTimeoutMs?: number;
  retryDelayMs?: number;
  notify?: (consultation: Consultation) => void;
  now?: () => number;
};
export type PostProcess = ReturnType<typeof createPostProcess>;

/** Everything after a call, in the order one GPU allows: speech model out, then scenes, then the note. */
export function createPostProcess({ store, transcription, llm, callTimeoutMs, notify, retryDelayMs = 1000, now = Date.now }: Deps) {
  const scenes = llm && createSceneService({ llm, store, callTimeoutMs });
  const notes = llm && createNoteService({ llm, now, callTimeoutMs });
  const stopping = new AbortController();
  const running = new Set<Promise<unknown>>();
  const track = <T>(work: Promise<T>) => { running.add(work); void work.finally(() => running.delete(work)).catch(() => {}); return work; };
  /** Writing down a failure must not become a second failure that holds everything else up. */
  const addError = (id: string, code: string, message: string) => store.updateConsultation(id, current => ({ ...current, errors: [...current.errors, { code, message }] })).then(() => {}, () => {});

  /** Only a display, so a write that fails here must not stop the work it describes. */
  const reportStage = (id: string, stage: OrganizingProgress['stage']) => (done: number, total: number) =>
    store.updateConsultation(id, current => ({ ...current, organizing: { stage, done, total } })).then(() => {}, () => {});

  async function draftNote(id: string, replacing = false) {
    const consultation = await store.getConsultation(id);
    const info = await store.getCase(consultation.caseId);
    const note = notes ? await notes.generate(consultation, info, stopping.signal, reportStage(id, 'note'))
      : emptyNote(buildNoteSource(consultation, info), new Date(now()).toISOString(), ['AI 기능이 꺼져 있어 빈 양식을 만들었습니다.']);
    // A blank form is better than nothing, but not better than a draft the trainer already has.
    const hasAnything = [note.summary, note.concerns, note.behaviors, note.guardianReports, note.trainerObservations, note.guidance, note.tasks, note.followUps].some(section => section.length);
    if (replacing && (note.fallbackUsed || !hasAnything)) throw new Error('No new draft.');
    await store.updateConsultation(id, current => ({ ...current, note }));
  }

  /** These states block every new call on this GPU, so leaving one gets more than one chance to be written. */
  async function persisted(change: Parameters<CoachingStore['updateConsultation']>[1], id: string) {
    for (let attempt = 1; ; attempt += 1) {
      try { return await store.updateConsultation(id, change); }
      catch (error) {
        if (attempt >= OPEN_REVIEW_ATTEMPTS) throw error;
        await delay(retryDelayMs, undefined, { ref: false });
      }
    }
  }
  const openReview = (id: string) => persisted(({ organizing: _organizing, ...current }) => transition(current, 'processed', now()), id);

  /** A failure here must not hold the review back, because the transcript is still worth reading. */
  async function organize(id: string) {
    try {
      if (scenes) {
        const analyzed = await scenes.analyze(await store.getConsultation(id), stopping.signal, reportStage(id, 'scenes'));
        await store.updateConsultation(id, current => ({ ...current, scenes: analyzed }));
      }
      await draftNote(id);
    } catch (error) {
      if (stopping.signal.aborted) throw error;
      await addError(id, 'POST_PROCESS', '상담 정리 중 문제가 생겼습니다. 전사를 보고 직접 작성해 주세요.');
    } finally { await llm?.release().catch(() => {}); }
  }

  return {
    /** Loading the speech model now would push the LLM off the GPU in the middle of its work. */
    busy: () => running.size > 0,
    finish(id: string) {
      return track((async () => {
        await transcription.settle(id);
        if (stopping.signal.aborted) return;
        await organize(id);
        const opened = await openReview(id);
        notify?.(opened);
      })().catch(error => { if (!stopping.signal.aborted) throw error; }));
    },
    /** Returns once the work has started. A draft can take minutes, longer than a tunnel will hold a request open. */
    async regenerate(id: string) {
      await store.updateConsultation(id, current => ({ ...current, noteGenerating: true }));
      void track((async () => {
        try { await draftNote(id, true); }
        catch (error) { if (stopping.signal.aborted) return; await addError(id, 'NOTE_REGENERATE', '일지를 다시 만들지 못했습니다. 이전 내용을 유지합니다.'); }
        finally { await llm?.release().catch(() => {}); }
        await persisted(({ noteGenerating: _noteGenerating, organizing: _organizing, ...current }) => current, id);
      })().catch(() => {}));
    },
    /** Interrupted work is left for recovery, which marks it on the next start. */
    async close() {
      stopping.abort();
      await transcription.close();
      await Promise.allSettled(running);
    },
  };
}
