import { describe, expect, it } from 'vitest';
import { approveDraft, createDraft } from './notes';
import { deleteNote, listNotes, saveNote } from './storage';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear() { data.clear(); },
    getItem(key) { return data.get(key) ?? null; },
    key(index) { return [...data.keys()][index] ?? null; },
    removeItem(key) { data.delete(key); },
    setItem(key, value) { data.set(key, value); },
  };
}

function approved() {
  return approveDraft(createDraft('오늘 앉아를 연습했습니다.', 'trainer_summary_text'), {
    petName: '몽이', trainerName: '김훈련', sessionDate: '2026-09-28',
  }, true);
}

describe('local note storage', () => {
  it('saves, lists, and deletes approved notes', () => {
    const storage = memoryStorage();
    const note = approved();
    saveNote(note, storage);
    expect(listNotes(storage)).toEqual([note]);
    deleteNote(note.id, storage);
    expect(listNotes(storage)).toEqual([]);
  });

  it('rejects corrupt data without overwriting it', () => {
    const storage = memoryStorage();
    storage.setItem('hanggo:approved-notes', '{bad');
    expect(() => listNotes(storage)).toThrow();
    expect(() => saveNote(approved(), storage)).toThrow();
    expect(storage.getItem('hanggo:approved-notes')).toBe('{bad');
  });

  it('rejects malformed persisted entries and unapproved inputs', () => {
    const storage = memoryStorage();
    storage.setItem('hanggo:approved-notes', JSON.stringify({ version: 1, notes: [{ id: 'bad' }] }));
    expect(() => listNotes(storage)).toThrow();
    storage.clear();
    expect(() => saveNote({ ...approved(), mode: 'other' } as never, storage)).toThrow();
    expect(listNotes(storage)).toEqual([]);
  });

  it('reports write failures and keeps the existing record count', () => {
    const storage = memoryStorage();
    const note = approved();
    saveNote(note, storage);
    const failing = { ...storage, setItem() { throw new Error('QuotaExceededError'); } } as Storage;
    expect(() => saveNote({ ...approved(), id: 'next' }, failing)).toThrow(/저장/);
    expect(listNotes(storage)).toEqual([note]);
  });

  it('refuses a 51st record without deleting any saved record', () => {
    const storage = memoryStorage();
    for (let i = 0; i < 50; i++) saveNote({ ...approved(), id: `note-${i}` }, storage);
    expect(() => saveNote({ ...approved(), id: 'note-50' }, storage)).toThrow(/삭제|내보내기/);
    expect(listNotes(storage)).toHaveLength(50);
    expect(listNotes(storage).map(note => note.id)).toEqual(Array.from({ length: 50 }, (_, index) => `note-${49 - index}`));
    saveNote({ ...approved(), id: 'note-0' }, storage);
    expect(listNotes(storage)).toHaveLength(50);
  });

  it('stores only approved note fields, excluding attached audio data', () => {
    const storage = memoryStorage();
    const note = approved() as ReturnType<typeof approved> & { audio?: string };
    note.audio = 'audio-data';
    saveNote(note, storage);
    expect(JSON.stringify(listNotes(storage))).not.toContain('audio-data');
  });
});
