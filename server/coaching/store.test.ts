// @vitest-environment node
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createFileStore, StoreError } from './store.ts';

const directories: string[] = [];
function directory() { const value = mkdtempSync(path.join(tmpdir(), 'hanggo-store-')); directories.push(value); return value; }
afterEach(() => { for (const value of directories.splice(0)) rmSync(value, { recursive: true, force: true }); });
const input = { petName: '초코', guardianName: '가상 보호자', trainerName: '가상 훈련사' };
const allFiles = (root: string): string[] => readdirSync(root).flatMap(name => { const full = path.join(root, name); return statSync(full).isDirectory() ? allFiles(full) : [full]; });

it('creates a case with a one-time invite whose token is never stored', async () => {
  const root = directory(); const store = createFileStore(root);
  const { case: created, inviteToken } = await store.createCase(input);
  expect(inviteToken).toMatch(/^[0-9a-f]{64}$/);
  expect(created).toMatchObject(input);
  for (const file of allFiles(root)) expect(readFileSync(file, 'utf8')).not.toContain(inviteToken);
});
it('redeems an invite once and rejects reuse', async () => {
  const store = createFileStore(directory());
  const { case: created, inviteToken } = await store.createCase(input);
  await expect(store.redeemInvite(inviteToken)).resolves.toMatchObject({ id: created.id });
  await expect(store.redeemInvite(inviteToken)).rejects.toMatchObject({ code: 'INVITE' });
});
it('rejects unknown tokens', async () => {
  const store = createFileStore(directory());
  await store.createCase(input);
  await expect(store.redeemInvite('f'.repeat(64))).rejects.toMatchObject({ code: 'INVITE' });
  await expect(store.redeemInvite('short')).rejects.toMatchObject({ code: 'INVITE' });
});
it('rejects expired invites', async () => {
  let now = 1_000_000;
  const store = createFileStore(directory(), { now: () => now });
  const { inviteToken } = await store.createCase(input);
  now += 7 * 24 * 60 * 60 * 1000 + 1;
  await expect(store.redeemInvite(inviteToken)).rejects.toMatchObject({ code: 'INVITE' });
});
it('reissuing invalidates the old token and bumps the guardian generation', async () => {
  const store = createFileStore(directory());
  const { case: created, inviteToken } = await store.createCase(input);
  await store.redeemInvite(inviteToken);
  const first = (await store.getCase(created.id)).guardianGeneration;
  const next = await store.reissueInvite(created.id);
  await expect(store.redeemInvite(inviteToken)).rejects.toMatchObject({ code: 'INVITE' });
  await expect(store.redeemInvite(next)).resolves.toMatchObject({ id: created.id });
  expect((await store.getCase(created.id)).guardianGeneration).toBe(first + 1);
});
it('persists across restarts', async () => {
  const root = directory(); const first = createFileStore(root);
  const { case: created } = await first.createCase(input);
  const consultation = await first.createConsultation(created.id);
  const second = createFileStore(root);
  await expect(second.getCase(created.id)).resolves.toMatchObject({ petName: '초코' });
  await expect(second.getConsultation(consultation.id)).resolves.toMatchObject({ caseId: created.id, state: 'scheduled' });
  await expect(second.listCases()).resolves.toHaveLength(1);
});
it('marks live consultations interrupted when loaded after a restart', async () => {
  const root = directory(); const first = createFileStore(root);
  const { case: created } = await first.createCase(input);
  const consultation = await first.createConsultation(created.id);
  await first.updateConsultation(consultation.id, current => ({ ...current, state: 'live', recording: true }));
  const second = createFileStore(root);
  await second.recoverInterrupted();
  await expect(second.getConsultation(consultation.id)).resolves.toMatchObject({ state: 'interrupted', recording: false });
});
it('serializes concurrent updates so none is lost', async () => {
  const store = createFileStore(directory());
  const { case: created } = await store.createCase(input);
  const consultation = await store.createConsultation(created.id);
  await Promise.all(Array.from({ length: 20 }, (_, index) => store.updateConsultation(consultation.id, current => ({ ...current, errors: [...current.errors, { code: String(index), message: 'x' }] }))));
  expect((await store.getConsultation(consultation.id)).errors).toHaveLength(20);
});
it('does not write when an update throws', async () => {
  const store = createFileStore(directory());
  const { case: created } = await store.createCase(input);
  const consultation = await store.createConsultation(created.id);
  await expect(store.updateConsultation(consultation.id, () => { throw new Error('no'); })).rejects.toThrow('no');
  await expect(store.getConsultation(consultation.id)).resolves.toMatchObject({ state: 'scheduled' });
});
it.each(['../../outside', '..', 'a/b', 'a\\b', ''])('rejects unsafe id %j', async id => {
  const store = createFileStore(directory());
  await expect(store.getCase(id)).rejects.toBeInstanceOf(StoreError);
  await expect(store.getConsultation(id)).rejects.toBeInstanceOf(StoreError);
});
it('reports missing records as not found', async () => {
  const store = createFileStore(directory());
  await expect(store.getCase('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ code: 'NOT_FOUND' });
});
it('refuses a consultation for an unknown case', async () => {
  await expect(createFileStore(directory()).createConsultation('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ code: 'NOT_FOUND' });
});
it('lists a case with its consultations newest first', async () => {
  let now = 1000;
  const store = createFileStore(directory(), { now: () => now });
  const { case: created } = await store.createCase(input);
  const first = await store.createConsultation(created.id);
  now += 1000;
  const second = await store.createConsultation(created.id);
  expect((await store.listConsultations(created.id)).map(item => item.id)).toEqual([second.id, first.id]);
});
it('leaves no temporary files behind', async () => {
  const root = directory(); const store = createFileStore(root);
  const { case: created } = await store.createCase(input);
  await store.createConsultation(created.id);
  expect(allFiles(root).filter(file => file.endsWith('.tmp'))).toEqual([]);
});
