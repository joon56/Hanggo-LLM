// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createGuardianSessions } from './guardian-session.ts';
import { createActorResolver, GUARDIAN_COOKIE } from './router.ts';
import { attachSignal } from './signal.ts';
import { createFileStore, type CoachingStore } from './store.ts';

const origin = 'http://127.0.0.1:5173';
const trainerCookie = 'trainer=1';
let directory: string; let store: CoachingStore; let server: Server; let port: number; let hub: ReturnType<typeof attachSignal>;
let guardianCookie: string; let consultationId: string; let caseId: string;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'hanggo-signal-'));
  store = createFileStore(directory);
  const sessions = createGuardianSessions(directory);
  const created = await store.createCase({ petName: '초코', guardianName: '가상 보호자', trainerName: '가상 훈련사' });
  caseId = created.case.id;
  guardianCookie = `${GUARDIAN_COOKIE}=${sessions.issue(caseId, 0)}`;
  consultationId = (await store.startConsultation(caseId)).id;
  server = createServer();
  hub = attachSignal(server, { store, allowedOrigins: new Set([origin]), resolveActor: createActorResolver({ store, sessions, isTrainer: headers => !!headers.cookie?.includes(trainerCookie) }) });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  hub.close();
  await new Promise(resolve => server.close(resolve));
  rmSync(directory, { recursive: true, force: true });
});

type Client = { socket: WebSocket; next: (type?: string) => Promise<any>; closed: Promise<number> };
function connect(cookie: string, options: { id?: string; call?: string; requestOrigin?: string } = {}): Promise<Client> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/coaching/consultations/${options.id ?? consultationId}/signal?call=${options.call ?? 'call-1'}`, { headers: { Cookie: cookie, Origin: options.requestOrigin ?? origin } });
  sockets.push(socket);
  const inbox: any[] = []; const waiting: { type?: string; resolve: (value: any) => void }[] = [];
  socket.on('message', raw => {
    const message = JSON.parse(String(raw));
    const index = waiting.findIndex(item => !item.type || item.type === message.type);
    if (index >= 0) waiting.splice(index, 1)[0].resolve(message); else inbox.push(message);
  });
  const next = (type?: string) => new Promise<any>((resolve, reject) => {
    const index = inbox.findIndex(item => !type || item.type === type);
    if (index >= 0) { resolve(inbox.splice(index, 1)[0]); return; }
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 2000);
    waiting.push({ type, resolve: value => { clearTimeout(timer); resolve(value); } });
  });
  const closed = new Promise<number>(resolve => socket.once('close', code => resolve(code)));
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve({ socket, next, closed }));
    socket.once('unexpected-response', (_request, response) => reject(new Error(String(response.statusCode))));
    socket.once('error', reject);
  });
}
const send = (client: Client, message: unknown) => client.socket.send(JSON.stringify(message));

it.each([
  ['no session', '', origin, '401'],
  ['a bad origin', trainerCookie, 'https://evil.example', '403'],
])('rejects %s', async (_name, cookie, requestOrigin, status) => {
  await expect(connect(cookie, { requestOrigin })).rejects.toThrow(status);
});
it('rejects a guardian from another case', async () => {
  const sessions = createGuardianSessions(directory);
  const other = await store.createCase({ petName: '보리', guardianName: '다른 보호자', trainerName: '가상 훈련사' });
  await expect(connect(`${GUARDIAN_COOKIE}=${sessions.issue(other.case.id, 0)}`)).rejects.toThrow('403');
});
it('rejects a guardian whose invite was reissued', async () => {
  await store.reissueInvite(caseId);
  await expect(connect(guardianCookie)).rejects.toThrow('401');
});
it('rejects an unknown or ended consultation', async () => {
  await expect(connect(trainerCookie, { id: '00000000-0000-4000-8000-000000000000' })).rejects.toThrow('404');
  await store.updateConsultation(consultationId, current => ({ ...current, state: 'review' }));
  await expect(connect(trainerCookie)).rejects.toThrow('409');
});
it('greets each participant with role, server time, and peer presence', async () => {
  const trainer = await connect(trainerCookie);
  const hello = await trainer.next('hello');
  expect(hello).toMatchObject({ role: 'trainer', peerOnline: false });
  expect(hello.serverNow).toBeTypeOf('number');
  const guardian = await connect(guardianCookie);
  expect(await guardian.next('hello')).toMatchObject({ role: 'guardian', peerOnline: true });
  expect(await trainer.next('peer-joined')).toEqual({ type: 'peer-joined' });
});
it('relays negotiation only to the other participant', async () => {
  const trainer = await connect(trainerCookie); const guardian = await connect(guardianCookie);
  await trainer.next('hello'); await guardian.next('hello');
  send(trainer, { type: 'offer', sdp: 'trainer-offer' });
  expect(await guardian.next('offer')).toEqual({ type: 'offer', sdp: 'trainer-offer' });
  send(guardian, { type: 'answer', sdp: 'guardian-answer' });
  expect(await trainer.next('answer')).toEqual({ type: 'answer', sdp: 'guardian-answer' });
  send(guardian, { type: 'candidate', candidate: { candidate: 'x', sdpMid: '0' } });
  expect(await trainer.next('candidate')).toEqual({ type: 'candidate', candidate: { candidate: 'x', sdpMid: '0' } });
  send(guardian, { type: 'media', camera: true, microphone: false, screen: true });
  expect(await trainer.next('media')).toEqual({ type: 'media', camera: true, microphone: false, screen: true });
  await expect(trainer.next('offer')).rejects.toThrow('Timed out');
});
it('answers ping with server time for clock sync', async () => {
  const trainer = await connect(trainerCookie);
  send(trainer, { type: 'ping', at: 123 });
  const pong = await trainer.next('pong');
  expect(pong.at).toBe(123);
  expect(pong.serverNow).toBeTypeOf('number');
});
it('tells the sender about malformed messages without forwarding them', async () => {
  const trainer = await connect(trainerCookie); const guardian = await connect(guardianCookie);
  await guardian.next('hello');
  send(trainer, { type: 'offer' });
  expect(await trainer.next('error')).toMatchObject({ code: 'INPUT' });
  trainer.socket.send('not json');
  expect(await trainer.next('error')).toMatchObject({ code: 'INPUT' });
  send(trainer, { type: 'state', state: 'approved' });
  expect(await trainer.next('error')).toMatchObject({ code: 'INPUT' });
  await expect(guardian.next('offer')).rejects.toThrow('Timed out');
});
it('closes oversized messages', async () => {
  const trainer = await connect(trainerCookie);
  trainer.socket.send(JSON.stringify({ type: 'offer', sdp: 'x'.repeat(70 * 1024) }));
  expect(await trainer.closed).toBe(1009);
});
it('closes clients that flood messages', async () => {
  const trainer = await connect(trainerCookie);
  for (let index = 0; index < 60; index++) send(trainer, { type: 'ping', at: index });
  expect(await trainer.closed).toBe(1008);
});
it('replaces an earlier connection for the same role', async () => {
  const first = await connect(trainerCookie);
  const second = await connect(trainerCookie, { call: 'call-2' });
  expect(await first.closed).toBe(4001);
  await expect(second.next('hello')).resolves.toMatchObject({ role: 'trainer' });
});
it('does not announce a rejoin when the same call reconnects its signaling socket', async () => {
  const trainer = await connect(trainerCookie);
  let guardian = await connect(guardianCookie, { call: 'guardian-call' });
  await trainer.next('peer-joined');
  guardian.socket.close(); await guardian.closed;
  expect(await trainer.next('state')).toMatchObject({ peerOnline: false });
  guardian = await connect(guardianCookie, { call: 'guardian-call' });
  expect(await guardian.next('hello')).toMatchObject({ peerOnline: true });
  await expect(trainer.next('peer-joined')).rejects.toThrow('Timed out');
});
it('announces a rejoin when the peer returns with a new call', async () => {
  const trainer = await connect(trainerCookie);
  let guardian = await connect(guardianCookie, { call: 'first' });
  await trainer.next('peer-joined');
  guardian.socket.close(); await guardian.closed;
  guardian = await connect(guardianCookie, { call: 'second' });
  await expect(trainer.next('peer-joined')).resolves.toEqual({ type: 'peer-joined' });
});
it('broadcasts consultation changes with presence per recipient', async () => {
  const trainer = await connect(trainerCookie); const guardian = await connect(guardianCookie);
  await trainer.next('hello'); await guardian.next('hello');
  const updated = await store.updateConsultation(consultationId, current => ({ ...current, consent: { guardian: true, trainer: true }, recording: true }));
  hub.notify(updated);
  await expect(guardian.next('state')).resolves.toMatchObject({ recording: true, consent: { guardian: true, trainer: true }, state: 'live', peerOnline: true });
});
it('closes participants after the consultation leaves the live state', async () => {
  const trainer = await connect(trainerCookie);
  await trainer.next('hello');
  hub.notify(await store.updateConsultation(consultationId, current => ({ ...current, state: 'review' })));
  await expect(trainer.next('state')).resolves.toMatchObject({ state: 'review' });
  expect(await trainer.closed).toBe(1000);
});
