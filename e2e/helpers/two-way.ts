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
  // Bursts with pauses, because speech windows are cut at pauses. The pitch says whose microphone a window came from.
  const speech = (frequency: number) => ['-f', 'lavfi', '-i', `aevalsrc='if(lt(mod(t,5),4),0.3*sin(2*PI*${frequency}*t),0)':s=48000:d=20`, '-ac', '1'];
  make('guardian-speech.wav', speech(440));
  make('trainer-speech.wav', speech(880));
}

export type TestServer = { origin: string; stop(): Promise<void> };
export async function startServer(port: number, options: { turn?: boolean; speech?: 'stub' | 'real'; env?: NodeJS.ProcessEnv } = {}): Promise<TestServer> {
  if (!existsSync('dist/index.html')) throw new Error('Run npm run build before this test.');
  const data = mkdtempSync(path.join(tmpdir(), 'hanggo-e2e-'));
  // The real path needs the real models, but its records still go in a throwaway folder.
  const home = options.speech === 'real' ? process.env.HANGGO_HOME! : data;
  const origin = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn(process.execPath, ['server/index.ts'], { stdio: 'ignore', windowsHide: true,
    env: { ...process.env, HANGGO_HOME: home, COACHING_DIRECTORY: path.join(data, 'coaching'), APP_ACCESS_PASSWORD: PASSWORD, PORT: String(port), HOST: '127.0.0.1', PUBLIC_ORIGIN: origin, COACHING_GRACE_MS: '3000', AI_ENABLED: options.speech ? 'true' : 'false', ...(options.speech === 'stub' ? { AI_PROVIDER: 'stub' } : {}), ...(options.turn ? {} : { TURN_URLS: '', TURN_USERNAME: '', TURN_CREDENTIAL: '' }), ...options.env } });
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
    rmSync(data, { recursive: true, force: true });
  } };
}

export type Participant = { browser: Browser; page: Page };
export async function launch(role: 'guardian' | 'trainer', options: { noCamera?: boolean; holdMicrophone?: boolean; audioFile?: string; videoFile?: string; recordVideoDir?: string; viewport?: { width: number; height: number } } = {}): Promise<Participant> {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${options.videoFile ?? path.join(MEDIA, `${role}.y4m`)}`, `--use-file-for-fake-audio-capture=${options.audioFile ?? path.join(MEDIA, `${role}-speech.wav`)}`, '--autoplay-policy=no-user-gesture-required'] });
  const viewport = options.viewport ?? { width: 1100, height: 700 };
  const page = await (await browser.newContext({ viewport, ...(options.recordVideoDir ? { recordVideo: { dir: options.recordVideoDir, size: viewport } } : {}) })).newPage();
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
  if (options.holdMicrophone) await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const opened = new Promise<void>(resolve => { (window as unknown as { openMicrophone(): void }).openMicrophone = resolve; });
    navigator.mediaDevices.getUserMedia = async constraints => { await opened; return original(constraints); };
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

export async function createCaseAsTrainer(page: Page, origin: string, petName = '초코', password_ = PASSWORD) {
  await page.goto(`${origin}/coaching`);
  const password = page.getByLabel('접근 비밀번호');
  await expect(password.or(page.getByLabel('반려동물 이름'))).toBeVisible();
  if (await password.isVisible()) { await password.fill(password_); await page.getByRole('button', { name: '로그인' }).click(); }
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

/**
 * Goes through the real buttons, with both microphones held shut until both people reach their entry screen.
 * A fake microphone starts playing its file the moment it opens, so opening them one after the other
 * would put one person's lines seconds ahead of the other's. Needs holdMicrophone on both.
 */
export async function enterTogether(trainer: Page, guardian: Page, petName = '초코') {
  await trainer.getByRole('button', { name: `${petName} 상담 시작` }).click();
  await trainer.waitForURL(/\/room\//);
  await guardian.reload();
  await guardian.getByRole('button', { name: '상담 입장', exact: true }).click();
  await guardian.waitForURL(/\/room\//);
  await Promise.all([trainer, guardian].map(page => page.evaluate(() => (window as unknown as { openMicrophone(): void }).openMicrophone())));
  for (const page of [trainer, guardian]) { await page.getByRole('button', { name: '입장' }).click(); await expect(room(page)).toBeVisible(); }
  return /\/room\/([^/?]+)/.exec(trainer.url())![1];
}

/** Ends the case's open consultation and deletes the case, for checks that run on a server someone is about to use. */
export async function removeCase(page: Page, origin: string, petName: string) {
  const headers = { Origin: origin };
  const { cases } = await (await page.request.get(`${origin}/api/coaching/cases`)).json() as { cases: { id: string; petName: string }[] };
  const { id } = cases.find(item => item.petName === petName)!;
  const { consultations } = await (await page.request.get(`${origin}/api/coaching/cases/${id}`)).json() as { consultations: { id: string; state: string }[] };
  for (const item of consultations) if (item.state === 'live') await page.request.post(`${origin}/api/coaching/consultations/${item.id}/end`, { headers, data: {} });
  // The server refuses while the consultation is still being organized.
  await expect.poll(async () => (await page.request.delete(`${origin}/api/coaching/cases/${id}`, { headers })).status(), { timeout: 120_000, intervals: [2000] }).toBe(204);
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
