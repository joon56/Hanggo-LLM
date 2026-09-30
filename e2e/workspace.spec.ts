import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/lessons', route => route.fulfill({ json: { lessons: [] } }));
  await page.route('**/api/session', route => route.fulfill({ json: { authenticated: true, requirePassword: false, aiEnabled: false, configured: false, textModel: '', sttModel: '', features: { ownerLog: true, brief: true, shelter: true } } }));
});

test('보호자 기록 저장→상담 전 브리핑 근거→삭제 확인', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: '보호자 일상 기록', exact: true }).click();
  await page.getByLabel('이름', { exact: true }).fill('초코');
  await page.getByRole('button', { name: '등록', exact: true }).click();
  await page.getByLabel('원문 또는 받아쓰기').fill('초코 산책 30분');
  await page.getByRole('button', { name: '수동 검토 초안 만들기' }).click();
  await page.getByRole('combobox', { name: '유형', exact: true }).selectOption('walk');
  const yesterday = new Date(Date.now() - 86400000).toLocaleString('sv-SE').slice(0, 16).replace(' ', 'T');
  await page.getByLabel('발생 시각', { exact: true }).fill(yesterday);
  await page.getByLabel('지속 시간 · 분').fill('30');
  await page.getByRole('checkbox', { name: '원문과 사건 내용을 확인했습니다.' }).check();
  await page.getByRole('button', { name: '검토 후 저장' }).click();
  await expect(page.getByText('이 브라우저에 저장했습니다.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '상담 전 브리핑', exact: true }).click();
  await page.getByRole('button', { name: '기록으로 브리핑 만들기' }).click();
  await expect(page.getByText(/기록 부족:/)).toBeVisible();
  await page.locator('.ws-brief-section').getByRole('button', { name: '근거 보기' }).first().click();
  await expect(page.locator('.ws-evidence')).toContainText('초코 산책 30분');
  await page.screenshot({ path: '.tmp/workspace-brief.png', fullPage: true });
  await page.getByRole('button', { name: '보호자 일상 기록', exact: true }).click();
  await page.locator('.ws-history').getByRole('button', { name: '열기' }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'JSON 내보내기', exact: true }).click();
  expect((await downloadPromise).suggestedFilename()).toMatch(/^hanggo-owner-/);
  page.once('dialog', d => d.dismiss());
  await page.locator('.ws-history').getByRole('button', { name: '삭제', exact: true }).click();
  await expect(page.locator('.ws-history-item')).toHaveCount(1);
  page.once('dialog', d => d.accept());
  await page.locator('.ws-history').getByRole('button', { name: '삭제', exact: true }).click();
  await expect(page.locator('.ws-history-item')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('보호소 주의사항을 소개에 유지하고 직원 확인 뒤 저장', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: '보호소 프로필', exact: true }).click();
  await page.getByLabel('동물 이름').fill('보리');
  await page.getByLabel('관찰 내용').fill('사람에게 다가왔습니다. 다른 개를 보면 짖음.');
  await page.getByRole('button', { name: '수동 검토 초안 만들기' }).click();
  await expect(page.getByText('다른 개: 주의 관찰', { exact: true })).toBeVisible();
  await expect(page.locator('.ws-box').filter({ has: page.getByRole('heading', { name: '입양 소개 · 긍정 관찰' }) })).toContainText('다른 개를 보면 짖음');
  await page.getByLabel('확정 직원 이름').fill('가상 직원');
  await expect(page.getByRole('button', { name: '프로필 확정·저장' })).toBeDisabled();
  await page.getByRole('checkbox', { name: '메모와 모든 관찰·주의 사항을 확인했습니다.' }).check();
  await page.getByRole('button', { name: '프로필 확정·저장' }).click();
  await expect(page.getByText('이 브라우저에 프로필을 저장했습니다. 외부에 공개되지 않습니다.')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.tmp/workspace-shelter-mobile.png', fullPage: true });
  await page.reload();
  await page.getByRole('button', { name: '보호소 프로필', exact: true }).click();
  await page.locator('.ws-history').getByRole('button', { name: '열기' }).click();
  await expect(page.getByText('확정됨', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('보호자 음성 받아쓰기 확인 전 사건 생성 차단', async ({ page }) => {
  await page.route('**/api/session', route => route.fulfill({ json: { authenticated: true, requirePassword: false, aiEnabled: true, configured: true, textModel: 'test', sttModel: 'test', features: { ownerLog: true, brief: true, shelter: true } } }));
  await page.route('**/api/transcribe', route => route.fulfill({ json: { text: '초코 산책 30분', requestId: 'stt-owner', latencyMs: 10, model: 'test' } }));
  await page.addInitScript(() => { AudioContext.prototype.decodeAudioData = async () => ({ numberOfChannels: 1, sampleRate: 10, getChannelData: () => new Float32Array(40).fill(0.2) }) as AudioBuffer; });
  await page.goto('/');
  await page.getByRole('button', { name: '보호자 일상 기록', exact: true }).click();
  await page.getByLabel('이름', { exact: true }).fill('초코');
  await page.getByRole('button', { name: '등록', exact: true }).click();
  await page.getByRole('button', { name: '음성', exact: true }).click();
  await page.getByRole('checkbox', { name: /이 PC의 로컬 AI 서버/ }).check();
  await page.getByRole('button', { name: '새로 녹음' }).click();
  await expect(page.getByRole('button', { name: '녹음 중지 (3초)' })).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: /녹음 중지/ }).click();
  await page.getByRole('button', { name: '받아쓰기', exact: true }).click();
  await expect(page.getByLabel('원문 또는 받아쓰기')).toHaveValue('초코 산책 30분');
  await expect(page.getByRole('button', { name: 'AI 사건 초안 만들기' })).toBeDisabled();
  await page.getByRole('checkbox', { name: '받아쓰기를 듣고 원문을 확인했습니다.' }).check();
  await expect(page.getByRole('button', { name: 'AI 사건 초안 만들기' })).toBeEnabled();
  await page.getByLabel('원문 또는 받아쓰기').fill('초코 산책 30분 수정');
  await expect(page.getByRole('button', { name: 'AI 사건 초안 만들기' })).toBeDisabled();
});
