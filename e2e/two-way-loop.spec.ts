import { expect, test } from '@playwright/test';
import { STUB_TEXT } from '../server/ai/speech/stub';
import type { Consultation } from '../src/domain/coaching';
import { createCaseAsTrainer, enterAsGuardian, enterAsTrainer, ensureMedia, joinAsGuardian, launch, room, startServer, type Participant, type TestServer } from './helpers/two-way';

// The coaching loop across two sessions, with stub AI: a task given in the first call reaches the next call's brief with the guardian's records.
test.describe.configure({ mode: 'serial', timeout: 240_000 });
let server: TestServer;
const opened: Participant[] = [];
test.beforeAll(() => { ensureMedia(); });
test.beforeEach(async () => { server = await startServer(3380, { speech: 'stub' }); });
test.afterEach(async () => {
  for (const participant of opened.splice(0)) await participant.browser.close();
  await server.stop();
});

test('the next session brief shows the last tasks and what the guardian recorded, with evidence', async () => {
  const trainer = await launch('trainer'); const guardian = await launch('guardian');
  opened.push(trainer, guardian);
  const invite = await createCaseAsTrainer(trainer.page, server.origin);
  await joinAsGuardian(guardian.page, invite);

  // First session.
  await enterAsTrainer(trainer.page);
  await guardian.page.reload();
  await enterAsGuardian(guardian.page);
  for (const { page } of [trainer, guardian]) await page.getByRole('button', { name: '기록 동의', exact: true }).click();
  await expect(room(trainer.page)).toHaveAttribute('data-recording', 'true');
  const firstId = /\/room\/([^/?]+)/.exec(trainer.page.url())![1];
  const read = async () => (await trainer.page.request.get(`${server.origin}/api/coaching/consultations/${firstId}`)).json() as Promise<Consultation>;
  await expect.poll(async () => new Set((await read()).segments.filter(item => item.state === 'complete').map(item => item.speaker)).size, { timeout: 60_000 }).toBe(2);
  await trainer.page.getByRole('button', { name: '상담 종료' }).click();
  await trainer.page.waitForURL(/\/coaching$/);
  await guardian.page.waitForURL(/\/guardian$/);

  // Before anything is confirmed there is no last task to report.
  await expect(trainer.page.getByRole('button', { name: '검토하기' })).toBeVisible({ timeout: 60_000 });
  await trainer.page.getByRole('button', { name: '검토하기' }).click();
  await trainer.page.getByRole('button', { name: '확정하고 보호자에게 전달' }).click();
  await expect(trainer.page.getByText('확정해 보호자에게 전달했습니다.')).toBeVisible();

  // The guardian records how the task went and adds a daily log.
  await guardian.page.reload();
  const taskText = STUB_TEXT.trainer;
  await guardian.page.getByLabel(`${taskText} 메모`).fill('소리를 줄이니 매트로 갔어요');
  await guardian.page.getByRole('button', { name: '했어요', exact: true }).click();
  await expect(guardian.page.getByRole('list', { name: `${taskText} 수행 기록` })).toContainText('완료 · 소리를 줄이니 매트로 갔어요');
  await guardian.page.getByRole('button', { name: '못 했어요' }).click();
  await expect(guardian.page.getByRole('list', { name: `${taskText} 수행 기록` }).getByRole('listitem')).toHaveCount(2);
  await guardian.page.getByLabel('일상 기록 내용').fill('오늘 아침 산책에서 다른 개를 보고 짖었어요');
  await guardian.page.getByRole('button', { name: '내용 확인' }).click();
  const when = guardian.page.getByLabel('언제였나요');
  await expect(when).toBeVisible({ timeout: 60_000 });
  const today = await when.getAttribute('max');
  await when.fill(today!);
  await guardian.page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(guardian.page.getByText(/저장했습니다/)).toBeVisible();

  // The brief is the trainer's alone.
  const caseId = (await read()).caseId;
  expect((await guardian.page.request.get(`${server.origin}/api/coaching/cases/${caseId}/brief`)).status()).toBe(403);

  // The next session starts from that brief.
  await trainer.page.goto(`${server.origin}/coaching`);
  await trainer.page.getByRole('button', { name: '초코 상담 시작' }).click();
  await trainer.page.waitForURL(/\/room\//);
  const brief = trainer.page.getByRole('region', { name: '상담 전 브리핑' });
  await expect(brief).toContainText('이전 상담 과제와 수행 기록');
  await expect(brief).toContainText('완료 1회');
  await expect(brief).toContainText('못 함 1회');
  await expect(brief).toContainText(taskText);
  const tasks = brief.locator('li').filter({ hasText: '이전 상담 과제와 수행 기록' }).first();
  await tasks.getByRole('button', { name: /근거 \d+건/ }).click();
  await expect(tasks).toContainText('소리를 줄이니 매트로 갔어요');
  await expect(tasks).toContainText(/상담 \d\d:\d\d · “\[시험 전사\]/);
  await expect(brief).toContainText('오늘 아침 산책에서 다른 개를 보고 짖었어요');
  await guardian.page.reload();
  await expect(guardian.page.getByRole('region', { name: '상담 전 브리핑' })).toHaveCount(0);
});
