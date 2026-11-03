import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { ensureMedia, PASSWORD, room } from './helpers/two-way';

// A public demo runs in production mode behind an HTTPS tunnel, which this PC cannot open during tests. A local HTTPS proxy stands in for it:
// secure cookies, the production CSP, wss signaling, and uploads through a proxy all behave as they would there. Cloudflare's own handling is not covered.
test.describe.configure({ mode: 'serial', timeout: 120_000 });
const PROXY_PORT = 3530; const APP_PORT = 3531;
const ORIGIN = `https://localhost:${PROXY_PORT}`;
const MEDIA = path.resolve('.tmp/e2e-media');
let child: ChildProcess; let proxy: https.Server; let home: string;
const browsers: Browser[] = [];

function selfSigned(folder: string) {
  const key = path.join(folder, 'key.pem'); const cert = path.join(folder, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-subj', '/CN=localhost', '-days', '2', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore', windowsHide: true });
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

function startProxy(tls: { key: Buffer; cert: Buffer }) {
  const server = https.createServer(tls, (request, response) => {
    const upstream = http.request({ host: '127.0.0.1', port: APP_PORT, path: request.url, method: request.method, headers: { ...request.headers, host: `localhost:${PROXY_PORT}` } }, reply => {
      response.writeHead(reply.statusCode ?? 502, reply.headers); reply.pipe(response);
    });
    upstream.on('error', () => response.destroy());
    request.pipe(upstream);
  });
  server.on('upgrade', (request, socket, head) => {
    const upstream = net.connect(APP_PORT, '127.0.0.1', () => {
      const headers = Object.entries({ ...request.headers, host: `localhost:${PROXY_PORT}` }).map(([name, value]) => `${name}: ${value}`).join('\r\n');
      upstream.write(`${request.method} ${request.url} HTTP/1.1\r\n${headers}\r\n\r\n`); upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
  });
  return new Promise<https.Server>(resolve => server.listen(PROXY_PORT, '127.0.0.1', () => resolve(server)));
}

async function open(role: 'trainer' | 'guardian') {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--ignore-certificate-errors', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${path.join(MEDIA, `${role}.y4m`)}`, `--use-file-for-fake-audio-capture=${path.join(MEDIA, `${role}-speech.wav`)}`, '--autoplay-policy=no-user-gesture-required'] });
  browsers.push(browser);
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1100, height: 700 } });
  const page = await context.newPage();
  page.on('dialog', dialog => void dialog.accept());
  return page;
}
/** A blocked script or connection shows up here first, long before a feature visibly fails. */
function watchPolicy(page: Page) {
  const problems: string[] = [];
  page.on('console', message => { if (/Content Security Policy|violates|Mixed Content/i.test(message.text())) problems.push(message.text()); });
  page.on('pageerror', error => problems.push(error.message));
  return problems;
}

test.beforeAll(async () => {
  ensureMedia();
  if (!existsSync('dist/index.html')) throw new Error('Run npm run build before this test.');
  home = mkdtempSync(path.join(tmpdir(), 'hanggo-production-'));
  proxy = await startProxy(selfSigned(home));
  child = spawn(process.execPath, ['server/index.ts'], { stdio: 'ignore', windowsHide: true, env: { ...process.env, NODE_ENV: 'production', HANGGO_PROFILE: 'tunnel', HANGGO_HOME: home, HOST: '127.0.0.1', PORT: String(APP_PORT), PUBLIC_ORIGIN: ORIGIN, APP_ACCESS_PASSWORD: PASSWORD, AI_ENABLED: 'false', COACHING_GRACE_MS: '1000', TURN_URLS: '', TURN_USERNAME: '', TURN_CREDENTIAL: '' } });
  await expect.poll(() => fetch(`http://127.0.0.1:${APP_PORT}/api/health`, { headers: { host: `localhost:${PROXY_PORT}` } }).then(response => response.status, () => 0), { timeout: 20_000 }).not.toBe(0);
});
test.afterAll(async () => {
  for (const browser of browsers.splice(0)) await browser.close();
  child?.kill();
  await new Promise(resolve => proxy?.close(resolve));
  if (home) rmSync(home, { recursive: true, force: true });
});

test('the whole path works in production mode behind HTTPS, under its security headers', async () => {
  const trainer = await open('trainer'); const guardian = await open('guardian');
  const problems = [watchPolicy(trainer), watchPolicy(guardian)];
  const first = await trainer.goto(`${ORIGIN}/coaching`);
  // Antivirus that inspects HTTPS answers 499 to a self-signed certificate. Actions has none, so the check still runs on every push.
  test.skip(first?.status() === 499, 'Local antivirus blocks the self-signed test certificate.');
  await trainer.getByLabel('접근 비밀번호').fill(PASSWORD);
  await trainer.getByRole('button', { name: '로그인' }).click();
  await trainer.getByLabel('반려동물 이름').fill('초코');
  await trainer.getByLabel('보호자 이름').fill('가상 보호자');
  await trainer.getByLabel('훈련사 이름').fill('가상 훈련사');
  await trainer.getByRole('button', { name: '상담 사례 만들기' }).click();
  const invite = await trainer.getByLabel('보호자 초대 링크').inputValue();
  expect(invite.startsWith(ORIGIN)).toBe(true);
  const cookies = await trainer.context().cookies();
  expect(cookies.find(cookie => cookie.name === 'hanggo_session')).toMatchObject({ secure: true, httpOnly: true, sameSite: 'Strict' });

  await guardian.goto(invite);
  await guardian.getByRole('button', { name: '상담 입장 준비' }).click();
  await guardian.waitForURL(/\/guardian$/);
  await trainer.getByRole('button', { name: '초코 상담 시작' }).click();
  await trainer.waitForURL(/\/room\//);
  await trainer.getByRole('button', { name: '입장' }).click();
  await guardian.getByRole('button', { name: '상담 입장', exact: true }).click({ timeout: 15_000 });
  await guardian.waitForURL(/\/room\//);
  await guardian.getByRole('button', { name: '입장' }).click();
  await expect(room(trainer)).toHaveAttribute('data-call-status', 'connected', { timeout: 30_000 });
  await expect.poll(async () => Number(await room(guardian).getAttribute('data-inbound-video-frames')), { timeout: 30_000 }).toBeGreaterThan(5);

  for (const page of [trainer, guardian]) await page.getByRole('button', { name: '기록 동의', exact: true }).click();
  await expect(room(guardian)).toHaveAttribute('data-recording', 'true');
  await guardian.waitForTimeout(7000);
  await guardian.getByRole('button', { name: '캐치' }).click();
  await expect(trainer.getByLabel('장면 메모')).toBeVisible();
  const id = /\/room\/([^/?]+)/.exec(trainer.url())![1];
  await expect.poll(async () => (await (await trainer.request.get(`${ORIGIN}/api/coaching/consultations/${id}`)).json()).moments[0].frameIds.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(6);
  await expect(trainer.getByText(/일부 기록을 보내지 못했습니다/)).toHaveCount(0);

  await trainer.getByRole('button', { name: '상담 종료' }).click();
  await trainer.getByRole('button', { name: '검토하기' }).click({ timeout: 30_000 });
  await trainer.waitForURL(/\/review\//);
  const photo = trainer.getByRole('img', { name: /캐치 \d\d:\d\d 사진/ }).first();
  await expect.poll(() => photo.evaluate((image: HTMLImageElement) => image.naturalWidth), { timeout: 15_000 }).toBeGreaterThan(0);
  await trainer.getByRole('button', { name: '과제 추가' }).click();
  await trainer.getByLabel('과제 내용').fill('매트 연습');
  await trainer.getByRole('button', { name: '확정하고 보호자에게 전달' }).click();
  await expect(trainer.getByText('확정해 보호자에게 전달했습니다.')).toBeVisible();
  await guardian.reload();
  await expect(guardian.getByRole('article', { name: '확정된 상담일지' }).getByText('매트 연습')).toBeVisible();
  expect(problems.flat()).toEqual([]);
});

test('production mode refuses plain cross-site requests and stub AI', async () => {
  const blocked = await fetch(`http://127.0.0.1:${APP_PORT}/api/coaching/cases`, { method: 'POST', headers: { host: `localhost:${PROXY_PORT}`, origin: 'https://attacker.example', 'content-type': 'application/json' }, body: '{}' });
  expect(blocked.status).toBe(403);
  const refused = spawn(process.execPath, ['server/index.ts'], { stdio: 'ignore', windowsHide: true, env: { ...process.env, NODE_ENV: 'production', AI_PROVIDER: 'stub', HANGGO_HOME: home, HOST: '127.0.0.1', PORT: '3532', PUBLIC_ORIGIN: ORIGIN, APP_ACCESS_PASSWORD: PASSWORD } });
  const code = await new Promise(resolve => refused.once('exit', resolve));
  expect(code).not.toBe(0);
});
