import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/session', async route => {
    await route.fulfill({ json: { authenticated: true, requirePassword: false, aiEnabled: false, configured: false, textModel: '', sttModel: '' } });
  });
});

test('데모 입력·검토·승인·재열람·다운로드·삭제', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '대화의 끝에서, 기록의 시작.' })).toBeVisible();
  await page.screenshot({ path: '.tmp/desktop-initial.png', fullPage: true });
  await page.getByRole('button', { name: '예시 불러오기' }).click();
  await page.getByRole('button', { name: '일지 초안 만들기' }).click();
  await expect(page.getByRole('button', { name: '승인하고 저장' })).toBeDisabled();
  await page.getByRole('button', { name: '원문 근거' }).first().click();
  await expect(page.getByText('선택한 항목의 원문 근거')).toBeVisible();
  await page.getByRole('checkbox', { name: /원문과 일지를 확인/ }).check();
  await page.getByRole('button', { name: '승인하고 저장' }).click();
  await expect(page.getByText('이 브라우저에 저장했습니다.')).toBeVisible();
  await page.screenshot({ path: '.tmp/desktop-approved.png', fullPage: true });
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'JSON 다운로드' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^hanggo-note-.*\.json$/);
  await page.reload();
  await page.getByRole('button', { name: /초코 .* 기록 열기/ }).click();
  await expect(page.getByRole('heading', { name: '승인한 상담일지' })).toBeVisible();
  await page.getByRole('button', { name: '초코 기록 삭제' }).click();
  await page.getByRole('button', { name: '삭제', exact: true }).click();
  await expect(page.getByText('이 브라우저에서 기록을 삭제했습니다.')).toBeVisible();
  await expect(page.getByRole('button', { name: /초코 .* 기록 열기/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('모바일 편집과 안전 검토', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: '직접 입력하기' }).click();
  await page.getByLabel('상담 요약 원문').fill('초코가 다리를 절뚝거려요. 이번 주 과제는 산책 30분을 하기로 했습니다.');
  await page.getByRole('button', { name: '일지 초안 만들기' }).click();
  await expect(page.getByText('동물병원 확인이 먼저 필요한 신호가 있습니다.')).toBeVisible();
  await expect(page.getByText('안전 확인 후 훈련사가 결정합니다.')).toBeVisible();
  await page.screenshot({ path: '.tmp/mobile-review.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByLabel('상담 요약 원문').fill('상담 원문을 수정했습니다.');
  await expect(page.getByRole('button', { name: '승인하고 저장' })).toHaveCount(0);
  await expect(page.getByText('원문이 바뀌었습니다. 일지 초안을 다시 만들어 주세요.')).toBeVisible();
});

test('마이크 거부 시 텍스트 입력을 안내한다', async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Denied', 'NotAllowedError'); };
  });
  await page.goto('/');
  await page.getByRole('button', { name: '녹음 시작' }).click();
  await expect(page.getByText('마이크를 사용할 수 없습니다. 브라우저 권한을 확인하거나 텍스트로 입력해 주세요.')).toBeVisible();
  await expect(page.getByRole('button', { name: '직접 입력하기' })).toBeEnabled();
});

test('브라우저 녹음·재생·초기화, 받아쓰기 자동 생성 없음', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '녹음 시작' }).click();
  await expect(page.getByText('요약을 듣고 있어요')).toBeVisible();
  await expect(page.locator('.record-timer')).toContainText('00:03', { timeout: 10_000 });
  await page.getByRole('button', { name: '녹음 정지' }).click();
  await expect(page.getByText('녹음을 다시 들어보세요')).toBeVisible();
  await expect(page.getByLabel('상담 요약 녹음 재생')).toHaveAttribute('src', /^blob:/);
  await expect(page.getByLabel('상담 요약 원문')).toHaveValue('');
  await expect(page.getByRole('button', { name: '일지 초안 만들기' })).toBeDisabled();
  await page.getByRole('button', { name: '새 상담 기록' }).click();
  await expect(page.getByLabel('상담 요약 녹음 재생')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '녹음 시작' })).toBeEnabled();
});

test('AI 초안 성공과 실패를 구분한다', async ({ page }) => {
  await page.route('**/api/session', route => route.fulfill({ json: { authenticated: true, requirePassword: false, aiEnabled: true, configured: true, textModel: 'test-model', sttModel: 'test-stt' } }));
  let fail = false;
  await page.route('**/api/notes', async route => {
    const request = route.request().postDataJSON();
    expect(request.consent).toBe(true);
    if (fail) return route.fulfill({ status: 502, json: { error: 'AI unavailable', code: 'PROVIDER_ERROR', requestId: 'err-1' } });
    const text: string = request.text;
    return route.fulfill({ json: { draft: {
      id: 'draft-1', sourceKind: request.sourceKind, sourceText: text, createdAt: new Date().toISOString(), mode: 'openai',
      safetyFlags: [], methodReview: false, generation: { requestId: 'req-1', model: 'test-model', promptVersion: 'v1', latencyMs: 25, fallbackUsed: false },
      items: [{ id: 'item-1', category: 'owner_report', text: text.split('\n')[0], sourceQuote: text.split('\n')[0], edited: false }],
    }, fallbackUsed: false, requestId: 'req-1', latencyMs: 25, model: 'test-model', warnings: [] } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '예시 불러오기' }).click();
  await expect(page.getByRole('button', { name: '일지 초안 만들기' })).toBeDisabled();
  await page.getByRole('checkbox', { name: /외부 AI/ }).check();
  await page.getByRole('button', { name: '일지 초안 만들기' }).click();
  await expect(page.getByText('AI 초안', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '새 상담 기록' }).click();
  fail = true;
  await page.getByRole('button', { name: '예시 불러오기' }).click();
  await page.getByRole('checkbox', { name: /외부 AI/ }).check();
  await page.getByRole('button', { name: '일지 초안 만들기' }).click();
  await expect(page.getByText('수동 검토 필요')).toBeVisible();
  await expect(page.getByLabel('상담 요약 원문')).toContainText('보호자는 초코가');
});

test('음성 받아쓰기를 확인한 뒤에만 AI 초안을 요청한다', async ({ page }) => {
  await page.route('**/api/session', route => route.fulfill({ json: { authenticated: true, requirePassword: false, aiEnabled: true, configured: true, textModel: 'test-model', sttModel: 'test-stt' } }));
  await page.route('**/api/transcribe', route => route.fulfill({ json: { text: '초코가 앉았습니다.', requestId: 'stt-1', latencyMs: 20, model: 'test-stt' } }));
  await page.addInitScript(() => {
    AudioContext.prototype.decodeAudioData = async () => ({ numberOfChannels: 1, sampleRate: 10, getChannelData: () => new Float32Array(40).fill(0.2) }) as AudioBuffer;
  });
  await page.goto('/');
  await page.getByRole('checkbox', { name: /외부 AI/ }).check();
  await page.getByRole('button', { name: '녹음 시작' }).click();
  await expect(page.locator('.record-timer')).toContainText('00:03', { timeout: 10_000 });
  await page.getByRole('button', { name: '녹음 정지' }).click();
  await page.getByRole('button', { name: '음성 받아쓰기' }).click();
  await expect(page.getByLabel('상담 요약 원문')).toHaveValue('초코가 앉았습니다.');
  await expect(page.getByRole('button', { name: '일지 초안 만들기' })).toBeDisabled();
  await page.getByRole('checkbox', { name: /받아쓰기 내용을/ }).check();
  await expect(page.getByRole('button', { name: '일지 초안 만들기' })).toBeEnabled();
  await page.getByLabel('상담 요약 원문').fill('초코가 앉았습니다. 수정');
  await expect(page.getByRole('button', { name: '일지 초안 만들기' })).toBeDisabled();
});
