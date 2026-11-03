// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ensurePassword, parseTunnelUrl } from '../scripts/tunnel-lib.ts';

const directories: string[] = [];
const directory = () => { const value = mkdtempSync(path.join(tmpdir(), 'hanggo-tunnel-')); directories.push(value); return value; };
afterEach(() => { for (const value of directories.splice(0)) rmSync(value, { recursive: true, force: true }); });

it('finds the quick tunnel address in cloudflared output', () => {
  expect(parseTunnelUrl('2026-11-03T10:00:00Z INF |  https://calm-river-demo.trycloudflare.com   |')).toBe('https://calm-river-demo.trycloudflare.com');
  expect(parseTunnelUrl('2026-11-03T10:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...')).toBeNull();
  expect(parseTunnelUrl('see https://api.trycloudflare.com/tunnel for details')).toBeNull();
});
it('keeps an existing long password', () => {
  const file = path.join(directory(), 'secrets.env');
  writeFileSync(file, 'APP_ACCESS_PASSWORD=already-long-enough-1234\n');
  expect(ensurePassword(file, { APP_ACCESS_PASSWORD: 'already-long-enough-1234' })).toEqual({ password: 'already-long-enough-1234', created: false });
  expect(readFileSync(file, 'utf8')).toBe('APP_ACCESS_PASSWORD=already-long-enough-1234\n');
});
it('creates a strong password when none exists and fills the blank line', () => {
  const file = path.join(directory(), 'secrets.env');
  writeFileSync(file, '# note\nAPP_ACCESS_PASSWORD=\nTURN_URLS=turn:relay.example:3478\n');
  const result = ensurePassword(file, {});
  expect(result.created).toBe(true);
  expect(result.password.length).toBeGreaterThanOrEqual(24);
  expect(readFileSync(file, 'utf8')).toBe(`# note\nAPP_ACCESS_PASSWORD=${result.password}\nTURN_URLS=turn:relay.example:3478\n`);
});
it('appends the password when the key is absent and creates the file if needed', () => {
  const folder = directory();
  const existing = path.join(folder, 'existing.env');
  writeFileSync(existing, 'TURN_URLS=\n');
  const first = ensurePassword(existing, {});
  expect(readFileSync(existing, 'utf8')).toBe(`TURN_URLS=\nAPP_ACCESS_PASSWORD=${first.password}\n`);
  const missing = path.join(folder, 'missing.env');
  const second = ensurePassword(missing, {});
  expect(readFileSync(missing, 'utf8')).toBe(`APP_ACCESS_PASSWORD=${second.password}\n`);
});
it('replaces a password that is too short for public use', () => {
  const file = path.join(directory(), 'secrets.env');
  writeFileSync(file, 'APP_ACCESS_PASSWORD=short\n');
  const result = ensurePassword(file, { APP_ACCESS_PASSWORD: 'short' });
  expect(result.created).toBe(true);
  expect(readFileSync(file, 'utf8')).toBe(`APP_ACCESS_PASSWORD=${result.password}\n`);
});
