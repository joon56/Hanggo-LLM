import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/session', route => route.fulfill({ json: { authenticated: true, requirePassword: false, aiEnabled: false, configured: false, textModel: '', sttModel: '', features: { ownerLog: true, brief: true, shelter: true } } }));
  await page.route('**/api/lessons', route => route.fulfill({ json: { lessons: [] } }));
  await page.addInitScript(() => {
    const pet = { id: 'brief-pet', name: '시연초코', nicknames: [] };
    const now = new Date().toISOString();
    const quote = '초인종 소리에 3분 짖었어요. 매트로 이동시킨 뒤 짖음이 줄었어요.';
    const records = [1, 2, 3].map(day => ({ id: `log-${day}`, savedAt: now, draft: {
      id: `draft-${day}`, sourceText: quote, sourceKind: 'nl_log_text', pets: [pet], now, timeZone: 'Asia/Seoul', safetyFlags: [], clarification: null, mode: 'manual',
      events: [{ id: `event-${day}`, petId: pet.id, type: 'bark', occurredAt: new Date(Date.now() - day * 86400000).toISOString(), timeHint: null, durationMin: 3, trigger: 'doorbell', intervention: '매트로 이동', outcome: 'reduced', details: { amountText: null, isTreat: null, excretionKinds: [], placeText: null }, sourceQuote: quote, edited: false }],
    } }));
    localStorage.setItem('hanggo:pets', JSON.stringify({ version: 1, items: [pet] }));
    localStorage.setItem('hanggo:owner-logs', JSON.stringify({ version: 1, items: records }));
  });
});

test('핵심 3줄과 원문·구체적인 질문을 확인하고 내보낸다', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: '상담 전 브리핑', exact: true }).click();
  await expect(page.getByLabel('확정 상담일지 (선택 사항)')).toHaveValue('');
  await page.getByRole('button', { name: '기록으로 브리핑 만들기' }).click();
  const summary = page.locator('.ws-brief-section').filter({ has: page.getByRole('heading', { name: '핵심 3줄', exact: true }) });
  await expect(summary).toContainText('핵심 상황');
  await expect(summary).toContainText('변화·주의점');
  await expect(summary).toContainText('이번 상담에서 확인할 일');
  await summary.getByRole('button', { name: '근거 보기' }).first().click();
  await expect(page.locator('.ws-evidence')).toContainText('초인종');
  await expect(page.locator('.ws-evidence')).toContainText('매트로 이동');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'JSON 내보내기', exact: true }).click();
  const file = await (await download).path();
  const draft = JSON.parse(await readFile(file!, 'utf8'));
  expect(draft.summary).toHaveLength(3);
  expect(draft.questionsForOwner.length).toBeGreaterThan(0);
  expect(draft.questionsForOwner.length).toBeLessThanOrEqual(3);
  expect(draft.questionsForOwner.map((item: {text: string}) => item.text).join(' ')).toMatch(/초인종|매트/);
  expect(draft.sources.some((source: {date: string | null; sourceQuote: string}) => source.date && source.sourceQuote.includes('초인종'))).toBe(true);
  expect(draft.consultation).toBeUndefined();
  expect(errors).toEqual([]);
});

test('기록이 없으면 핵심 3줄에 부족한 자료를 표시한다', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('hanggo:owner-logs', JSON.stringify({ version: 1, items: [] })));
  await page.getByRole('button', { name: '상담 전 브리핑', exact: true }).click();
  await page.getByRole('button', { name: '기록으로 브리핑 만들기' }).click();
  const summary = page.locator('.ws-brief-section').filter({ has: page.getByRole('heading', { name: '핵심 3줄', exact: true }) });
  await expect(summary).toContainText('핵심 상황');
  await expect(summary).toContainText(/부족|없|미확인/);
  await expect(summary).not.toContainText('초인종');
});
