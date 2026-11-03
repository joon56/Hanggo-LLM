// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Consultation } from '../../src/domain/coaching.ts';
import { createApp } from '../app.ts';
import { readConfig } from '../config.ts';
import { encodeWav } from '../../src/call/speech-windows.ts';
import { createStubLlm } from '../ai/llm/stub.ts';
import type { LlmProvider } from '../ai/llm/types.ts';
import type { SpeechProvider } from '../ai/speech/types.ts';

const origin = 'http://127.0.0.1:5173';
const password = 'long-test-password-1234';
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function setup(env: NodeJS.ProcessEnv = {}, liveSpeech?: SpeechProvider, llm?: LlmProvider) {
  const home = mkdtempSync(path.join(tmpdir(), 'hanggo-router-')); homes.push(home);
  return createApp(readConfig({ HANGGO_HOME: home, APP_ACCESS_PASSWORD: password, COACHING_GRACE_MS: '1', ...env }), { generate: async () => ({}), transcribe: async () => '', liveSpeech, llm });
}
type App = ReturnType<typeof setup>;
const input = { petName: '초코', guardianName: '가상 보호자', trainerName: '가상 훈련사' };
async function trainer(app: App) {
  const agent = request.agent(app);
  await agent.post('/api/session').set('Origin', origin).send({ password }).expect(200);
  return agent;
}
async function createCase(agent: ReturnType<typeof request.agent>) {
  const response = await agent.post('/api/coaching/cases').set('Origin', origin).send(input).expect(201);
  return response.body as { case: { id: string }; inviteToken: string };
}
async function guardian(app: App, token: string) {
  const agent = request.agent(app);
  await agent.post('/api/coaching/join').set('Origin', origin).send({ token }).expect(200);
  return agent;
}
const start = async (agent: ReturnType<typeof request.agent>, caseId: string) => (await agent.post(`/api/coaching/cases/${caseId}/consultations`).set('Origin', origin).send({}).expect(201)).body as { id: string; state: string };

it('requires a trainer login to create cases', async () => {
  await request(setup()).post('/api/coaching/cases').set('Origin', origin).send(input).expect(401);
});
it('never returns invite secrets in case responses', async () => {
  const app = setup(); const agent = await trainer(app);
  const created = await createCase(agent);
  expect(created.inviteToken).toMatch(/^[0-9a-f]{64}$/);
  const read = await agent.get(`/api/coaching/cases/${created.case.id}`).expect(200);
  for (const body of [created.case, read.body, (await agent.get('/api/coaching/cases')).body]) {
    expect(JSON.stringify(body)).not.toMatch(/inviteHash|guardianGeneration/);
    expect(JSON.stringify(body)).not.toContain(created.inviteToken);
  }
});
it('turns an invite into a guardian session scoped to one case', async () => {
  const app = setup(); const agent = await trainer(app);
  const first = await createCase(agent); const second = await createCase(agent);
  const member = await guardian(app, first.inviteToken);
  await expect(member.get('/api/coaching/me').expect(200)).resolves.toMatchObject({ body: { role: 'guardian', caseId: first.case.id } });
  await member.get(`/api/coaching/cases/${first.case.id}`).expect(200);
  await member.get(`/api/coaching/cases/${second.case.id}`).expect(403);
  const list = await member.get('/api/coaching/cases').expect(200);
  expect(list.body.cases.map((item: { id: string }) => item.id)).toEqual([first.case.id]);
});
it('rejects a reused or unknown invite', async () => {
  const app = setup(); const agent = await trainer(app);
  const { inviteToken } = await createCase(agent);
  await guardian(app, inviteToken);
  await request(app).post('/api/coaching/join').set('Origin', origin).send({ token: inviteToken }).expect(403);
  await request(app).post('/api/coaching/join').set('Origin', origin).send({ token: 'f'.repeat(64) }).expect(403);
  await request(app).post('/api/coaching/join').set('Origin', origin).send({}).expect(400);
});
it('reissuing an invite ends the earlier guardian session', async () => {
  const app = setup(); const agent = await trainer(app);
  const { case: created, inviteToken } = await createCase(agent);
  const member = await guardian(app, inviteToken);
  const reissued = await agent.post(`/api/coaching/cases/${created.id}/invite`).set('Origin', origin).send({}).expect(200);
  await member.get(`/api/coaching/cases/${created.id}`).expect(401);
  await (await guardian(app, reissued.body.inviteToken)).get(`/api/coaching/cases/${created.id}`).expect(200);
});
it('keeps a guardian session valid across a restart using the same data folder', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'hanggo-router-')); homes.push(home);
  const build = () => createApp(readConfig({ HANGGO_HOME: home, APP_ACCESS_PASSWORD: password }), { generate: async () => ({}), transcribe: async () => '' });
  const first = build(); const agent = await trainer(first);
  const { case: created, inviteToken } = await createCase(agent);
  const joined = await request(first).post('/api/coaching/join').set('Origin', origin).send({ token: inviteToken }).expect(200);
  const cookie = joined.headers['set-cookie'] as unknown as string[];
  await request(build()).get(`/api/coaching/cases/${created.id}`).set('Cookie', cookie).expect(200);
});
it('rejects a forged guardian cookie', async () => {
  const app = setup(); const agent = await trainer(app);
  const { case: created } = await createCase(agent);
  await request(app).get(`/api/coaching/cases/${created.id}`).set('Cookie', `hanggo_guardian=${created.id}.0.9999999999999.forged`).expect(401);
});
it('lets only the trainer start, end, and reissue', async () => {
  const app = setup(); const agent = await trainer(app);
  const { case: created, inviteToken } = await createCase(agent);
  const member = await guardian(app, inviteToken);
  await member.post(`/api/coaching/cases/${created.id}/consultations`).set('Origin', origin).send({}).expect(403);
  await member.post(`/api/coaching/cases/${created.id}/invite`).set('Origin', origin).send({}).expect(403);
  const consultation = await start(agent, created.id);
  expect(consultation.state).toBe('live');
  await member.post(`/api/coaching/consultations/${consultation.id}/end`).set('Origin', origin).send({}).expect(403);
  const ended = await agent.post(`/api/coaching/consultations/${consultation.id}/end`).set('Origin', origin).send({}).expect(200);
  expect(ended.body.state).toBe('processing');
  await expect.poll(async () => (await agent.get(`/api/coaching/consultations/${consultation.id}`)).body.state).toBe('review');
});
it('allows only one live consultation at a time', async () => {
  const app = setup(); const agent = await trainer(app);
  const first = await createCase(agent); const second = await createCase(agent);
  await start(agent, first.case.id);
  const conflict = await agent.post(`/api/coaching/cases/${second.case.id}/consultations`).set('Origin', origin).send({}).expect(409);
  expect(conflict.body.code).toBe('ACTIVE_CONSULTATION');
});
it('starts recording only after both participants consent, and either can withdraw', async () => {
  const app = setup(); const agent = await trainer(app);
  const { case: created, inviteToken } = await createCase(agent);
  const member = await guardian(app, inviteToken);
  const { id } = await start(agent, created.id);
  const consent = (who: typeof agent, value: boolean) => who.post(`/api/coaching/consultations/${id}/consent`).set('Origin', origin).send({ value }).expect(200);
  expect((await consent(agent, true)).body).toMatchObject({ recording: false, consent: { trainer: true, guardian: false } });
  expect((await consent(member, true)).body).toMatchObject({ recording: true });
  expect((await consent(member, false)).body).toMatchObject({ recording: false, state: 'live' });
});
it('rejects consent from another case guardian', async () => {
  const app = setup(); const agent = await trainer(app);
  const first = await createCase(agent); const second = await createCase(agent);
  const outsider = await guardian(app, second.inviteToken);
  const { id } = await start(agent, first.case.id);
  await outsider.post(`/api/coaching/consultations/${id}/consent`).set('Origin', origin).send({ value: true }).expect(403);
  await outsider.get(`/api/coaching/consultations/${id}`).expect(403);
  await outsider.get(`/api/coaching/consultations/${id}/ice`).expect(403);
});
it('serves ICE servers to participants only and reports when no relay exists', async () => {
  const app = setup(); const agent = await trainer(app);
  const { case: created, inviteToken } = await createCase(agent);
  const { id } = await start(agent, created.id);
  await request(app).get(`/api/coaching/consultations/${id}/ice`).expect(401);
  const ice = await (await guardian(app, inviteToken)).get(`/api/coaching/consultations/${id}/ice`).expect(200);
  expect(ice.body).toEqual({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }], relayAvailable: false });
});
it('includes TURN credentials when configured', async () => {
  const app = setup({ TURN_URLS: 'turn:relay.example:3478, turn:relay.example:3478?transport=tcp', TURN_USERNAME: 'test-user', TURN_CREDENTIAL: 'test-pass' });
  const agent = await trainer(app);
  const { case: created } = await createCase(agent);
  const { id } = await start(agent, created.id);
  const ice = await agent.get(`/api/coaching/consultations/${id}/ice`).expect(200);
  expect(ice.body.relayAvailable).toBe(true);
  expect(ice.body.iceServers[1]).toEqual({ urls: ['turn:relay.example:3478', 'turn:relay.example:3478?transport=tcp'], username: 'test-user', credential: 'test-pass' });
});
it('ignores partial TURN settings', async () => {
  const app = setup({ TURN_URLS: 'turn:relay.example:3478', TURN_USERNAME: '', TURN_CREDENTIAL: '' });
  const agent = await trainer(app);
  const { case: created } = await createCase(agent);
  const { id } = await start(agent, created.id);
  expect((await agent.get(`/api/coaching/consultations/${id}/ice`).expect(200)).body.relayAvailable).toBe(false);
});
it('rejects cross-origin writes before any coaching logic runs', async () => {
  await request(setup()).post('/api/coaching/join').set('Origin', 'https://evil.example').send({ token: 'x' }).expect(403);
});
it('rate limits invite attempts', async () => {
  const app = setup();
  for (let index = 0; index < 10; index++) await request(app).post('/api/coaching/join').set('Origin', origin).send({ token: 'f'.repeat(64) }).expect(403);
  await request(app).post('/api/coaching/join').set('Origin', origin).send({ token: 'f'.repeat(64) }).expect(429);
});
it('does not open other AI routes to a guardian session', async () => {
  const app = setup(); const agent = await trainer(app);
  const { inviteToken } = await createCase(agent);
  const member = await guardian(app, inviteToken);
  await member.post('/api/notes').set('Origin', origin).send({ text: '메모', sourceKind: 'trainer_summary_text', consent: true }).expect(401);
});
it('reports the signed-in role', async () => {
  const app = setup();
  await request(app).get('/api/coaching/me').expect(401);
  const agent = await trainer(app);
  await expect(agent.get('/api/coaching/me').expect(200)).resolves.toMatchObject({ body: { role: 'trainer' } });
});
it('validates case input', async () => {
  const agent = await trainer(setup());
  await agent.post('/api/coaching/cases').set('Origin', origin).send({ ...input, petName: '' }).expect(400);
  await agent.post('/api/coaching/cases').set('Origin', origin).send({ ...input, extra: true }).expect(400);
});

describe('recording', () => {
  const fakeSpeech = (): SpeechProvider & { release: ReturnType<typeof vi.fn> } => ({ prepare: async () => {}, release: vi.fn(async () => {}), transcribe: async () => ({ text: '테스트 전사', model: 'fake', latencyMs: 1 }) });
  const speaking = (ms: number) => Buffer.from(encodeWav(Float32Array.from({ length: ms * 16 }, (_, index) => 0.1 * Math.sin(index / 10))));
  const silent = (ms: number) => Buffer.from(encodeWav(new Float32Array(ms * 16)));
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const frameId = (index = 1) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
  type Agent = ReturnType<typeof request.agent>;
  const putAudio = (agent: Agent, id: string, startMs: number, endMs: number, body: Buffer) => agent.put(`/api/coaching/consultations/${id}/audio/${startMs}?endMs=${endMs}`).set('Origin', origin).set('Content-Type', 'audio/wav').send(body);
  const putFrame = (agent: Agent, id: string, frame: string, query: string, body: Buffer = jpeg) => agent.put(`/api/coaching/consultations/${id}/frames/${frame}?${query}`).set('Origin', origin).set('Content-Type', 'image/jpeg').send(body);
  const consent = (agent: Agent, id: string, value = true) => agent.post(`/api/coaching/consultations/${id}/consent`).set('Origin', origin).send({ value }).expect(200);
  const read = async (agent: Agent, id: string) => (await agent.get(`/api/coaching/consultations/${id}`).expect(200)).body as Consultation;
  async function live(env: NodeJS.ProcessEnv = {}) {
    const speech = fakeSpeech();
    const app = setup({ AI_ENABLED: 'true', ...env }, speech);
    const owner = await trainer(app);
    const created = await createCase(owner);
    const member = await guardian(app, created.inviteToken);
    const { id } = await start(owner, created.case.id);
    return { app, owner, member, id, speech, caseId: created.case.id };
  }
  async function recording(env: NodeJS.ProcessEnv = {}) {
    const context = await live(env);
    await consent(context.owner, context.id); await consent(context.member, context.id);
    return context;
  }
  const settled = (agent: Agent, id: string, count: number) => expect.poll(async () => (await read(agent, id)).segments.filter(item => item.state === 'complete').length).toBe(count);

  it('accepts nothing until both sides consent, and nothing after a withdrawal', async () => {
    const { owner, member, id } = await live();
    await putAudio(member, id, 0, 1000, speaking(1000)).expect(409);
    await putFrame(member, id, frameId(), 'atMs=0&source=camera').expect(409);
    await consent(owner, id);
    await putAudio(member, id, 0, 1000, speaking(1000)).expect(409);
    await consent(member, id);
    await putAudio(member, id, 0, 1000, speaking(1000)).expect(202);
    await consent(member, id, false);
    await putAudio(member, id, 2000, 3000, speaking(1000)).expect(409);
    await putFrame(owner, id, frameId(), 'atMs=0&source=camera').expect(409);
  });
  it('takes the speaker from the session, so a browser cannot claim to be the other person', async () => {
    const { owner, member, id } = await recording();
    await putAudio(member, id, 0, 1000, speaking(1000)).expect(202);
    await putAudio(owner, id, 0, 1000, speaking(1000)).expect(202);
    await settled(owner, id, 2);
    expect((await read(owner, id)).segments.map(item => item.speaker).sort()).toEqual(['guardian', 'trainer']);
  });
  it('blocks a guardian of another case', async () => {
    const { app, owner, id } = await recording();
    const other = await createCase(owner);
    const stranger = await guardian(app, other.inviteToken);
    await putAudio(stranger, id, 0, 1000, speaking(1000)).expect(403);
    await putFrame(stranger, id, frameId(), 'atMs=0&source=camera').expect(403);
    await stranger.post(`/api/coaching/consultations/${id}/moments`).set('Origin', origin).send({}).expect(403);
    await request(app).put(`/api/coaching/consultations/${id}/audio/0?endMs=1000`).set('Origin', origin).set('Content-Type', 'audio/wav').send(speaking(1000)).expect(401);
  });
  it('drops silence without creating a segment', async () => {
    const { owner, member, id } = await recording();
    await putAudio(member, id, 0, 1000, silent(1000)).expect(200);
    expect((await read(owner, id)).segments).toEqual([]);
  });
  it('rejects bad audio and impossible times', async () => {
    const { member, id } = await recording();
    await putAudio(member, id, 0, 1000, Buffer.from('not audio')).expect(400);
    await putAudio(member, id, 0, 2000, speaking(1000)).expect(400);
    await member.put(`/api/coaching/consultations/${id}/audio/abc?endMs=1000`).set('Origin', origin).set('Content-Type', 'audio/wav').send(speaking(1000)).expect(400);
    await putAudio(member, id, 600000, 601000, speaking(1000)).expect(400);
    await putAudio(member, id, 0, 1000, speaking(1000).subarray(0, 100)).expect(400);
  });
  it('reports the times of accepted audio', async () => {
    const { owner, member, id } = await recording();
    await putAudio(member, id, 500, 1500, speaking(1000)).expect(202);
    await settled(owner, id, 1);
    expect((await read(owner, id)).segments[0]).toMatchObject({ speaker: 'guardian', startMs: 500, endMs: 1500, text: '테스트 전사', model: 'fake' });
  });
  it('accepts the last window just after the end, then closes the door', async () => {
    const { owner, member, id, speech } = await recording({ COACHING_GRACE_MS: '300' });
    const ended = await owner.post(`/api/coaching/consultations/${id}/end`).set('Origin', origin).send({}).expect(200);
    expect(ended.body.state).toBe('processing');
    await putAudio(member, id, 0, 1000, speaking(1000)).expect(202);
    await expect.poll(async () => (await read(owner, id)).state).toBe('review');
    expect(speech.release).toHaveBeenCalled();
    expect((await read(owner, id)).segments[0]).toMatchObject({ state: 'complete' });
    await putAudio(member, id, 2000, 3000, speaking(1000)).expect(409);
  });
  it('ends without waiting when consent was never given, and still reaches review', async () => {
    const { owner, member, id } = await live();
    await owner.post(`/api/coaching/consultations/${id}/end`).set('Origin', origin).send({}).expect(200);
    await putAudio(member, id, 0, 1000, speaking(1000)).expect(409);
    await expect.poll(async () => (await read(owner, id)).state).toBe('review');
  });
  it('stores a guardian camera frame on its own, but other sources only for a moment', async () => {
    const { owner, member, id } = await recording();
    await putFrame(member, id, frameId(1), 'atMs=0&source=camera').expect(201);
    await putFrame(member, id, frameId(2), 'atMs=0&source=screen').expect(400);
    await putFrame(owner, id, frameId(3), 'atMs=0&source=camera').expect(400);
    await putFrame(owner, id, frameId(4), 'atMs=0&source=screen').expect(400);
    expect((await read(owner, id)).frames).toEqual([expect.objectContaining({ id: frameId(1), speaker: 'guardian', source: 'camera', bytes: jpeg.length })]);
    const moment = (await owner.post(`/api/coaching/consultations/${id}/moments`).set('Origin', origin).send({}).expect(201)).body;
    await putFrame(owner, id, frameId(5), `atMs=0&source=screen&moment=${moment.id}`).expect(201);
    await putFrame(member, id, frameId(6), `atMs=0&source=screen&moment=${moment.id}`).expect(201);
    const after = await read(owner, id);
    expect(after.moments[0].frameIds).toEqual([frameId(5), frameId(6)]);
  });
  it('rejects a non-JPEG, an oversized frame, a bad id, and an unknown moment', async () => {
    const { member, id } = await recording();
    await putFrame(member, id, frameId(), 'atMs=0&source=camera', Buffer.from('not image')).expect(400);
    await putFrame(member, id, frameId(), 'atMs=0&source=camera', Buffer.concat([jpeg, Buffer.alloc(257 * 1024)])).expect(413);
    await putFrame(member, id, 'not-a-frame', 'atMs=0&source=camera').expect(400);
    await putFrame(member, id, frameId(), 'atMs=-1&source=camera').expect(400);
    await putFrame(member, id, frameId(), 'atMs=0&source=window').expect(400);
    await putFrame(member, id, frameId(), `atMs=0&source=camera&moment=${frameId(9)}`).expect(404);
  });
  it('treats a repeated frame as one, and joins it to a second moment', async () => {
    const { owner, member, id } = await recording();
    const first = (await member.post(`/api/coaching/consultations/${id}/moments`).set('Origin', origin).send({}).expect(201)).body;
    await new Promise(resolve => setTimeout(resolve, 1100));
    const second = (await member.post(`/api/coaching/consultations/${id}/moments`).set('Origin', origin).send({}).expect(201)).body;
    await putFrame(member, id, frameId(), `atMs=0&source=camera&moment=${first.id}`).expect(201);
    await putFrame(member, id, frameId(), `atMs=0&source=camera&moment=${second.id}`).expect(201);
    const after = await read(owner, id);
    expect(after.frames).toHaveLength(1);
    expect(after.moments.map(item => item.frameIds)).toEqual([[frameId()], [frameId()]]);
  });
  it('does not let one participant overwrite a frame the other uploaded', async () => {
    const { owner, member, id } = await recording();
    const moment = (await owner.post(`/api/coaching/consultations/${id}/moments`).set('Origin', origin).send({}).expect(201)).body;
    await putFrame(owner, id, frameId(), `atMs=0&source=camera&moment=${moment.id}`).expect(201);
    await putFrame(member, id, frameId(), `atMs=0&source=camera&moment=${moment.id}`, Buffer.from([0xff, 0xd8, 0xff, 9])).expect(409);
    const stored = await owner.get(`/api/coaching/consultations/${id}/frames/${frameId()}`).expect(200);
    expect([...stored.body]).toEqual([...jpeg]);
  });
  it('shows frames and trainer memos to the trainer only', async () => {
    const { owner, member, id, caseId } = await recording();
    await putFrame(member, id, frameId(), 'atMs=0&source=camera').expect(201);
    const moment = (await member.post(`/api/coaching/consultations/${id}/moments`).set('Origin', origin).send({}).expect(201)).body;
    await owner.patch(`/api/coaching/consultations/${id}/moments/${moment.id}`).set('Origin', origin).send({ text: '반응 전 귀가 움직임' }).expect(200);
    const image = await owner.get(`/api/coaching/consultations/${id}/frames/${frameId()}`).expect(200);
    expect(image.headers['content-type']).toContain('image/jpeg');
    await member.get(`/api/coaching/consultations/${id}/frames/${frameId()}`).expect(403);
    const trainerView = await read(owner, id);
    expect(trainerView.moments[0].text).toBe('반응 전 귀가 움직임');
    expect(trainerView.frames).toHaveLength(1);
    const guardianViews = [await read(member, id), ((await member.get(`/api/coaching/cases/${caseId}`).expect(200)).body as { consultations: Consultation[] }).consultations[0]];
    for (const view of guardianViews) expect(view).toMatchObject({ frames: [], moments: [] });
    await member.patch(`/api/coaching/consultations/${id}/moments/${moment.id}`).set('Origin', origin).send({ text: '바꾸기' }).expect(403);
  });
  it('timestamps a moment on the server, and merges a double press', async () => {
    const { owner, member, id } = await recording();
    const first = (await member.post(`/api/coaching/consultations/${id}/moments`).set('Origin', origin).send({}).expect(201)).body;
    expect(first).toMatchObject({ createdBy: 'guardian', frameIds: [] });
    expect(first.atMs).toBeGreaterThanOrEqual(0);
    const again = (await member.post(`/api/coaching/consultations/${id}/moments`).set('Origin', origin).send({}).expect(201)).body;
    expect(again.id).toBe(first.id);
    const theirs = (await owner.post(`/api/coaching/consultations/${id}/moments`).set('Origin', origin).send({}).expect(201)).body;
    expect(theirs.id).not.toBe(first.id);
    expect((await read(owner, id)).moments).toHaveLength(2);
  });
  it('refuses a moment outside recording and an unusable memo', async () => {
    const { owner, id } = await live();
    await owner.post(`/api/coaching/consultations/${id}/moments`).set('Origin', origin).send({}).expect(409);
    await owner.patch(`/api/coaching/consultations/${id}/moments/${frameId()}`).set('Origin', origin).send({ text: '메모' }).expect(404);
    await owner.patch(`/api/coaching/consultations/${id}/moments/${frameId()}`).set('Origin', origin).send({ text: 'x'.repeat(501) }).expect(400);
  });
  it('does not start a speech model when AI is turned off', async () => {
    const speech = fakeSpeech();
    const prepare = vi.spyOn(speech, 'prepare');
    const app = setup({ AI_ENABLED: 'false' }, speech);
    const owner = await trainer(app); const created = await createCase(owner); const member = await guardian(app, created.inviteToken);
    const { id } = await start(owner, created.case.id);
    await consent(owner, id); await consent(member, id);
    await putAudio(member, id, 0, 1000, speaking(1000)).expect(503);
    expect(prepare).not.toHaveBeenCalled();
  });
});

describe('review and delivery', () => {
  const talk = (ms: number) => Buffer.from(encodeWav(Float32Array.from({ length: ms * 16 }, (_, index) => 0.1 * Math.sin(index / 10))));
  type Agent = ReturnType<typeof request.agent>;
  const words: Record<string, string> = { guardian: '초인종이 울리면 현관으로 뛰어가 짖어요', trainer: '하루 두 번 매트로 가는 연습을 해 주세요' };
  async function reviewed(env: NodeJS.ProcessEnv = {}) {
    let turn = 0;
    const speech: SpeechProvider = { prepare: async () => {}, release: async () => {}, transcribe: async () => ({ text: Object.values(words)[turn++ % 2], model: 'fake', latencyMs: 1 }) };
    const app = setup({ AI_ENABLED: 'true', AI_PROVIDER: 'stub', ...env }, speech, createStubLlm());
    const owner = await trainer(app);
    const created = await createCase(owner);
    const member = await guardian(app, created.inviteToken);
    const { id } = await start(owner, created.case.id);
    for (const agent of [owner, member]) await agent.post(`/api/coaching/consultations/${id}/consent`).set('Origin', origin).send({ value: true }).expect(200);
    await member.put(`/api/coaching/consultations/${id}/audio/0?endMs=1000`).set('Origin', origin).set('Content-Type', 'audio/wav').send(talk(1000)).expect(202);
    await owner.put(`/api/coaching/consultations/${id}/audio/0?endMs=1000`).set('Origin', origin).set('Content-Type', 'audio/wav').send(talk(1000)).expect(202);
    const frame = '00000000-0000-4000-8000-000000000001';
    await member.put(`/api/coaching/consultations/${id}/frames/${frame}?atMs=0&source=camera`).set('Origin', origin).set('Content-Type', 'image/jpeg').send(Buffer.from([0xff, 0xd8, 0xff, 1])).expect(201);
    await expect.poll(async () => (await owner.get(`/api/coaching/consultations/${id}`)).body.segments.filter((item: { state: string }) => item.state === 'complete').length).toBe(2);
    await owner.post(`/api/coaching/consultations/${id}/end`).set('Origin', origin).send({}).expect(200);
    await expect.poll(async () => (await owner.get(`/api/coaching/consultations/${id}`)).body.state).toBe('review');
    const read = async (agent: Agent = owner) => (await agent.get(`/api/coaching/consultations/${id}`).expect(200)).body as Consultation;
    return { app, owner, member, id, frame, read, caseId: created.case.id };
  }
  const url = (id: string, path: string) => `/api/coaching/consultations/${id}${path}`;
  it('builds a draft after the call and hides it from the guardian', async () => {
    const { owner, member, id, read, caseId } = await reviewed();
    const consultation = await read();
    expect(consultation.note?.guardianReports[0].evidence[0].speaker).toBe('guardian');
    expect(consultation.scenes).toHaveLength(1);
    for (const body of [await read(member), ((await member.get(`/api/coaching/cases/${caseId}`).expect(200)).body as { consultations: Consultation[] }).consultations[0]]) {
      expect(body).not.toHaveProperty('note');
      expect(body).toMatchObject({ segments: [], scenes: [], frames: [], moments: [] });
    }
    await member.get(url(id, '/delivery')).expect(404);
    await owner.get(url(id, '/delivery')).expect(404);
  });
  it('lets only the trainer change anything in the review', async () => {
    const { member, id, read } = await reviewed();
    const consultation = await read();
    const segment = consultation.segments[0].id; const scene = consultation.scenes[0];
    await member.patch(url(id, `/segments/${segment}`)).set('Origin', origin).send({ text: '바꾸기' }).expect(403);
    await member.patch(url(id, `/scenes/${scene.id}/observations/${scene.observations[0].id}`)).set('Origin', origin).send({ reviewed: true }).expect(403);
    await member.put(url(id, '/note')).set('Origin', origin).send(consultation.note).expect(403);
    await member.post(url(id, '/note')).set('Origin', origin).send({}).expect(403);
    await member.post(url(id, '/approve')).set('Origin', origin).send({}).expect(403);
  });
  it('keeps the original when the trainer corrects the transcript, and updates quotes in the note', async () => {
    const { owner, id, read } = await reviewed();
    const before = await read();
    const segment = before.segments.find(item => item.speaker === 'guardian')!;
    const updated = (await owner.patch(url(id, `/segments/${segment.id}`)).set('Origin', origin).send({ text: '초인종 소리에 현관으로 뛰어가 짖어요' }).expect(200)).body as Consultation;
    const changed = updated.segments.find(item => item.id === segment.id)!;
    expect(changed).toMatchObject({ text: '초인종 소리에 현관으로 뛰어가 짖어요', originalText: segment.originalText });
    expect(updated.note?.guardianReports[0].evidence[0].quote).toBe('초인종 소리에 현관으로 뛰어가 짖어요');
    expect(updated.note?.guardianReports[0].edited).toBeUndefined();
    await owner.patch(url(id, '/segments/missing')).set('Origin', origin).send({ text: '바꾸기' }).expect(404);
    await owner.patch(url(id, `/segments/${segment.id}`)).set('Origin', origin).send({ text: '' }).expect(400);
  });
  it('rebuilds forged evidence and refuses evidence that does not exist', async () => {
    const { owner, id, read } = await reviewed();
    const { note } = await read();
    const forged = structuredClone(note!);
    forged.guardianReports[0].evidence[0].quote = '꾸며낸 인용';
    const saved = (await owner.put(url(id, '/note')).set('Origin', origin).send(forged).expect(200)).body as Consultation;
    expect(saved.note?.guardianReports[0].evidence[0].quote).toBe(words.guardian);
    const missing = structuredClone(note!);
    missing.guardianReports[0].evidence[0].id = 'missing';
    await owner.put(url(id, '/note')).set('Origin', origin).send(missing).expect(400);
    await owner.put(url(id, '/note')).set('Origin', origin).send({ version: 1 }).expect(400);
  });
  it('blocks approval on a banned expression and delivers after it is fixed', async () => {
    const { owner, member, id, read, frame } = await reviewed();
    const { note, scenes } = await read();
    const blocked = structuredClone(note!);
    blocked.guidance[0].text = '이 연습으로 반드시 좋아집니다';
    await owner.put(url(id, '/note')).set('Origin', origin).send(blocked).expect(200);
    const refused = await owner.post(url(id, '/approve')).set('Origin', origin).send({}).expect(409);
    expect(refused.body.code).toBe('NOTE_BLOCKED');
    expect((await read()).state).toBe('review');
    await member.get(url(id, `/frames/${frame}`)).expect(403);
    await owner.put(url(id, '/note')).set('Origin', origin).send(note).expect(200);
    await owner.patch(url(id, `/scenes/${scenes[0].id}/observations/${scenes[0].observations[0].id}`)).set('Origin', origin).send({ reviewed: true }).expect(200);
    const approved = (await owner.post(url(id, '/approve')).set('Origin', origin).send({}).expect(200)).body as Consultation;
    expect(approved.state).toBe('approved');
    expect(approved.note?.approvedAt).toBeTruthy();
    const delivery = (await member.get(url(id, '/delivery')).expect(200)).body;
    expect(delivery.note.tasks).toHaveLength(1);
    expect(delivery.note).not.toHaveProperty('methodReview');
    expect(delivery.scenes[0].frameIds).toEqual([frame]);
    await member.get(url(id, `/frames/${frame}`)).expect(200);
  });
  it('keeps uncited photos from the guardian even after approval', async () => {
    const { owner, member, id, frame } = await reviewed();
    await owner.post(url(id, '/approve')).set('Origin', origin).send({}).expect(200);
    expect((await member.get(url(id, '/delivery')).expect(200)).body.scenes).toEqual([]);
    await member.get(url(id, `/frames/${frame}`)).expect(403);
    await owner.get(url(id, `/frames/${frame}`)).expect(200);
  });
  it('freezes everything once approved', async () => {
    const { owner, id, read } = await reviewed();
    const { note, segments } = await read();
    await owner.post(url(id, '/approve')).set('Origin', origin).send({}).expect(200);
    await owner.put(url(id, '/note')).set('Origin', origin).send(note).expect(409);
    await owner.patch(url(id, `/segments/${segments[0].id}`)).set('Origin', origin).send({ text: '바꾸기' }).expect(409);
    await owner.post(url(id, '/note')).set('Origin', origin).send({}).expect(409);
    await owner.post(url(id, '/approve')).set('Origin', origin).send({}).expect(409);
  });
  it('regenerates in the background and refuses edits meanwhile', async () => {
    const { owner, id, read } = await reviewed();
    const { note } = await read();
    const started = await owner.post(url(id, '/note')).set('Origin', origin).send({}).expect(202);
    expect(started.body.noteGenerating).toBe(true);
    await expect.poll(async () => (await read()).noteGenerating).toBeUndefined();
    expect((await read()).note?.guidance).toHaveLength(note!.guidance.length);
  });
  it('blocks a second call until the first is organized, then allows it', async () => {
    const { owner, caseId } = await reviewed();
    await owner.post(`/api/coaching/cases/${caseId}/consultations`).set('Origin', origin).send({}).expect(201);
  });
});

describe('task records, guardian logs, and the brief', () => {
  const speakingWav = (ms: number) => Buffer.from(encodeWav(Float32Array.from({ length: ms * 16 }, (_, index) => 0.1 * Math.sin(index / 10))));
  async function delivered() {
    let turn = 0;
    const lines = ['초인종이 울리면 현관으로 뛰어가 짖어요', '하루 두 번 매트로 가는 연습을 해 주세요'];
    const speech: SpeechProvider = { prepare: async () => {}, release: async () => {}, transcribe: async () => ({ text: lines[turn++ % 2], model: 'fake', latencyMs: 1 }) };
    const app = setup({ AI_ENABLED: 'true', AI_PROVIDER: 'stub' }, speech, createStubLlm());
    const owner = await trainer(app);
    const created = await createCase(owner);
    const member = await guardian(app, created.inviteToken);
    const caseId = created.case.id;
    const { id } = await start(owner, caseId);
    for (const agent of [owner, member]) await agent.post(`/api/coaching/consultations/${id}/consent`).set('Origin', origin).send({ value: true }).expect(200);
    await member.put(`/api/coaching/consultations/${id}/audio/0?endMs=1000`).set('Origin', origin).set('Content-Type', 'audio/wav').send(speakingWav(1000)).expect(202);
    await owner.put(`/api/coaching/consultations/${id}/audio/0?endMs=1000`).set('Origin', origin).set('Content-Type', 'audio/wav').send(speakingWav(1000)).expect(202);
    await expect.poll(async () => (await owner.get(`/api/coaching/consultations/${id}`)).body.segments.filter((item: { state: string }) => item.state === 'complete').length).toBe(2);
    await owner.post(`/api/coaching/consultations/${id}/end`).set('Origin', origin).send({}).expect(200);
    await expect.poll(async () => (await owner.get(`/api/coaching/consultations/${id}`)).body.state).toBe('review');
    return { app, owner, member, id, caseId };
  }
  async function approved() {
    const context = await delivered();
    const body = (await context.owner.post(`/api/coaching/consultations/${context.id}/approve`).set('Origin', origin).send({}).expect(200)).body as Consultation;
    return { ...context, taskId: body.note!.tasks[0].id };
  }
  const logUrl = (caseId: string) => `/api/coaching/cases/${caseId}/task-logs`;
  it('takes a task record only from the guardian, for a task in a confirmed note', async () => {
    const { owner, member, id, caseId } = await delivered();
    const draftTask = ((await owner.get(`/api/coaching/consultations/${id}`)).body as Consultation).note!.tasks[0].id;
    await member.post(logUrl(caseId)).set('Origin', origin).send({ consultationId: id, taskId: draftTask, status: 'done' }).expect(404);
    await owner.post(`/api/coaching/consultations/${id}/approve`).set('Origin', origin).send({}).expect(200);
    await owner.post(logUrl(caseId)).set('Origin', origin).send({ consultationId: id, taskId: draftTask, status: 'done' }).expect(403);
    const created = await member.post(logUrl(caseId)).set('Origin', origin).send({ consultationId: id, taskId: draftTask, status: 'partial', text: ' 소리를 줄이니 갔어요 ' }).expect(201);
    expect(created.body).toMatchObject({ caseId, consultationId: id, taskId: draftTask, status: 'partial', text: '소리를 줄이니 갔어요' });
    await member.post(logUrl(caseId)).set('Origin', origin).send({ consultationId: id, taskId: 'missing', status: 'done' }).expect(404);
    await member.post(logUrl(caseId)).set('Origin', origin).send({ consultationId: id, taskId: draftTask, status: 'great' }).expect(400);
    for (const agent of [owner, member]) expect((await agent.get(logUrl(caseId)).expect(200)).body.logs).toHaveLength(1);
  });
  it('keeps a guardian out of another case', async () => {
    const { app, owner, id, caseId, taskId } = await approved();
    const other = await createCase(owner);
    const stranger = await guardian(app, other.inviteToken);
    await stranger.post(logUrl(caseId)).set('Origin', origin).send({ consultationId: id, taskId, status: 'done' }).expect(403);
    await stranger.get(logUrl(caseId)).expect(403);
    await stranger.post(logUrl(other.case.id)).set('Origin', origin).send({ consultationId: id, taskId, status: 'done' }).expect(404);
    await stranger.get(`/api/coaching/cases/${caseId}/guardian-logs`).expect(403);
  });
  it('turns a guardian log into a draft to confirm, then saves it', async () => {
    const { owner, member, caseId } = await approved();
    const url = `/api/coaching/cases/${caseId}/guardian-logs`;
    await owner.post(`${url}/draft`).set('Origin', origin).send({ text: '산책했어요', sourceKind: 'nl_log_text' }).expect(403);
    const draft = (await member.post(`${url}/draft`).set('Origin', origin).send({ text: '오늘 초인종에 두 번 짖었어요', sourceKind: 'nl_log_text' }).expect(200)).body;
    expect(draft.pets).toEqual([{ id: caseId, name: '초코', nicknames: [] }]);
    expect(draft.events[0]).toMatchObject({ petId: caseId, sourceQuote: '오늘 초인종에 두 번 짖었어요' });
    expect((await member.get(url).expect(200)).body.logs).toEqual([]);
    const saved = await member.post(url).set('Origin', origin).send({ draft }).expect(201);
    expect(saved.body.draft.sourceText).toBe('오늘 초인종에 두 번 짖었어요');
    expect((await owner.get(url).expect(200)).body.logs).toHaveLength(1);
    await owner.post(url).set('Origin', origin).send({ draft }).expect(403);
    await member.post(url).set('Origin', origin).send({ draft: { ...draft, sourceText: '' } }).expect(400);
    await member.post(url).set('Origin', origin).send({ draft: { ...draft, pets: [{ id: 'other', name: '다른 개', nicknames: [] }], events: draft.events.map((event: object) => ({ ...event, petId: 'other' })) } }).expect(400);
    await member.post(`${url}/draft`).set('Origin', origin).send({ text: '' }).expect(400);
  });
  it('dictates for the guardian without keeping audio', async () => {
    const { owner, member, caseId } = await approved();
    const url = `/api/coaching/cases/${caseId}/voice`;
    const spoken = await member.put(url).set('Origin', origin).set('Content-Type', 'audio/wav').send(speakingWav(1000)).expect(200);
    expect(spoken.body.text).toBeTruthy();
    const quiet = await member.put(url).set('Origin', origin).set('Content-Type', 'audio/wav').send(Buffer.from(encodeWav(new Float32Array(16000)))).expect(200);
    expect(quiet.body.text).toBe('');
    await member.put(url).set('Origin', origin).set('Content-Type', 'audio/wav').send(Buffer.from('nope')).expect(400);
    await owner.put(url).set('Origin', origin).set('Content-Type', 'audio/wav').send(speakingWav(1000)).expect(403);
  });
  it('shows the trainer the next brief with the last tasks and their records, and shows the guardian nothing', async () => {
    const { owner, member, id, caseId, taskId } = await approved();
    const url = `/api/coaching/cases/${caseId}/brief`;
    await member.get(url).expect(403);
    const empty = (await owner.get(url).expect(200)).body;
    expect(empty.consultationId).toBe(id);
    expect(empty.brief.previousTasks[0].text).toContain('수행 여부 미확인');
    await member.post(logUrl(caseId)).set('Origin', origin).send({ consultationId: id, taskId, status: 'done', text: '소리를 줄이니 매트로 갔어요' }).expect(201);
    const draft = (await member.post(`/api/coaching/cases/${caseId}/guardian-logs/draft`).set('Origin', origin).send({ text: '오늘 초인종에 짖었어요', sourceKind: 'nl_log_text' }).expect(200)).body;
    draft.events[0].occurredAt = new Date(Date.now() - 60000).toISOString(); draft.events[0].edited = true;
    await member.post(`/api/coaching/cases/${caseId}/guardian-logs`).set('Origin', origin).send({ draft }).expect(201);
    const { brief } = (await owner.get(url).expect(200)).body;
    expect(brief.previousTasks[0].text).toContain('완료 1회');
    expect(brief.sources.some((source: { kind: string; sourceQuote: string }) => source.kind === 'task_log' && source.sourceQuote === '소리를 줄이니 매트로 갔어요')).toBe(true);
    expect(brief.sources.some((source: { kind: string; sourceQuote: string }) => source.kind === 'owner' && source.sourceQuote === '오늘 초인종에 짖었어요')).toBe(true);
    expect(brief.sources.find((source: { kind: string; category?: string }) => source.category === 'task').evidence[0].quote).toBeTruthy();
    expect(brief.summary).toHaveLength(3);
  });
  it('still gives a brief before the first confirmed consultation, and says what is missing', async () => {
    const { owner, caseId } = await delivered();
    const { brief, consultationId } = (await owner.get(`/api/coaching/cases/${caseId}/brief`).expect(200)).body;
    expect(consultationId).toBeNull();
    expect(brief.previousTasks).toEqual([]);
    expect(brief.dataGaps.join()).toContain('확정 상담일지');
  });
});
