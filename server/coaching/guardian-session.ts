import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

/** The secret lives beside the data so a guardian link keeps working after the server restarts. */
function loadSecret(directory: string) {
  const file = path.join(directory, 'session-secret');
  mkdirSync(directory, { recursive: true });
  try { return readFileSync(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const secret = randomBytes(32).toString('hex');
    writeFileSync(file, secret, { flag: 'wx', mode: 0o600 });
    return secret;
  }
}

export function createGuardianSessions(directory: string, now: () => number = Date.now) {
  const secret = loadSecret(directory);
  const sign = (payload: string) => createHmac('sha256', secret).update(payload).digest('hex');
  return {
    maxAgeMs: SESSION_MS,
    issue(caseId: string, generation: number) {
      const payload = `${caseId}.${generation}.${now() + SESSION_MS}`;
      return `${payload}.${sign(payload)}`;
    },
    read(value: string): { caseId: string; generation: number } | null {
      const parts = value.split('.');
      if (parts.length !== 4) return null;
      const [caseId, generation, expiresAt, signature] = parts;
      const expected = Buffer.from(sign(`${caseId}.${generation}.${expiresAt}`));
      const actual = Buffer.from(signature);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected) || Number(expiresAt) < now()) return null;
      return { caseId, generation: Number(generation) };
    },
  };
}
export type GuardianSessions = ReturnType<typeof createGuardianSessions>;
