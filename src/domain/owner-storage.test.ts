import { beforeEach, expect, it } from 'vitest';
import { createManualOwnerDraft } from './owner-log';
import { deleteOwnerLog, listOwnerLogs, listPets, saveOwnerLog, savePets } from './owner-storage';
const pets = [{ id: 'p1', name: '초코', nicknames: [] }];
const draft = () => createManualOwnerDraft({ text: '산책했다', pets, now: '2026-09-30T14:00:00+09:00', timeZone: 'Asia/Seoul', sourceKind: 'nl_log_text' });
beforeEach(() => localStorage.clear());
it('saves only reviewed records and preserves source across reload and deletion', () => {
  savePets(pets); expect(listPets()).toEqual(pets);
  expect(() => saveOwnerLog(draft(), false)).toThrow();
  const saved = saveOwnerLog(draft(), true);
  expect(listOwnerLogs()[0].draft.sourceText).toBe('산책했다');
  deleteOwnerLog(saved.id); expect(listOwnerLogs()).toEqual([]);
});
it('does not overwrite corrupt records', () => {
  localStorage.setItem('hanggo:owner-logs', '{bad');
  expect(() => saveOwnerLog(draft(), true)).toThrow();
  expect(localStorage.getItem('hanggo:owner-logs')).toBe('{bad');
});
it('rejects duplicate pets and corrupt saved events', () => {
  expect(() => savePets([...pets, ...pets])).toThrow();
  localStorage.setItem('hanggo:owner-logs', JSON.stringify({ version: 1, items: [{ id: 'x', draft: {}, savedAt: '2026-09-30' }] }));
  expect(() => listOwnerLogs()).toThrow();
});
it('requires explicit deletion at capacity', () => {
  for (let i = 0; i < 100; i++) saveOwnerLog(draft(), true);
  expect(() => saveOwnerLog(draft(), true)).toThrow(/100/);
  expect(listOwnerLogs()).toHaveLength(100);
});
