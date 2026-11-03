// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { Consultation, FrameRef, Moment, Segment } from '../../src/domain/coaching.ts';
import { newConsultation } from '../../src/domain/coaching.ts';
import type { LlmRequest } from '../ai/llm/types.ts';
import { createSceneService, selectScenes } from './scene-service.ts';

const frame = (id: string, atMs: number, speaker: FrameRef['speaker'] = 'guardian', source: FrameRef['source'] = 'camera'): FrameRef => ({ id, atMs, speaker, source, bytes: 100 });
const moment = (id: string, atMs: number, frameIds: string[]): Moment => ({ id, atMs, createdBy: 'guardian', frameIds });
const spoken = (startMs: number, text: string): Segment => ({ id: `s${startMs}`, speaker: 'trainer', startMs, endMs: startMs + 1000, text, originalText: text, state: 'complete' });
const consultation = (change: Partial<Consultation>): Consultation => ({ ...newConsultation({ id: 'c1', caseId: 'k1', createdAt: 'now' }), ...change });

describe('selectScenes', () => {
  it('uses at most three photos around the press for a moment', () => {
    const frames = [0, 1, 2, 3, 4, 5, 6, 7].map(index => frame(`f${index}`, 5000 + index * 1000));
    const [scene] = selectScenes(consultation({ frames, moments: [moment('m', 10000, frames.map(item => item.id))] }));
    expect(scene.atMs).toBe(10000);
    expect(scene.frameIds).toEqual(['f3', 'f5', 'f6']);
  });
  it('analyzes each source of a moment on its own, and leaves out the trainer camera when there is something else to see', () => {
    const frames = [frame('g', 1000), frame('s', 1000, 'trainer', 'screen'), frame('t', 1000, 'trainer', 'camera')];
    const scenes = selectScenes(consultation({ frames, moments: [moment('m', 1000, ['g', 's', 't'])] }));
    expect(scenes.map(scene => scene.frameIds)).toEqual([['g'], ['s']]);
  });
  it('still uses the trainer camera when a moment has nothing else', () => {
    const scenes = selectScenes(consultation({ frames: [frame('t', 1000, 'trainer', 'camera')], moments: [moment('m', 1000, ['t'])] }));
    expect(scenes.map(scene => scene.frameIds)).toEqual([['t']]);
  });
  it('samples the guardian camera once a minute between moments', () => {
    const frames = [0, 30, 60, 90, 120].map(seconds => frame(`f${seconds}`, seconds * 1000));
    expect(selectScenes(consultation({ frames })).map(scene => scene.frameIds)).toEqual([['f0'], ['f60'], ['f120']]);
  });
  it('adds a photo near words that point at the picture', () => {
    const frames = [0, 30, 60].map(seconds => frame(`f${seconds}`, seconds * 1000));
    const scenes = selectScenes(consultation({ frames, segments: [spoken(28000, '지금 화면에서 귀가 앞으로 서 있네요')] }));
    expect(scenes.map(scene => scene.frameIds)).toEqual([['f0'], ['f30'], ['f60']]);
  });
  it('does not analyze a moment photo twice as a periodic one', () => {
    const scenes = selectScenes(consultation({ frames: [frame('a', 0), frame('b', 60000)], moments: [moment('m', 60000, ['b'])] }));
    expect(scenes.map(scene => scene.frameIds)).toEqual([['b'], ['a']]);
  });
  it('caps the work for a long call, keeping moments and spreading the rest over the whole call', () => {
    const frames = Array.from({ length: 120 }, (_, index) => frame(`f${index}`, index * 60000));
    const moments = [moment('m', 500, ['f0'])];
    const scenes = selectScenes(consultation({ frames, moments }));
    expect(scenes).toHaveLength(30);
    expect(scenes[0].frameIds).toEqual(['f0']);
    expect(scenes.at(-1)!.atMs).toBeGreaterThan(100 * 60000);
  });
  it('does not treat a transcript with no frames as a scene', () => {
    expect(selectScenes(consultation({ segments: [spoken(0, '지금 보세요')] }))).toEqual([]);
  });
});

describe('createSceneService', () => {
  const frames = [frame('a', 0), frame('b', 60000)];
  function build(answer: (request: LlmRequest) => Promise<{ json: unknown; finished: boolean }>, supportsVision = true) {
    const structured = vi.fn(answer);
    const readFrame = vi.fn(async (_consultation: string, frameId: string) => Buffer.from(frameId));
    const service = createSceneService({ llm: { name: 'fake', supportsVision, structured, release: async () => {} }, store: { readFrame } });
    return { service, structured, readFrame };
  }
  it('asks about real photos and keeps the first wording for comparison', async () => {
    const { service, structured } = build(async () => ({ finished: true, json: { observations: ['개가 매트 위에 앉아 있다'] } }));
    const scenes = await service.analyze(consultation({ frames }));
    expect(structured.mock.calls[0][0].images).toEqual([Buffer.from('a')]);
    expect(structured.mock.calls[0][0].system).toContain('directly visible');
    expect(scenes).toHaveLength(2);
    expect(scenes[0]).toMatchObject({ atMs: 0, frameIds: ['a'], state: 'complete', observations: [{ text: '개가 매트 위에 앉아 있다', originalText: '개가 매트 위에 앉아 있다', reviewed: false }] });
  });
  it('removes banned expressions from what the model saw', async () => {
    const { service } = build(async () => ({ finished: true, json: { observations: ['관절염으로 보인다', '개가 서 있다'] } }));
    const scenes = await service.analyze(consultation({ frames: [frames[0]] }));
    expect(scenes[0].observations.map(item => item.text)).toEqual(['개가 서 있다']);
  });
  it('marks a failed scene and continues with the next', async () => {
    let calls = 0;
    const { service } = build(async () => { calls += 1; if (calls === 1) throw new Error('model died'); return { finished: true, json: { observations: ['개가 서 있다'] } }; });
    const scenes = await service.analyze(consultation({ frames }));
    expect(scenes.map(scene => scene.state)).toEqual(['failed', 'complete']);
  });
  it('treats an unfinished or malformed answer as failed', async () => {
    const { service } = build(async () => ({ finished: false, json: { observations: ['개'] } }));
    expect((await service.analyze(consultation({ frames: [frames[0]] })))[0].state).toBe('failed');
    const malformed = build(async () => ({ finished: true, json: { observations: 'no' } }));
    expect((await malformed.service.analyze(consultation({ frames: [frames[0]] })))[0].state).toBe('failed');
  });
  it('does nothing when the model cannot read images', async () => {
    const { service, structured } = build(async () => ({ finished: true, json: { observations: [] } }), false);
    await expect(service.analyze(consultation({ frames }))).resolves.toEqual([]);
    expect(structured).not.toHaveBeenCalled();
  });
  it('stops at once when cancelled', async () => {
    const controller = new AbortController(); controller.abort();
    const { service, structured } = build(async () => ({ finished: true, json: { observations: [] } }));
    await expect(service.analyze(consultation({ frames }), controller.signal)).rejects.toThrow();
    expect(structured).not.toHaveBeenCalled();
  });
});

describe('a vision model that never answers', () => {
  it('marks the scene failed after the time limit and moves on', async () => {
    const structured = vi.fn((request: LlmRequest) => new Promise<{ json: unknown; finished: boolean }>((_resolve, reject) => { request.signal?.addEventListener('abort', () => reject(new Error('aborted'))); }));
    const service = createSceneService({ llm: { name: 'fake', supportsVision: true, structured, release: async () => {} }, store: { readFrame: async () => Buffer.from([1]) }, callTimeoutMs: 5 });
    const scenes = await service.analyze(consultation({ frames: [frame('a', 0), frame('b', 60000)] }));
    expect(scenes.map(scene => scene.state)).toEqual(['failed', 'failed']);
  });
});
