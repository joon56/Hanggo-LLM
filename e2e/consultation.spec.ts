import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';
import { readConfig } from '../server/config.ts';
import { createDraft } from '../src/domain/notes.ts';
import { createConsultationVision } from '../server/consultation-vision.ts';

let server: Server; let apiOrigin: string; let directory: string;
let holdVision = false;
const root = resolve('.tmp');
test.beforeAll(async () => {
  directory = await mkdtemp(resolve(root, 'frontend-browser-fixture-'));
  const config = { ...readConfig({ AI_ENABLED: 'true' }), liveConsultationEnabled: true, consultationDirectory: directory };
  const frames = createConsultationVision(config);
  const app = createApp(config, {
    status: async () => ({ configured: true, sttReady: true, statusMessage: '', liveConsultation: { enabled: true, ready: true, model: 'browser-fixture' } }),
    liveSpeech: { prepare: async () => {}, release: async () => {}, transcribe: async () => ({ text: '보호자는 초코가 현관 소리에 짖는다고 말했습니다.', model: 'fixture', latencyMs: 5 }) },
    vision: { model: 'browser-vision-fixture', extractFrames: frames.extractFrames, analyze: async (_frames, signal) => { if (holdVision) await new Promise<void>((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); if (signal.aborted) reject(signal.reason); }); return ['합성 영상에 글자가 보입니다.']; } },
    generate: async text => ({ draft: createDraft(text, 'trainer_summary_voice') }), transcribe: async () => '',
  });
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolveReady => server.once('listening', resolveReady)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture address missing'); apiOrigin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
  await new Promise<void>(resolveClosed => server.close(() => resolveClosed()));
  if (!resolve(directory).startsWith(`${root}${sep}frontend-browser-fixture-`)) throw new Error('Unsafe fixture cleanup path'); await rm(directory, { recursive: true, force: true });
});
test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', async route => { const request = route.request(); const url = new URL(request.url()); const response = await route.fetch({ url: `${apiOrigin}${url.pathname}${url.search}`, headers: { ...request.headers(), origin: 'http://127.0.0.1:5173' } }); await route.fulfill({ response }); });
});
async function syntheticCapture(page: Page, mode: 'valid' | 'denied' | 'no-audio' = 'valid', source: 'camera' | 'tab' = 'tab') {
  await page.addInitScript(({ mode, source }) => {
    const devices = navigator.mediaDevices;
    if (source === 'camera') Object.defineProperty(devices, 'getDisplayMedia', { configurable: true, value: () => { throw new Error('Camera must not request display capture'); } });
    Object.defineProperty(devices, source === 'camera' ? 'getUserMedia' : 'getDisplayMedia', { configurable: true, value: async () => {
      if (mode === 'denied') throw new DOMException('denied', 'NotAllowedError');
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360; const context = canvas.getContext('2d')!;
      const draw = () => { context.fillStyle = '#243022'; context.fillRect(0, 0, 640, 360); context.fillStyle = '#ffffff'; context.font = '28px sans-serif'; context.fillText('합성 상담 영상 · 실제 카메라 아님', 50, 180); };
      draw(); const timer = setInterval(draw, 100); const video = canvas.captureStream(10); const track = video.getVideoTracks()[0]; const settings = track.getSettings.bind(track); track.getSettings = () => ({ ...settings(), displaySurface: 'browser' }); track.addEventListener('ended', () => clearInterval(timer));
      if (mode === 'no-audio') return video;
      const audio = new AudioContext(); const destination = audio.createMediaStreamDestination(); const oscillator = audio.createOscillator(); const gain = audio.createGain(); gain.gain.value = .15; oscillator.frequency.value = 220; oscillator.connect(gain); gain.connect(destination); oscillator.start(); await audio.resume();
      const stream = new MediaStream([...video.getVideoTracks(), ...destination.stream.getAudioTracks()]); (window as unknown as { syntheticStream: MediaStream }).syntheticStream = stream; return stream;
    } });
  }, { mode, source });
}
async function setupForm(page: Page) {
  await page.goto('/'); await page.getByRole('button', { name: '실시간 상담', exact: true }).click(); await page.getByLabel('반려동물 이름', { exact: true }).fill('합성 초코'); await page.getByLabel('훈련사 이름', { exact: true }).fill('가상 훈련사'); await page.getByRole('checkbox', { name: /상담 참여자 동의/ }).check();
}
test('Chrome actual worklet/WebM → persisted API → seekable replay → exact evidence review → delete confirmation', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); await syntheticCapture(page); await setupForm(page);
  await page.getByRole('combobox', { name: '녹화 입력' }).selectOption('tab');
  await page.getByRole('button', { name: '탭 공유·녹화 시작' }).click(); await expect(page.getByText('상담 녹화 중', { exact: true })).toBeVisible(); await expect(page.getByRole('meter', { name: '입력 소리 수준' })).toHaveAttribute('value', /0\.[1-9]/);
  await expect(page.getByRole('button', { name: '상담일지', exact: true })).toBeDisabled(); expect(await page.getByLabel('공유 탭 미리보기').evaluate((video: HTMLVideoElement) => video.muted)).toBe(true);
  await page.getByRole('button', { name: '현재 장면 표시' }).click(); await page.getByLabel('순간 메모', { exact: true }).fill('직접 확인한 합성 장면'); await page.getByRole('button', { name: '순간 메모 저장' }).click();
  await expect(page.getByLabel('받아쓰기 1', { exact: true })).toBeVisible({ timeout: 20000 });
  await page.getByRole('button', { name: '녹화 종료·저장' }).click(); await expect(page.getByText('녹화 저장 완료', { exact: true })).toBeVisible({ timeout: 20000 });
  const video = page.getByLabel('상담 녹화 재생'); await expect(video).toBeVisible(); await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(1);
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.duration)).toBeGreaterThan(9);
  const src = await video.getAttribute('src'); expect(src).toMatch(/^\/api\/consultations\/[^/]+\/recording$/); const range = await page.request.get(`${apiOrigin}${src}`, { headers: { Range: 'bytes=0-99' } }); expect(range.status()).toBe(206);
  await page.getByRole('button', { name: '상담 일지 만들기' }).click(); await expect(page.getByLabel('일지 항목 1', { exact: true })).toBeVisible(); await expect(page.getByRole('heading', { name: '상담 목적·고민' })).toBeVisible();
  const review = page.getByRole('checkbox', { name: '녹화·받아쓰기·모든 일지 항목의 원문 근거를 확인했습니다.' }); await review.check(); const transcript = page.getByLabel('받아쓰기 1', { exact: true }); const persistedText = await transcript.inputValue(); await transcript.fill(`${persistedText} 미저장 수정`); await expect(review).not.toBeChecked(); await expect(review).toBeDisabled(); await expect(page.getByRole('button', { name: '검토 후 확정' })).toBeDisabled(); await expect(page.getByRole('button', { name: '상담 일지 만들기' })).toBeDisabled(); await page.getByRole('button', { name: '받아쓰기 1 수정 취소' }).click(); await expect(transcript).toHaveValue(persistedText); await review.check(); await page.getByRole('button', { name: '검토 후 확정' }).click(); await expect(page.getByText('검토·확정됨', { exact: true })).toBeVisible();
  await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({ path: '.tmp/consultation-desktop.png', fullPage: true });
  const sessions = await (await page.request.get(`${apiOrigin}/api/consultations`)).json(); const session = sessions.sessions.find((item: { metadata: { petName: string } }) => item.metadata.petName === '합성 초코'); expect(session.state).toBe('ready'); expect(session.segments.length).toBeGreaterThanOrEqual(2); expect(session.note.approvedAt).toBeTruthy();
  await page.reload(); await page.getByRole('button', { name: '실시간 상담', exact: true }).click(); await page.getByRole('button', { name: /합성 초코.*열기/ }).click(); await expect(page.getByText('검토·확정됨', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: '.tmp/consultation-mobile.png', fullPage: true });
  page.once('dialog', dialog => dialog.dismiss()); await page.getByRole('button', { name: '합성 초코 상담 삭제' }).click(); await expect(page.getByRole('button', { name: /합성 초코.*열기/ })).toBeVisible(); page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: '합성 초코 상담 삭제' }).click(); await expect(page.getByRole('button', { name: /합성 초코.*열기/ })).toHaveCount(0); expect(errors).toEqual([]);
});
for (const mode of ['denied', 'no-audio'] as const) test(`capture rejection ${mode} leaves server sessions untouched`, async ({ page }) => {
  const before = await (await page.request.get(`${apiOrigin}/api/consultations`)).json(); await syntheticCapture(page, mode); await setupForm(page); await page.getByRole('combobox', { name: '녹화 입력' }).selectOption('tab'); await page.getByRole('button', { name: '탭 공유·녹화 시작' }).click(); await expect(page.getByRole('alert')).toContainText(mode === 'denied' ? '권한' : '탭 오디오'); const after = await (await page.request.get(`${apiOrigin}/api/consultations`)).json(); expect(after.sessions).toHaveLength(before.sessions.length);
});

test('camera plus audio pins moment then persists sampled vision edit review and notes across reload', async ({ page }) => {
  test.setTimeout(60000); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await syntheticCapture(page, 'valid', 'camera'); await setupForm(page); await expect(page.getByRole('combobox', { name: '녹화 입력' })).toHaveValue('camera');
  await page.getByRole('button', { name: '카메라·마이크 녹화 시작' }).click(); await expect(page.getByText('상담 녹화 중', { exact: true })).toBeVisible(); await expect(page.getByLabel('카메라 미리보기')).toBeVisible();
  await expect(page.getByLabel('순간 메모', { exact: true })).toBeDisabled(); await page.getByRole('button', { name: '현재 장면 표시' }).click(); const pinned = Number(await page.getByLabel('순간 시각 · 초').inputValue()) * 1000;
  await page.getByLabel('순간 메모', { exact: true }).fill('메모 작성 전 표시한 순간'); await expect(page.getByLabel('받아쓰기 1', { exact: true })).toBeVisible({ timeout: 20000 }); await page.getByRole('button', { name: '순간 메모 저장' }).click();
  await page.getByRole('button', { name: '녹화 종료·저장' }).click(); await expect(page.getByText('녹화 저장 완료', { exact: true })).toBeVisible({ timeout: 20000 });
  const src = await page.getByLabel('상담 녹화 재생').getAttribute('src'); const id = src!.split('/')[3]; const session = await (await page.request.get(`${apiOrigin}/api/consultations/${id}`)).json(); expect(session.captureSource).toBe('camera'); expect(session.bookmarks[0].atMs).toBe(Math.round(pinned));
  await expect(page.getByRole('button', { name: '상담 일지 만들기' })).toBeDisabled(); holdVision = true;
  await page.getByRole('button', { name: '장면 분석 시작' }).click(); await expect(page.getByRole('button', { name: '장면 분석 취소' })).toBeEnabled();
  await page.reload(); await page.getByRole('button', { name: '실시간 상담', exact: true }).click(); await page.getByRole('button', { name: /합성 초코.*열기/ }).last().click(); await expect(page.getByRole('button', { name: '장면 분석 취소' })).toBeEnabled();
  await page.getByRole('button', { name: '장면 분석 취소' }).click(); holdVision = false; await page.getByRole('button', { name: '장면 분석 다시 시도' }).click(); await expect(page.getByLabel('장면 1 관찰', { exact: true })).toBeVisible({ timeout: 20000 });
  const thumbnail = page.getByRole('img', { name: /장면 1 프레임 1 ·/ }); await thumbnail.scrollIntoViewIfNeeded(); await expect.poll(() => thumbnail.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: '상담 일지 만들기' })).toBeDisabled(); await page.getByRole('button', { name: '장면 관찰 검토 완료' }).click(); await expect(page.getByText('장면 관찰 검토됨', { exact: true })).toBeVisible();
  const scene = page.getByLabel('장면 1 관찰', { exact: true }); await scene.fill('저장 전 수정'); await expect(page.getByRole('button', { name: '장면 관찰 검토 완료' })).toBeDisabled(); await expect(page.getByRole('button', { name: '상담 일지 만들기' })).toBeDisabled();
  await page.getByRole('button', { name: '장면 1 수정 취소' }).click(); await page.getByRole('button', { name: '장면 관찰 검토 완료' }).click();
  await scene.fill('합성 영상의 글자를 확인했습니다.'); await page.getByRole('button', { name: '장면 1 저장' }).click(); await expect(page.getByRole('button', { name: '상담 일지 만들기' })).toBeDisabled(); await page.getByRole('button', { name: '장면 관찰 검토 완료' }).click();
  await page.getByRole('button', { name: '상담 일지 만들기' }).click(); await expect(page.getByLabel('일지 항목 1', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: /장면 관찰 근거/ }).first()).toBeVisible();
  await page.getByRole('checkbox', { name: '녹화·받아쓰기·모든 일지 항목의 원문 근거를 확인했습니다.' }).check(); await page.getByRole('button', { name: '검토 후 확정' }).click(); await expect(page.getByText('검토·확정됨', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: '.tmp/camera-frontend-mobile.png', fullPage: true }); expect(errors).toEqual([]);
});
