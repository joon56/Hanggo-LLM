import { expect, test, type Page } from '@playwright/test';
import { STUB_TEXT } from '../server/ai/speech/stub';
import type { Consultation } from '../src/domain/coaching';
import { createCaseAsTrainer, enterAsGuardian, enterAsTrainer, ensureMedia, expectFlowing, joinAsGuardian, launch, room, startServer, type Participant, type TestServer } from './helpers/two-way';

// Real server, real uploads, and real captions from two Chrome processes. The speech model is the stub that names each test tone.
test.describe.configure({ mode: 'serial', timeout: 150_000 });
let server: TestServer; let port = 3290;
const opened: Participant[] = [];
const open = async (...args: Parameters<typeof launch>) => { const participant = await launch(...args); opened.push(participant); return participant; };

test.beforeAll(() => { ensureMedia(); });
test.beforeEach(async () => { server = await startServer(port++, { speech: 'stub' }); });
test.afterEach(async () => {
  for (const participant of opened.splice(0)) await participant.browser.close();
  await server.stop();
});

function watchUploads(page: Page) {
  const sent = { audio: 0, frames: 0, total() { return this.audio + this.frames; } };
  page.on('request', request => {
    if (request.method() !== 'PUT') return;
    if (/\/audio\//.test(request.url())) sent.audio += 1;
    if (/\/frames\//.test(request.url())) sent.frames += 1;
  });
  return sent;
}
async function connected() {
  const trainer = await open('trainer'); const guardian = await open('guardian');
  const uploads = { trainer: watchUploads(trainer.page), guardian: watchUploads(guardian.page) };
  const invite = await createCaseAsTrainer(trainer.page, server.origin);
  await joinAsGuardian(guardian.page, invite);
  await enterAsTrainer(trainer.page);
  await guardian.page.reload();
  await enterAsGuardian(guardian.page);
  await Promise.all([expectFlowing(trainer.page), expectFlowing(guardian.page)]);
  const id = /\/room\/([^/?]+)/.exec(trainer.page.url())![1];
  const read = async () => (await trainer.page.request.get(`${server.origin}/api/coaching/consultations/${id}`)).json() as Promise<Consultation>;
  return { trainer, guardian, uploads, id, read };
}
const consent = (page: Page) => page.getByRole('button', { name: '기록 동의', exact: true }).click();
const withdraw = (page: Page) => page.getByRole('button', { name: '기록 동의 철회' }).click();
const captionCount = async (page: Page) => Number(await room(page).getAttribute('data-caption-count'));
const startRecording = async (trainer: Page, guardian: Page) => {
  await consent(trainer); await consent(guardian);
  await Promise.all([expect(room(trainer)).toHaveAttribute('data-recording', 'true'), expect(room(guardian)).toHaveAttribute('data-recording', 'true')]);
};

test('sends nothing before both people consent, then labels each speaker from their own microphone', async () => {
  const { trainer, guardian, uploads, read } = await connected();
  await trainer.page.waitForTimeout(6000);
  await consent(trainer.page);
  await trainer.page.waitForTimeout(6000);
  expect(uploads.trainer.total() + uploads.guardian.total()).toBe(0);
  await consent(guardian.page);
  for (const page of [trainer.page, guardian.page]) {
    await expect(room(page)).toHaveAttribute('data-recording', 'true');
    await expect.poll(() => captionCount(page), { timeout: 40_000 }).toBeGreaterThanOrEqual(2);
    await expect(room(page)).toHaveAttribute('data-speech-status', 'ready');
  }
  const { segments } = await read();
  const spoken = segments.filter(item => item.state === 'complete');
  expect(spoken.filter(item => item.speaker === 'guardian').length).toBeGreaterThan(0);
  expect(spoken.filter(item => item.speaker === 'trainer').length).toBeGreaterThan(0);
  for (const segment of spoken) { expect(segment.text).toBe(STUB_TEXT[segment.speaker]); expect(segment.echoSuspect).toBeUndefined(); }
  await expect(guardian.page.getByRole('log', { name: '자막' })).toContainText(/(?:훈련사|보호자) \[시험 전사\]/);
  expect(Number(await room(trainer.page).getAttribute('data-caption-latency-ms'))).toBeLessThan(5000);
});

test('catching a moment saves the scenes before the press from both sides', async () => {
  const { trainer, guardian, uploads, id, read } = await connected();
  await startRecording(trainer.page, guardian.page);
  // Long enough that the frames from five seconds before the press exist.
  await trainer.page.waitForTimeout(8000);
  expect(uploads.trainer.frames).toBe(0);
  await guardian.page.getByRole('button', { name: '캐치' }).click();
  await expect(trainer.page.getByRole('status').filter({ hasText: '보호자가 이 장면을 표시했습니다' })).toBeVisible();
  await expect(guardian.page.getByLabel('장면 메모')).toHaveCount(0);
  await trainer.page.getByLabel('장면 메모').fill('귀가 먼저 움직임');
  await trainer.page.getByRole('button', { name: '메모 저장' }).click();
  // Photos upload oldest first, so wait for them all before looking at the latest one.
  await expect.poll(async () => {
    const { frames, moments } = await read();
    const caught = frames.filter(frame => moments[0]?.frameIds.includes(frame.id));
    return new Set(caught.map(frame => frame.speaker)).size === 2 && caught.length >= 12;
  }, { timeout: 30_000 }).toBe(true);
  const consultation = await read();
  const [moment] = consultation.moments;
  expect(moment).toMatchObject({ createdBy: 'guardian', text: '귀가 먼저 움직임' });
  const times = consultation.frames.filter(frame => moment.frameIds.includes(frame.id)).map(frame => frame.atMs);
  expect(Math.min(...times)).toBeLessThanOrEqual(moment.atMs - 4000);
  expect(Math.max(...times)).toBeGreaterThanOrEqual(moment.atMs);
  expect(moment.frameIds.length).toBeLessThanOrEqual(16);
  const image = await trainer.page.request.get(`${server.origin}/api/coaching/consultations/${id}/frames/${moment.frameIds[0]}`);
  expect(image.status()).toBe(200);
  expect([...(await image.body()).subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  const guardianRead = await guardian.page.request.get(`${server.origin}/api/coaching/consultations/${id}/frames/${moment.frameIds[0]}`);
  expect(guardianRead.status()).toBe(403);
});

test('a shared screen is stored only when someone catches a moment', async () => {
  const { trainer, guardian, read } = await connected();
  await startRecording(trainer.page, guardian.page);
  await trainer.page.getByRole('button', { name: '화면 공유' }).click();
  await expect(room(guardian.page)).toHaveAttribute('data-peer-screen', 'true');
  await trainer.page.waitForTimeout(5000);
  expect((await read()).frames.filter(frame => frame.source === 'screen')).toEqual([]);
  await trainer.page.getByRole('button', { name: '캐치' }).click();
  await expect.poll(async () => (await read()).frames.filter(frame => frame.source === 'screen' && frame.speaker === 'trainer').length, { timeout: 20_000 }).toBeGreaterThan(0);
});

test('withdrawing consent stops the uploads and captions on both sides, and consenting again resumes them', async () => {
  const { trainer, guardian, uploads } = await connected();
  await startRecording(trainer.page, guardian.page);
  await expect.poll(() => captionCount(trainer.page), { timeout: 40_000 }).toBeGreaterThan(0);
  await withdraw(guardian.page);
  await Promise.all([expect(room(trainer.page)).toHaveAttribute('data-recording', 'false'), expect(room(guardian.page)).toHaveAttribute('data-recording', 'false')]);
  await expect(guardian.page.getByRole('button', { name: '캐치' })).toBeDisabled();
  // Requests already on the wire may finish, so count from just after the withdrawal settled.
  await trainer.page.waitForTimeout(1500);
  const before = { uploads: uploads.trainer.total() + uploads.guardian.total(), captions: await captionCount(trainer.page) };
  await trainer.page.waitForTimeout(8000);
  expect(uploads.trainer.total() + uploads.guardian.total()).toBe(before.uploads);
  expect(await captionCount(trainer.page)).toBe(before.captions);
  await expectFlowing(trainer.page);
  await consent(guardian.page);
  await expect.poll(() => captionCount(trainer.page), { timeout: 40_000 }).toBeGreaterThan(before.captions);
});

test('ending keeps the last words and opens the review', async () => {
  const { trainer, guardian, read } = await connected();
  await startRecording(trainer.page, guardian.page);
  const spokenByGuardian = async () => (await read()).segments.filter(item => item.speaker === 'guardian' && item.state === 'complete').length;
  await expect.poll(spokenByGuardian, { timeout: 40_000 }).toBeGreaterThan(0);
  // A window just closed in the pause. Two seconds later the tone is mid-burst, so the guardian's browser holds unsent audio.
  const seen = await spokenByGuardian();
  await expect.poll(spokenByGuardian, { timeout: 15_000, intervals: [100] }).toBeGreaterThan(seen);
  await guardian.page.waitForTimeout(2000);
  const beforeEnd = await spokenByGuardian();
  await trainer.page.getByRole('button', { name: '상담 종료' }).click();
  await trainer.page.waitForURL(/\/coaching$/);
  await guardian.page.waitForURL(/\/guardian$/);
  await expect.poll(async () => (await read()).state, { timeout: 30_000 }).toBe('review');
  const finished = await read();
  expect(finished.segments.some(item => item.state === 'queued')).toBe(false);
  const guardianSegments = finished.segments.filter(item => item.speaker === 'guardian' && item.state === 'complete');
  expect(guardianSegments.length).toBe(beforeEnd + 1);
  expect(guardianSegments.at(-1)!.endMs).toBeGreaterThan(finished.endedAt! - finished.recordingStartedAt! - 1500);
});

test('rejoining mid-recording brings back the captions and keeps recording on the same clock', async () => {
  const { trainer, guardian, read } = await connected();
  await startRecording(trainer.page, guardian.page);
  await expect.poll(() => captionCount(guardian.page), { timeout: 40_000 }).toBeGreaterThan(0);
  const heardBefore = (await read()).segments.filter(item => item.speaker === 'guardian').length;
  await guardian.page.reload();
  await guardian.page.getByRole('button', { name: '입장' }).click();
  await expect(room(guardian.page)).toBeVisible();
  await expect.poll(() => captionCount(guardian.page), { timeout: 15_000 }).toBeGreaterThan(0);
  await expect.poll(async () => (await read()).segments.filter(item => item.speaker === 'guardian' && item.state === 'complete').length, { timeout: 40_000 }).toBeGreaterThan(heardBefore);
  const guardianSegments = (await read()).segments.filter(item => item.speaker === 'guardian');
  expect(guardianSegments.map(item => item.startMs)).toEqual([...guardianSegments.map(item => item.startMs)].sort((left, right) => left - right));
});

test('a newer tab takes over: the old tab lets go of the microphone and stops recording', async () => {
  const { trainer, guardian, uploads } = await connected();
  await startRecording(trainer.page, guardian.page);
  await expect.poll(() => uploads.guardian.audio, { timeout: 40_000 }).toBeGreaterThan(0);
  const newer = await guardian.page.context().newPage();
  await newer.goto(guardian.page.url());
  await newer.getByRole('button', { name: '입장' }).click();
  await expect(room(newer)).toBeVisible();
  await expect(guardian.page.getByRole('status').filter({ hasText: '다른 탭이나 기기에서 입장해' })).toBeVisible({ timeout: 15_000 });
  await guardian.page.waitForTimeout(1500);
  const before = uploads.guardian.total();
  await guardian.page.waitForTimeout(8000);
  expect(uploads.guardian.total()).toBe(before);
});

test('a call without a speech model continues, records scenes, and says transcription is off', async () => {
  await server.stop();
  server = await startServer(port++);
  const { trainer, guardian, uploads } = await connected();
  await startRecording(trainer.page, guardian.page);
  await expect(trainer.page.getByText('받아쓰기 꺼짐')).toBeVisible();
  await guardian.page.waitForTimeout(8000);
  expect(uploads.guardian.audio).toBe(0);
  expect(uploads.guardian.frames).toBeGreaterThan(0);
  await expect(trainer.page.getByText(/일부 기록을 보내지 못했습니다/)).toHaveCount(0);
  await expectFlowing(trainer.page);
});

test('rejoining shows consent still on, and unchecking it stops the recording before anything is sent', async () => {
  const { trainer, guardian, uploads } = await connected();
  await startRecording(trainer.page, guardian.page);
  await guardian.page.reload();
  const box = guardian.page.getByLabel(/AI 받아쓰기와 장면 저장에 동의합니다/);
  await expect(box).toBeChecked();
  // People can check their microphone before anyone hears them.
  await expect(guardian.page.getByRole('meter', { name: '마이크 입력' })).toHaveAttribute('data-heard', 'true', { timeout: 10_000 });
  await box.uncheck();
  const before = uploads.guardian.total();
  await guardian.page.getByRole('button', { name: '입장' }).click();
  await expect(room(guardian.page)).toBeVisible();
  await expect(room(trainer.page)).toHaveAttribute('data-recording', 'false');
  await guardian.page.waitForTimeout(6000);
  expect(uploads.guardian.total()).toBe(before);
  await expect(room(guardian.page)).toHaveAttribute('data-recording', 'false');
});

test('reissuing the invite ends the call of whoever holds the old one', async () => {
  const { trainer, guardian } = await connected();
  const { cases: [{ id }] } = await (await trainer.page.request.get(`${server.origin}/api/coaching/cases`)).json() as { cases: { id: string }[] };
  await trainer.page.request.post(`${server.origin}/api/coaching/cases/${id}/invite`, { headers: { Origin: server.origin } });
  await expect(guardian.page.getByText(/다른 탭이나 기기에서 입장/)).toBeVisible();
  await expect(room(trainer.page)).toHaveAttribute('data-peer-online', 'false');
});
