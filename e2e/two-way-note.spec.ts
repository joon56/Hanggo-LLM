import { expect, test, type Page } from '@playwright/test';
import { STUB_TEXT } from '../server/ai/speech/stub';
import type { Consultation } from '../src/domain/coaching';
import { createCaseAsTrainer, enterAsGuardian, enterAsTrainer, ensureMedia, joinAsGuardian, launch, room, startServer, type Participant, type TestServer } from './helpers/two-way';

// The whole path from a call to the guardian's confirmed note, with stub AI. This proves the path, not the quality of a note.
test.describe.configure({ mode: 'serial', timeout: 180_000 });
let server: TestServer; let port = 3340;
const opened: Participant[] = [];
const open = async (role: 'trainer' | 'guardian') => { const participant = await launch(role); opened.push(participant); return participant; };
test.beforeAll(() => { ensureMedia(); });
test.beforeEach(async () => { server = await startServer(port++, { speech: 'stub' }); });
test.afterEach(async () => {
  for (const participant of opened.splice(0)) await participant.browser.close();
  await server.stop();
});

const reader = (page: Page, id: string) => async () => (await page.request.get(`${server.origin}/api/coaching/consultations/${id}`)).json() as Promise<Consultation>;
async function finishedCall() {
  const trainer = await open('trainer'); const guardian = await open('guardian');
  const invite = await createCaseAsTrainer(trainer.page, server.origin);
  await joinAsGuardian(guardian.page, invite);
  await enterAsTrainer(trainer.page);
  await guardian.page.reload();
  await enterAsGuardian(guardian.page);
  for (const { page } of [trainer, guardian]) await page.getByRole('button', { name: '기록 동의', exact: true }).click();
  await expect(room(trainer.page)).toHaveAttribute('data-recording', 'true');
  const id = /\/room\/([^/?]+)/.exec(trainer.page.url())![1];
  const read = reader(trainer.page, id);
  await expect.poll(async () => {
    const { segments, frames } = await read();
    return new Set(segments.filter(item => item.state === 'complete').map(item => item.speaker)).size === 2 && frames.length > 0;
  }, { timeout: 60_000 }).toBe(true);
  await trainer.page.getByRole('button', { name: '상담 종료' }).click();
  await trainer.page.waitForURL(/\/coaching$/);
  await guardian.page.waitForURL(/\/guardian$/);
  await expect.poll(async () => (await read()).state, { timeout: 60_000 }).toBe('review');
  return { trainer, guardian, id, read };
}

test('a finished call becomes a draft the trainer reviews, and the guardian only sees what was confirmed', async () => {
  const { trainer, guardian, id } = await finishedCall();
  // Before approval the guardian has nothing, and the server refuses a direct request too.
  await guardian.page.reload();
  await expect(guardian.page.getByRole('article', { name: '확정된 상담일지' })).toHaveCount(0);
  expect((await guardian.page.request.get(`${server.origin}/api/coaching/consultations/${id}/delivery`)).status()).toBe(404);
  const asGuardian = await (await guardian.page.request.get(`${server.origin}/api/coaching/consultations/${id}`)).json();
  expect(asGuardian).not.toHaveProperty('note');
  await guardian.page.goto(`${server.origin}/review/${id}`);
  await guardian.page.waitForURL(/\/guardian$/);

  await trainer.page.getByRole('button', { name: '검토하기' }).click();
  await trainer.page.waitForURL(/\/review\//);
  const page = trainer.page;
  await expect(page.getByRole('heading', { name: '초코 상담 검토' })).toBeVisible();
  const transcript = page.getByRole('region', { name: '전사와 장면' });
  await expect(transcript.getByText(STUB_TEXT.guardian).first()).toBeVisible();
  await expect(transcript.getByText(STUB_TEXT.trainer).first()).toBeVisible();

  // A sentence leads to its evidence.
  const firstChip = page.getByRole('region', { name: '상담일지' }).getByRole('button', { name: /보호자 \d\d:\d\d/ }).first();
  await firstChip.click();
  await expect(transcript.locator('[data-selected="true"]')).toHaveCount(1);

  // The trainer edits a sentence, confirms an observation seen in a real uploaded photo, and fills in a task field.
  await page.getByRole('textbox', { name: '훈련사 안내 문장' }).first().fill('매트로 가는 연습을 안내했습니다');
  await page.getByLabel('담당').first().fill('보호자');
  await expect(transcript.getByRole('img', { name: /상담 \d\d:\d\d 장면/ }).first()).toBeVisible();
  const photo = transcript.getByRole('img', { name: /상담 \d\d:\d\d 장면/ }).first();
  await expect.poll(() => photo.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await page.getByRole('checkbox', { name: '확인한 관찰만 일지에 넣기' }).first().check();
  await expect(page.getByRole('checkbox', { name: '확인한 관찰만 일지에 넣기' }).first()).toBeChecked();

  // A banned expression stops approval until it is removed.
  await page.getByRole('button', { name: '고민 문장 추가' }).click();
  await page.getByRole('textbox', { name: '고민 문장' }).fill('이 연습으로 반드시 좋아집니다');
  await page.getByRole('button', { name: '확정하고 보호자에게 전달' }).click();
  await expect(page.getByRole('alert').filter({ hasText: '금지 표현' })).toBeVisible();
  await page.getByRole('button', { name: '고민 문장 삭제' }).click();
  await page.getByRole('button', { name: '확정하고 보호자에게 전달' }).click();
  await expect(page.getByText('확정해 보호자에게 전달했습니다.')).toBeVisible();
  await expect(page.getByRole('textbox', { name: '훈련사 안내 문장' })).toHaveCount(0);

  await guardian.page.reload();
  const delivered = guardian.page.getByRole('article', { name: '확정된 상담일지' });
  await expect(delivered.getByText('매트로 가는 연습을 안내했습니다')).toBeVisible();
  await expect(delivered.getByText('[시험 관찰] 사진 1장을 받았습니다.').first()).toBeVisible();
  await expect(delivered.getByText('보호자', { exact: true })).toBeVisible();
  await expect(delivered.getByText('미확인').first()).toBeVisible();
  const cited = delivered.getByRole('img', { name: /상담 \d\d:\d\d 장면/ }).first();
  await expect.poll(() => cited.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
});

test('the guardian can reach only photos the confirmed note cites', async () => {
  const { trainer, guardian, id, read } = await finishedCall();
  const before = await read();
  const frames = before.scenes.flatMap(scene => scene.frameIds);
  expect(frames.length).toBeGreaterThan(0);
  expect((await guardian.page.request.get(`${server.origin}/api/coaching/consultations/${id}/frames/${frames[0]}`)).status()).toBe(403);
  const approved = await trainer.page.request.post(`${server.origin}/api/coaching/consultations/${id}/approve`, { headers: { Origin: server.origin }, data: {} });
  expect(approved.status()).toBe(200);
  expect((await guardian.page.request.get(`${server.origin}/api/coaching/consultations/${id}/frames/${frames[0]}`)).status()).toBe(403);
});
