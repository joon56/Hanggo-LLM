// @vitest-environment node
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

type Entry = { id: string; kind: string; group: string; url: string; size: number; sha256: string; dest: string; extract?: string };
const manifest = JSON.parse(readFileSync(new URL('../scripts/models.manifest.json', import.meta.url), 'utf8')) as Entry[];

it('lists unique ids', () => {
  expect(manifest.length).toBeGreaterThan(0);
  expect(new Set(manifest.map(entry => entry.id)).size).toBe(manifest.length);
});
it('pins every download to https, size, and SHA-256', () => {
  for (const entry of manifest) {
    expect(entry.url, entry.id).toMatch(/^https:\/\//);
    expect(entry.size, entry.id).toBeGreaterThan(0);
    expect(entry.sha256, entry.id).toMatch(/^[0-9a-f]{64}$/);
  }
});
it('pins every URL to an immutable revision or release tag', () => {
  for (const entry of manifest) {
    expect(entry.url, entry.id).toMatch(/\/resolve\/[0-9a-f]{40}\/|\/releases\/download\/[^/]+\//);
    expect(entry.url, entry.id).not.toMatch(/\/resolve\/main\/|\/latest\//);
  }
});
it('keeps destinations relative to HANGGO_HOME', () => {
  for (const entry of manifest) {
    expect(entry.dest, entry.id).toMatch(/^(runtime|models)\//);
    expect(entry.dest.split('/'), entry.id).not.toContain('..');
  }
});
it('uses only known kinds, groups, and archive types', () => {
  for (const entry of manifest) {
    expect(['runtime', 'stt', 'llm', 'mmproj'], entry.id).toContain(entry.kind);
    expect(['core', 'compare', 'ci'], entry.id).toContain(entry.group);
    if (entry.extract) { expect(['zip', 'targz'], entry.id).toContain(entry.extract); expect(entry.kind, entry.id).toBe('runtime'); }
  }
});
