// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from './app.ts';
import { readConfig } from './config.ts';
import { ConsultationStore } from './consultation-store.ts';
import { consultationSections } from '../src/domain/consultation.ts';
import type { BriefInput, BriefConsultationContext } from '../src/domain/workspace-types.ts';

const directories: string[] = [];
const origin = 'http://127.0.0.1:5173';
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function setup(change: 'other' | 'unapproved' | 'revision' | 'deleted' | 'none' = 'none') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'brief-consultation-')); directories.push(directory);
  const store = new ConsultationStore(directory);
  const created = await store.create({ petName: '초코', trainerName: '김훈련', sessionDate: '2026-09-25' });
  const text = '초인종이 울리면 기다리는 과제를 하기로 했다.';
  await store.update(created.id, session => {
    session.state = 'ready'; session.durationMs = 5000;
    session.segments = [{ id: 'segment', sequence: 0, startMs: 1000, endMs: 5000, text, originalText: text, state: 'complete' }];
    session.note = { items: [{ id: 'task', section: 'task', text, evidence: [{ kind: 'segment', id: 'segment', quote: text, startMs: 1000, endMs: 5000 }] }], coveredSegmentIds: ['segment'], missingSections: consultationSections.filter(section => section !== 'task'), createdAt: '2026-09-25T00:00:00Z', approvedAt: '2026-09-25T01:00:00Z' };
    session.noteRevision = 'r1';
    if (change === 'other') session.metadata.petName = '보리';
    if (change === 'unapproved') delete session.note.approvedAt;
    if (change === 'revision') session.noteRevision = 'r2';
  });
  if (change === 'deleted') await store.delete(created.id);
  const generateBrief = vi.fn(async (_input: BriefInput, _signal?: AbortSignal, context?: BriefConsultationContext) => ({ context }));
  const config = { ...readConfig({ AI_ENABLED: 'true', FEATURE_BRIEF_ENABLED: 'true' }), liveConsultationEnabled: true, consultationDirectory: directory };
  const app = createApp(config, { generate: async () => ({}), transcribe: async () => '', generateBrief });
  const input = { pet: { id: 'p', name: '초코', nicknames: [] }, records: [], now: '2026-09-30T00:00:00Z', timeZone: 'Asia/Seoul', consultation: { id: created.id, revision: 'r1' } };
  return { app, input, generateBrief, id: created.id, directory };
}
it('lists only compact approved choices and resolves stored quotes and timestamps', async () => {
  const { app, id, input, generateBrief } = await setup();
  const choices = await request(app).get('/api/consultations/brief-context').expect(200);
  expect(choices.body.consultations).toHaveLength(1);
  expect(JSON.stringify(choices.body)).not.toContain('originalText');
  const context = await request(app).get(`/api/consultations/${id}/brief-context?petName=${encodeURIComponent('초코')}&revision=r1`).expect(200);
  expect(context.body.items[0].evidence[0]).toMatchObject({ quote: '초인종이 울리면 기다리는 과제를 하기로 했다.', startMs: 1000, endMs: 5000 });
  await request(app).post('/api/briefs').set('Origin', origin).send({ input, consent: true }).expect(200);
  expect(generateBrief.mock.calls[0][2]!.id).toBe(id);
  expect(generateBrief.mock.calls[0][0].previousSession).toBeUndefined();
});
it('reserves task, purpose and follow-up sources in long consultation notes', async () => {
  const { app, directory, id } = await setup();
  await new ConsultationStore(directory).update(id, session => {
    const base = session.note!.items[0];
    session.note!.items = [...Array.from({ length: 20 }, (_, index) => ({ ...base, id: 'task-' + index })), { ...base, id: 'purpose', section: 'purpose' }, { ...base, id: 'follow', section: 'follow_up' }];
    session.note!.missingSections = consultationSections.filter(section => !['task', 'purpose', 'follow_up'].includes(section));
  });
  const response = await request(app).get(`/api/consultations/${id}/brief-context?petName=${encodeURIComponent('초코')}&revision=r1`).expect(200);
  expect(response.body.items).toHaveLength(12); expect(response.body.omittedItems).toBe(10);
  expect(response.body.items.map((item: { category: string }) => item.category)).toEqual(expect.arrayContaining(['task', 'purpose', 'follow_up']));
});
for (const action of ['delete', 'edit'] as const) it(`rejects consultation ${action} during generation`, async () => {
  const { app, input, id, generateBrief } = await setup();
  generateBrief.mockImplementation(async (_input, _signal, context) => {
    if (action === 'delete') await request(app).delete(`/api/consultations/${id}`).set('Origin', origin).expect(204);
    else await request(app).patch(`/api/consultations/${id}/segments/segment`).set('Origin', origin).send({ text: '수정된 상담 원문' }).expect(200);
    return { context };
  });
  const result = await request(app).post('/api/briefs').set('Origin', origin).send({ input, consent: true });
  expect(result.status).toBe(409); expect(result.body.code).toBe('BRIEF_CONSULTATION_INVALID');
});
for (const change of ['other', 'unapproved', 'revision', 'deleted'] as const) it(`rejects ${change} selected consultation before invoking AI`, async () => {
  const { app, input, generateBrief } = await setup(change);
  const response = await request(app).post('/api/briefs').set('Origin', origin).send({ input, consent: true });
  expect(response.status).toBe(409); expect(response.body.code).toBe('BRIEF_CONSULTATION_INVALID');
  expect(generateBrief).not.toHaveBeenCalled();
});
it('rejects client-provided approved consultation text and simultaneous legacy selection', async () => {
  const { app, input } = await setup();
  await request(app).post('/api/briefs').set('Origin', origin).send({ input: { ...input, approvedConsultation: { items: [] } }, consent: true }).expect(400);
  await request(app).post('/api/briefs').set('Origin', origin).send({ input: { ...input, previousSession: { date: '2026-09-25', items: [] } }, consent: true }).expect(400);
});
