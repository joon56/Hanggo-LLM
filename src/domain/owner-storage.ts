import { z } from 'zod';
import { PetSchema, validateOwnerDraft } from './owner-log.ts';
import type { OwnerDraft, Pet, SavedOwnerLog } from './workspace-types.ts';

const petsKey = 'hanggo:pets', logsKey = 'hanggo:owner-logs';
const Pets = z.array(PetSchema).max(30).refine(pets => new Set(pets.map(pet => pet.id)).size === pets.length);
const Logs = z.array(z.object({ id: z.string().min(1), draft: z.custom<OwnerDraft>(value => validateOwnerDraft(value as OwnerDraft).length === 0), savedAt: z.iso.datetime({ offset: true }) }).strict()).max(100).refine(logs => new Set(logs.map(log => log.id)).size === logs.length);
function read<T>(key: string, schema: z.ZodType<T>, empty: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return empty;
    return z.object({ version: z.literal(1), items: schema }).strict().parse(JSON.parse(raw)).items;
  } catch { throw new Error('저장된 자료가 손상되었거나 읽을 수 없습니다. 기존 자료를 보존했습니다.'); }
}
function write(key: string, items: unknown): void {
  try { localStorage.setItem(key, JSON.stringify({ version: 1, items })); }
  catch { throw new Error('저장에 실패했습니다. 브라우저 저장 공간을 확인하세요.'); }
}
export function listPets(): Pet[] { return read(petsKey, Pets, []); }
export function savePets(pets: Pet[]): void { const value = Pets.parse(pets); listPets(); write(petsKey, value); }
export function listOwnerLogs(): SavedOwnerLog[] { return read(logsKey, Logs, []); }
export function saveOwnerLog(draft: OwnerDraft, reviewed: boolean): SavedOwnerLog {
  if (reviewed !== true) throw new Error('기록 검토를 확인한 뒤 저장하세요.');
  const errors = validateOwnerDraft(draft); if (errors.length) throw new Error(errors.join(' '));
  const logs = listOwnerLogs();
  if (logs.length >= 100) throw new Error('기록은 최대 100건입니다. 내보내거나 삭제한 뒤 저장하세요.');
  const saved = { id: crypto.randomUUID(), draft: structuredClone(draft), savedAt: new Date().toISOString() };
  write(logsKey, [saved, ...logs]); return saved;
}
export function deleteOwnerLog(id: string): void { const logs = listOwnerLogs(); write(logsKey, logs.filter(log => log.id !== id)); }
