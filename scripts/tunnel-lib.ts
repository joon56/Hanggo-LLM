import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const MIN_PASSWORD = 16;

export function parseTunnelUrl(line: string): string | null {
  const match = /https:\/\/([a-z0-9-]+)\.trycloudflare\.com\b/.exec(line);
  return match && match[1] !== 'api' ? match[0] : null;
}

/** A public address must never open without a password, so one is created on first use. */
export function ensurePassword(file: string, env: NodeJS.ProcessEnv): { password: string; created: boolean } {
  if ((env.APP_ACCESS_PASSWORD ?? '').length >= MIN_PASSWORD) return { password: env.APP_ACCESS_PASSWORD!, created: false };
  const password = randomBytes(18).toString('base64url');
  const source = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const line = `APP_ACCESS_PASSWORD=${password}`;
  const next = /^APP_ACCESS_PASSWORD=.*$/m.test(source) ? source.replace(/^APP_ACCESS_PASSWORD=.*$/m, line) : `${source}${source && !source.endsWith('\n') ? '\n' : ''}${line}\n`;
  writeFileSync(file, next, { mode: 0o600 });
  return { password, created: true };
}
