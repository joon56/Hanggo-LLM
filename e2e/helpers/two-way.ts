import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, expect, type Browser, type Page } from '@playwright/test';

export const PASSWORD = 'e2e-only-password-1234';
const MEDIA = path.resolve('.tmp/e2e-media');

/** Generated at run time so no binary media lives in the repository. Each role gets a different picture and tone. */
export function ensureMedia() {
  mkdirSync(MEDIA, { recursive: true });
  const make = (file: string, args: string[]) => { if (!existsSync(path.join(MEDIA, file))) execFileSync('ffmpeg', ['-v', 'error', '-nostdin', '-y', ...args, path.join(MEDIA, file)], { windowsHide: true }); };
  make('guardian.y4m', ['-f', 'lavfi', '-i', 'testsrc2=size=480x270:rate=15', '-t', '4', '-pix_fmt', 'yuv420p']);
  make('trainer.y4m', ['-f', 'lavfi', '-i', 'smptebars=size=480x270:rate=15', '-t', '4', '-pix_fmt', 'yuv420p']);
  make('guardian.wav', ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '6', '-ac', '1']);
  make('trainer.wav', ['-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000', '-t', '6', '-ac', '1']);
}

export type TestServer = { origin: string; stop(): Promise<void> };
export async function startServer(port: number): Promise<TestServer> {
  if (!existsSync('dist/index.html')) throw new Error('Run npm run build before this test.');
  const home = mkdtempSync(path.join(tmpdir(), 'hanggo-e2e-'));
  const origin = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn(process.execPath, ['server/index.ts'], { stdio: 'ignore', windowsHide: true,
    env: { ...process.env, HANGGO_HOME: home, APP_ACCESS_PASSWORD: PASSWORD, PORT: String(port), HOST: '127.0.0.1', PUBLIC_ORIGIN: origin, AI_ENABLED: 'false', TURN_URLS: '', TURN_USERNAME: '', TURN_CREDENTIAL: '' } });
  const deadline = Date.now() + 20_000;
  while (true) {
    if (child.exitCode !== null) throw new Error(`Server exited with ${child.exitCode}.`);
    const ready = await fetch(`${origin}/api/health`).then(response => response.ok, () => false);
    if (ready) break;
    if (Date.now() > deadline) { child.kill(); throw new Error('Server did not start.'); }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return { origin, async stop() {
    await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill(); });
    rmSync(home, { recursive: true, force: true });
  } };
}

export type Participant = { browser: Browser; page: Page };
export async function launch(role: 'guardian' | 'trainer', options: { noCamera?: boolean } = {}): Promise<Participant> {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${path.join(MEDIA, `${role}.y4m`)}`, `--use-file-for-fake-audio-capture=${path.join(MEDIA, `${role}.wav`)}`, '--autoplay-policy=no-user-gesture-required'] });
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 700 } })).newPage();
  page.on('dialog', dialog => void dialog.accept());
  await page.addInitScript(() => {
    // Automation cannot pick from the browser's screen picker, so a canvas stands in for the chosen display.
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const context = canvas.getContext('2d')!; let frame = 0;
      setInterval(() => { context.fillStyle = `hsl(${frame++ % 360} 70% 50%)`; context.fillRect(0, 0, 640, 360); }, 50);
      return canvas.captureStream(15);
    };
  });
  if (options.noCamera) await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      if (constraints?.video) throw new DOMException('No camera', 'NotFoundError');
      return original(constraints);
    };
  });
  return { browser, page };
}

export const room = (page: Page) => page.locator('[data-call-status]');
const number = async (page: Page, attribute: string) => Number(await room(page).getAttribute(attribute));

export async function createCaseAsTrainer(page: Page, origin: string, petName = '초코') {
  await page.goto(`${origin}/coaching`);
  const password = page.getByLabel('접근 비밀번호');
  await expect(password.or(page.getByLabel('반려동물 이름'))).toBeVisible();
  if (await password.isVisible()) { await password.fill(PASSWORD); await page.getByRole('button', { name: '로그인' }).click(); }
  await page.getByLabel('반려동물 이름').fill(petName);
  await page.getByLabel('보호자 이름').fill('가상 보호자');
  await page.getByLabel('훈련사 이름').fill('가상 훈련사');
  await page.getByRole('button', { name: '상담 사례 만들기' }).click();
  return page.getByLabel('보호자 초대 링크').inputValue();
}

export async function enterAsTrainer(page: Page, petName = '초코', consent = false) {
  await page.getByRole('button', { name: `${petName} 상담 시작` }).click();
  await page.waitForURL(/\/room\//);
  if (consent) await page.getByLabel(/AI 받아쓰기와 장면 저장에 동의합니다/).check();
  await page.getByRole('button', { name: '입장' }).click();
  await expect(room(page)).toBeVisible();
}
export async function joinAsGuardian(page: Page, invite: string) {
  await page.goto(invite);
  await page.getByRole('button', { name: '상담 입장 준비' }).click();
  await page.waitForURL(/\/guardian$/);
}
export async function enterAsGuardian(page: Page, consent = false) {
  await page.getByRole('button', { name: '상담 입장', exact: true }).click();
  await page.waitForURL(/\/room\//);
  if (consent) await page.getByLabel(/AI 받아쓰기와 장면 저장에 동의합니다/).check();
  await page.getByRole('button', { name: '입장' }).click();
  await expect(room(page)).toBeVisible();
}

export async function expectFlowing(page: Page) {
  await expect(room(page)).toHaveAttribute('data-call-status', 'connected', { timeout: 20_000 });
  const frames = await number(page, 'data-inbound-video-frames');
  const energy = await number(page, 'data-inbound-audio-energy');
  await expect.poll(() => number(page, 'data-inbound-video-frames'), { timeout: 15_000 }).toBeGreaterThan(frames + 5);
  await expect.poll(() => number(page, 'data-inbound-audio-energy'), { timeout: 15_000 }).toBeGreaterThan(energy);
}
export const audioEnergy = (page: Page) => number(page, 'data-inbound-audio-energy');
export const videoFrames = (page: Page) => number(page, 'data-inbound-video-frames');
