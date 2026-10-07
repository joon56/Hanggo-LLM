// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ConsultationStore } from './consultation-store.ts';

const directories: string[] = [];
const metadata = { petName: 'Choco', trainerName: 'Kim', sessionDate: '2026-10-07' };
async function make() { const directory = await mkdtemp(path.join(os.tmpdir(), 'consultation-')); directories.push(directory); return { directory, store: new ConsultationStore(directory) }; }
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

it('persists metadata and recovers capture and queued segments as interrupted', async () => {
  const { directory, store } = await make();
  const session = await store.create(metadata);
  await store.update(session.id, current => { current.segments.push({ id: 'segment-0', sequence: 0, startMs: 0, endMs: 5000, text: '', originalText: '', state: 'queued' }); });
  const recovered = await new ConsultationStore(directory).get(session.id);
  expect(recovered.state).toBe('interrupted');
  expect(recovered.segments[0].state).toBe('failed');
  expect(recovered.errors[0].code).toBe('INTERRUPTED');
  expect(JSON.parse(await readFile(path.join(directory, session.id, 'session.json'), 'utf8')).metadata).toEqual(metadata);
});

it('stores chunks in order and accepts exact retry while rejecting conflicting bytes', async () => {
  const { store } = await make(); const session = await store.create(metadata);
  await expect(store.putChunk(session.id, 'media', 1, Buffer.from('b'))).rejects.toMatchObject({ code: 'SEQUENCE' });
  expect(await store.putChunk(session.id, 'media', 0, Buffer.from('a'))).toBe(true);
  expect(await store.putChunk(session.id, 'media', 0, Buffer.from('a'))).toBe(false);
  await expect(store.putChunk(session.id, 'media', 0, Buffer.from('changed'))).rejects.toMatchObject({ code: 'CONFLICT' });
  await store.putChunk(session.id, 'media', 1, Buffer.from('b'));
  expect((await store.recording(session.id)).toString()).toBe('ab');
  expect((await store.get(session.id)).recordingChunkCount).toBe(2);
});

it('rejects path traversal, invalid sequences and out of range duration', async () => {
  const { store } = await make(); const session = await store.create(metadata);
  await expect(store.get('../escape')).rejects.toMatchObject({ code: 'INPUT' });
  await expect(store.putChunk(session.id, 'audio', -1, Buffer.from('a'))).rejects.toMatchObject({ code: 'SEQUENCE' });
  await expect(store.update(session.id, current => { current.durationMs = 3600001; })).rejects.toMatchObject({ code: 'INPUT' });
  expect((await store.get(session.id)).durationMs).toBe(0);
});

it('serializes updates and deletes only its own session directory', async () => {
  const { store } = await make(); const first = await store.create(metadata); const second = await store.create(metadata);
  await Promise.all(Array.from({ length: 5 }, (_, index) => store.update(first.id, current => { current.bookmarks.push({ id: String(index), atMs: 0, text: 'observed' }); })));
  expect((await store.get(first.id)).bookmarks).toHaveLength(5);
  await store.delete(first.id);
  await expect(store.get(first.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect((await store.list()).map(session => session.id)).toEqual([second.id]);
});

it('isolates malformed metadata so other recoverable sessions remain available', async () => {
  const { directory, store } = await make(); const good = await store.create(metadata); const bad = await store.create(metadata);
  await writeFile(path.join(directory, bad.id, 'session.json'), '{invalid');
  const recovered = new ConsultationStore(directory);
  expect((await recovered.list()).map(session => session.id)).toEqual([good.id]);
});

it('isolates syntactically valid metadata with malformed transcript segments', async () => {
  const { directory, store } = await make(); const good = await store.create(metadata); const bad = await store.create(metadata);
  const filename = path.join(directory, bad.id, 'session.json'); const persisted = JSON.parse(await readFile(filename, 'utf8')); persisted.segments = [null]; await writeFile(filename, JSON.stringify(persisted));
  expect((await new ConsultationStore(directory).list()).map(session => session.id)).toEqual([good.id]);
});
