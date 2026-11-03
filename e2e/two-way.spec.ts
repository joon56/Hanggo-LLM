import { expect, test } from '@playwright/test';
import { loadLocalEnv } from '../server/config';
import { readTurn } from '../server/turn';
import { audioEnergy, createCaseAsTrainer, enterAsGuardian, enterAsTrainer, ensureMedia, expectFlowing, joinAsGuardian, launch, room, startServer, type Participant, type TestServer } from './helpers/two-way';

// Real server, real WebSocket signaling, real WebRTC between two separate Chrome processes with synthetic media.
test.describe.configure({ mode: 'serial', timeout: 90_000 });
loadLocalEnv();
const hasTurn = !!readTurn(process.env);
let server: TestServer; let port = 3190;
const opened: Participant[] = [];
const open = async (...args: Parameters<typeof launch>) => { const participant = await launch(...args); opened.push(participant); return participant; };

test.beforeAll(() => { ensureMedia(); });
test.beforeEach(async ({}, info) => { server = await startServer(port++, { turn: info.title.includes('relay') }); });
test.afterEach(async () => {
  for (const participant of opened.splice(0)) await participant.browser.close();
  await server.stop();
});

async function connected(guardianOptions: Parameters<typeof launch>[1] = {}) {
  const trainer = await open('trainer'); const guardian = await open('guardian', guardianOptions);
  const invite = await createCaseAsTrainer(trainer.page, server.origin);
  await joinAsGuardian(guardian.page, invite);
  await enterAsTrainer(trainer.page);
  await guardian.page.reload();
  await enterAsGuardian(guardian.page);
  return { trainer, guardian, invite };
}

test('guardian and trainer see and hear each other through an invite', async () => {
  const { trainer, guardian } = await connected();
  await Promise.all([expectFlowing(trainer.page), expectFlowing(guardian.page)]);
  await expect(room(trainer.page)).toHaveAttribute('data-peer-camera', 'true');
  await expect(room(guardian.page)).toHaveAttribute('data-peer-camera', 'true');
  for (const page of [trainer.page, guardian.page]) {
    await expect.poll(() => page.getByLabel('상대 카메라').evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0);
  }
});

test('muting stops the audio the other side receives, and unmuting restores it', async () => {
  const { trainer, guardian } = await connected();
  await expectFlowing(trainer.page);
  await guardian.page.getByRole('button', { name: '마이크 끄기' }).click();
  await expect(room(trainer.page)).toHaveAttribute('data-peer-microphone', 'false');
  await trainer.page.waitForTimeout(2500);
  const before = await audioEnergy(trainer.page);
  await trainer.page.waitForTimeout(2000);
  expect(await audioEnergy(trainer.page) - before).toBeLessThan(0.001);
  await guardian.page.getByRole('button', { name: '마이크 켜기' }).click();
  await expect(room(trainer.page)).toHaveAttribute('data-peer-microphone', 'true');
  await expect.poll(() => audioEnergy(trainer.page), { timeout: 15_000 }).toBeGreaterThan(before + 0.001);
});

test('sharing a screen adds a second video without dropping the camera', async () => {
  const { trainer, guardian } = await connected();
  await expectFlowing(guardian.page);
  await trainer.page.getByRole('button', { name: '화면 공유' }).click();
  await expect(room(guardian.page)).toHaveAttribute('data-peer-screen', 'true');
  const shared = guardian.page.getByLabel('상대 공유 화면');
  await expect.poll(() => shared.evaluate((video: HTMLVideoElement) => video.videoWidth), { timeout: 20_000 }).toBe(640);
  await expect.poll(() => guardian.page.getByLabel('상대 카메라').evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0);
  await trainer.page.getByRole('button', { name: '공유 중지' }).click();
  await expect(room(guardian.page)).toHaveAttribute('data-peer-screen', 'false');
  await expect(guardian.page.getByLabel('상대 공유 화면')).toHaveCount(0);
  await expectFlowing(guardian.page);
});

test('the guardian can share a screen too', async () => {
  const { trainer, guardian } = await connected();
  await expectFlowing(trainer.page);
  await guardian.page.getByRole('button', { name: '화면 공유' }).click();
  await expect(room(trainer.page)).toHaveAttribute('data-peer-screen', 'true');
  await expect.poll(() => trainer.page.getByLabel('상대 공유 화면').evaluate((video: HTMLVideoElement) => video.videoWidth), { timeout: 20_000 }).toBe(640);
});

test('someone without a camera can still join and receive video', async () => {
  const trainer = await open('trainer', { noCamera: true }); const guardian = await open('guardian');
  const invite = await createCaseAsTrainer(trainer.page, server.origin);
  await joinAsGuardian(guardian.page, invite);
  await trainer.page.getByRole('button', { name: '초코 상담 시작' }).click();
  await trainer.page.waitForURL(/\/room\//);
  await expect(trainer.page.getByText(/카메라를 찾지 못했습니다/)).toBeVisible();
  await trainer.page.getByRole('button', { name: '입장' }).click();
  await guardian.page.reload();
  await enterAsGuardian(guardian.page);
  await expect(trainer.page.getByRole('button', { name: '카메라 없음' })).toBeDisabled();
  await Promise.all([expectFlowing(trainer.page)]);
  await expect(room(guardian.page)).toHaveAttribute('data-peer-camera', 'false');
  await expect.poll(() => trainer.page.getByLabel('상대 카메라').evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0);
});

test('reloading reconnects the call', async () => {
  const { trainer, guardian } = await connected();
  await expectFlowing(trainer.page);
  await guardian.page.goto(`${server.origin}/guardian`);
  await expect(room(trainer.page)).toHaveAttribute('data-peer-online', 'false');
  await enterAsGuardian(guardian.page);
  await Promise.all([expectFlowing(trainer.page), expectFlowing(guardian.page)]);
});

test('recording needs both consents and a withdrawal keeps the call going', async () => {
  const { trainer, guardian } = await connected();
  await expectFlowing(guardian.page);
  await expect(room(trainer.page)).toHaveAttribute('data-recording', 'false');
  await trainer.page.getByRole('button', { name: '기록 동의', exact: true }).click();
  await expect(trainer.page.getByText(/보호자 동의 대기/)).toBeVisible();
  await expect(room(guardian.page)).toHaveAttribute('data-recording', 'false');
  await guardian.page.getByRole('button', { name: '기록 동의', exact: true }).click();
  await expect(room(trainer.page)).toHaveAttribute('data-recording', 'true');
  await expect(room(guardian.page)).toHaveAttribute('data-recording', 'true');
  await guardian.page.getByRole('button', { name: '기록 동의 철회' }).click();
  await expect(room(trainer.page)).toHaveAttribute('data-recording', 'false');
  await expectFlowing(trainer.page);
});

test('ending the consultation returns both sides to their home screens', async () => {
  const { trainer, guardian } = await connected();
  await expectFlowing(trainer.page);
  await trainer.page.getByRole('button', { name: '상담 종료' }).click();
  await trainer.page.waitForURL(/\/coaching$/);
  await guardian.page.waitForURL(/\/guardian$/);
  await expect(guardian.page.getByRole('button', { name: '상담 입장', exact: true })).toHaveCount(0);
});

test('a relay-only call connects through the configured TURN server', async () => {
  test.skip(!hasTurn, 'TURN credentials are not configured.');
  const trainer = await open('trainer'); const guardian = await open('guardian');
  const invite = await createCaseAsTrainer(trainer.page, server.origin);
  await joinAsGuardian(guardian.page, invite);
  await trainer.page.getByRole('button', { name: '초코 상담 시작' }).click();
  await trainer.page.waitForURL(/\/room\//);
  const relayRoom = `${trainer.page.url()}?forceRelay=1`;
  await trainer.page.goto(relayRoom);
  await trainer.page.getByRole('button', { name: '입장' }).click();
  await guardian.page.goto(relayRoom);
  await guardian.page.getByRole('button', { name: '입장' }).click();
  await Promise.all([expectFlowing(trainer.page), expectFlowing(guardian.page)]);
  await expect(room(trainer.page)).toHaveAttribute('data-relayed', 'true');
  await expect(room(guardian.page)).toHaveAttribute('data-relayed', 'true');
});

test('outsiders cannot enter: reused invite, no session, and another case', async () => {
  const { trainer, invite } = await connected();
  const roomUrl = trainer.page.url();
  const stranger = await open('guardian');
  await stranger.page.goto(invite);
  await stranger.page.getByRole('button', { name: '상담 입장 준비' }).click();
  await expect(stranger.page.getByRole('alert')).toContainText('훈련사에게 새 링크');
  await stranger.page.goto(roomUrl);
  await expect(stranger.page.getByRole('alert')).toContainText('로그인이 필요합니다');
  await expect(room(stranger.page)).toHaveCount(0);

  const otherCaseInvite = await createCaseAsTrainer(trainer.page, server.origin, '보리');
  await joinAsGuardian(stranger.page, otherCaseInvite);
  await stranger.page.goto(roomUrl);
  await expect(stranger.page.getByRole('alert')).toBeVisible();
  await expect(room(stranger.page)).toHaveCount(0);
});
