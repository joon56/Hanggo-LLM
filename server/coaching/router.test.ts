// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import { readConfig } from '../config.ts';

const origin = 'http://127.0.0.1:5173';
const password = 'long-test-password-1234';
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function setup(env: NodeJS.ProcessEnv = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'hanggo-router-')); homes.push(home);
  return createApp(readConfig({ HANGGO_HOME: home, APP_ACCESS_PASSWORD: password, ...env }), { generate: async () => ({}), transcribe: async () => '' });
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
  expect(ended.body.state).toBe('review');
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
