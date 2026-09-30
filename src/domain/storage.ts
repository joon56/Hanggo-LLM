import { approveDraft, type ApprovedNote } from './notes';

const key = 'hanggo:approved-notes';
type Stored = { version: 1; notes: ApprovedNote[] };

function getStorage(storage?: Storage): Storage {
  if (storage) return storage;
  if (typeof localStorage === 'undefined') throw new Error('이 브라우저에서는 로컬 저장소를 사용할 수 없습니다.');
  return localStorage;
}

function validNote(value: unknown): value is ApprovedNote {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const note = value as ApprovedNote;
  if (!['demo', 'openai', 'manual'].includes(note.mode) || !note.draft || note.mode !== note.draft.mode || typeof note.id !== 'string' || !note.id.trim() ||
    typeof note.approvedAt !== 'string' || !Number.isFinite(Date.parse(note.approvedAt))) return false;
  try { approveDraft(note.draft, note.metadata, true); return true; }
  catch { return false; }
}

function read(storage: Storage): Stored {
  let raw: string | null;
  try { raw = storage.getItem(key); }
  catch { throw new Error('저장된 기록을 읽을 수 없습니다.'); }
  if (raw === null) return { version: 1, notes: [] };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
    const data = parsed as Stored;
    if (data.version !== 1 || !Array.isArray(data.notes) || data.notes.length > 50 || !data.notes.every(validNote)) throw new Error();
    return data;
  } catch { throw new Error('저장된 기록이 손상되어 읽을 수 없습니다.'); }
}

function write(storage: Storage, data: Stored): void {
  try { storage.setItem(key, JSON.stringify(data)); }
  catch { throw new Error('기록 저장에 실패했습니다. 브라우저 저장 공간을 확인하세요.'); }
}

function snapshot(note: ApprovedNote): ApprovedNote {
  return {
    id: note.id,
    metadata: { petName: note.metadata.petName, trainerName: note.metadata.trainerName, sessionDate: note.metadata.sessionDate },
    draft: {
      id: note.draft.id, sourceKind: note.draft.sourceKind, sourceText: note.draft.sourceText,
      items: note.draft.items.map(item => ({
        id: item.id, category: item.category, text: item.text, sourceQuote: item.sourceQuote, edited: item.edited,
      })),
      safetyFlags: [...note.draft.safetyFlags], methodReview: note.draft.methodReview,
      createdAt: note.draft.createdAt, mode: note.draft.mode,
      ...(note.draft.generation ? { generation: { ...note.draft.generation } } : {}),
    },
    approvedAt: note.approvedAt, mode: note.mode,
  };
}

export function listNotes(storage?: Storage): ApprovedNote[] {
  return read(getStorage(storage)).notes;
}

export function saveNote(note: ApprovedNote, storage?: Storage): void {
  if (!validNote(note)) throw new Error('승인된 기록만 저장할 수 있습니다.');
  const target = getStorage(storage);
  const saved = read(target).notes;
  if (saved.length >= 50 && !saved.some(entry => entry.id === note.id))
    throw new Error('기록은 최대 50건입니다. 기존 기록을 내보내거나 삭제한 뒤 저장하세요.');
  const existing = saved.filter(entry => entry.id !== note.id).map(snapshot);
  write(target, { version: 1, notes: [snapshot(note), ...existing] });
}

export function deleteNote(id: string, storage?: Storage): void {
  const target = getStorage(storage);
  const data = read(target);
  write(target, { version: 1, notes: data.notes.filter(note => note.id !== id) });
}
