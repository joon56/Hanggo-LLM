// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLessonCatalog } from './lessons.ts';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
it('has no invented default catalog', () => { expect(loadLessonCatalog()).toEqual([]); });
it('rejects missing and malformed catalog files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hanggo-lessons-')); dirs.push(dir);
  expect(() => loadLessonCatalog(join(dir, 'missing.json'))).toThrow();
  const path = join(dir, 'catalog.json'); writeFileSync(path, '{}'); expect(() => loadLessonCatalog(path)).toThrow();
  writeFileSync(path, '[]'); expect(loadLessonCatalog(path)).toEqual([]);
});
