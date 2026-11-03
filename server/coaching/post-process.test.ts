// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Consultation, Segment } from '../../src/domain/coaching.ts';
import { createStubLlm } from '../ai/llm/stub.ts';
import type { LlmProvider } from '../ai/llm/types.ts';
import { createPostProcess } from './post-process.ts';
import { createFileStore, type CoachingStore } from './store.ts';

let directory: string; let store: CoachingStore; let id: string;
const spoken = (segmentId: string, speaker: Segment['speaker'], startMs: number, text: string): Segment => ({ id: segmentId, speaker, startMs, endMs: startMs + 1000, text, originalText: text, state: 'complete' });
const frameId = '00000000-0000-4000-8000-000000000001';

beforeEach(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'hanggo-post-'));
  store = createFileStore(directory);
  const created = await store.createCase({ petName: '초코', guardianName: '가상 보호자', trainerName: '가상 훈련사' });
  id = (await store.startConsultation(created.case.id)).id;
  await store.putFrame(id, frameId, Buffer.from([0xff, 0xd8, 0xff, 1]));
  await store.updateConsultation(id, current => ({ ...current, state: 'processing', endedAt: 5000, segments: [
    spoken('00000000-0000-4000-8000-00000000000a', 'guardian', 0, '초인종이 울리면 짖어요'), spoken('00000000-0000-4000-8000-00000000000b', 'trainer', 2000, '매트로 가는 연습을 해 주세요'),
  ], frames: [{ id: frameId, atMs: 0, source: 'camera', speaker: 'guardian', bytes: 4 }] }));
});
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

function build(llm?: LlmProvider) {
  const settle = vi.fn(async () => {});
  const notify = vi.fn<(consultation: Consultation) => void>();
  const process = createPostProcess({ store, transcription: { settle, close: async () => {} }, llm, notify });
  return { process, settle, notify };
}
const failing = (change: Partial<LlmProvider>): LlmProvider => ({ ...createStubLlm(), ...change });

describe('finish', () => {
  it('records how far it has got, so a long wait shows progress, and clears that when done', async () => {
    const seen: unknown[] = [];
    const stub = createStubLlm();
    const llm: LlmProvider = { ...stub, structured: async request => { seen.push((await store.getConsultation(id)).organizing); return stub.structured(request); } };
    await build(llm).process.finish(id);
    expect(seen).toEqual([{ stage: 'scenes', done: 0, total: 1 }, { stage: 'note', done: 0, total: 1 }]);
    expect((await store.getConsultation(id)).organizing).toBeUndefined();
  });
  it('moves through speech, scenes, and the note in order, then opens the review', async () => {
    const order: string[] = [];
    const stub = createStubLlm();
    const llm: LlmProvider = { ...stub, release: async () => { order.push('release'); }, structured: request => { order.push(request.images ? 'scene' : 'note'); return stub.structured(request); } };
    const settle = vi.fn(async () => { order.push('settle'); });
    const notify = vi.fn();
    await createPostProcess({ store, transcription: { settle, close: async () => {} }, llm, notify }).finish(id);
    expect(order).toEqual(['settle', 'scene', 'note', 'release']);
    const done = await store.getConsultation(id);
    expect(done.state).toBe('review');
    expect(done.scenes[0]).toMatchObject({ state: 'complete', frameIds: [frameId] });
    expect(done.note?.guardianReports).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });
  it('opens the review with a blank form when AI is off', async () => {
    await build().process.finish(id);
    const done = await store.getConsultation(id);
    expect(done.state).toBe('review');
    expect(done.note).toMatchObject({ fallbackUsed: true, summary: [] });
    expect(done.note?.warnings[0]).toContain('AI');
  });
  it('still writes a note when one scene fails', async () => {
    const stub = createStubLlm();
    await build(failing({ structured: request => request.images ? Promise.reject(new Error('vision died')) : stub.structured(request) })).process.finish(id);
    const done = await store.getConsultation(id);
    expect(done.scenes[0].state).toBe('failed');
    expect(done.note?.fallbackUsed).toBeUndefined();
  });
  it('opens the review with a recorded problem when organizing breaks, and frees the model anyway', async () => {
    const release = vi.fn(async () => {});
    await store.updateConsultation(id, current => ({ ...current, frames: [{ id: '00000000-0000-4000-8000-00000000000f', atMs: 0, source: 'camera', speaker: 'guardian', bytes: 1 }] }));
    const broken = failing({ release });
    Object.defineProperty(broken, 'supportsVision', { get() { throw new Error('broken provider'); } });
    await build(broken).process.finish(id);
    const done = await store.getConsultation(id);
    expect(done.state).toBe('review');
    expect(done.errors).toEqual([expect.objectContaining({ code: 'POST_PROCESS' })]);
    expect(release).toHaveBeenCalled();
  });
  it('leaves the consultation for recovery when the server shuts down mid-way', async () => {
    let answer!: () => void;
    const stub = createStubLlm();
    const slow = failing({ structured: request => new Promise((resolve, reject) => {
      request.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      answer = () => { void stub.structured(request).then(resolve); };
    }) });
    const { process, notify } = build(slow);
    const finished = process.finish(id);
    await vi.waitFor(() => expect(answer).toBeDefined());
    await process.close();
    await finished;
    expect((await store.getConsultation(id)).state).toBe('processing');
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('regenerate', () => {
  async function inReview(llm: LlmProvider) {
    const built = build(llm);
    await built.process.finish(id);
    return built;
  }
  const settled = () => vi.waitFor(async () => expect((await store.getConsultation(id)).noteGenerating).toBeUndefined());
  it('marks the work as running and replaces the draft when done', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const stub = createStubLlm();
    let waiting = false;
    const llm = failing({ structured: async request => { if (waiting) await gate; return stub.structured(request); } });
    const { process } = await inReview(llm);
    const before = (await store.getConsultation(id)).note!.createdAt;
    waiting = true;
    await process.regenerate(id);
    expect((await store.getConsultation(id)).noteGenerating).toBe(true);
    release();
    await settled();
    const done = await store.getConsultation(id);
    expect(done.note).toBeDefined();
    expect(done.state).toBe('review');
    expect(Date.parse(done.note!.createdAt)).toBeGreaterThanOrEqual(Date.parse(before));
  });
  it('keeps the earlier draft when the new one fails outright, and says so', async () => {
    const stub = createStubLlm();
    let broken = false;
    const llm = failing({ structured: request => broken ? Promise.reject(new Error('died')) : stub.structured(request) });
    const { process } = await inReview(llm);
    const before = (await store.getConsultation(id)).note;
    broken = true;
    await process.regenerate(id);
    await settled();
    const done = await store.getConsultation(id);
    expect(done.note).toEqual(before);
    expect(done.errors).toEqual([expect.objectContaining({ code: 'NOTE_REGENERATE' })]);
  });
});

describe('a write that fails once', () => {
  it('tries again before leaving the consultation stuck', async () => {
    const realUpdate = store.updateConsultation;
    let failures = 1;
    const flaky: CoachingStore = { ...store, updateConsultation: (consultationId, change) => {
      const probe = change;
      return realUpdate(consultationId, current => {
        const next = probe(current);
        if (next.state === 'review' && failures > 0) { failures -= 1; throw new Error('disk busy'); }
        return next;
      });
    } };
    const notify = vi.fn();
    await createPostProcess({ store: flaky, transcription: { settle: async () => {}, close: async () => {} }, notify, retryDelayMs: 1 }).finish(id);
    expect((await store.getConsultation(id)).state).toBe('review');
    expect(notify).toHaveBeenCalled();
  });
});
