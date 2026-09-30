import { validateShelterDraft } from './shelter.ts';
import type { ShelterDraft, SavedShelterProfile } from './workspace-types.ts';
const key = 'hanggo:shelter-profiles';
function read(storage: Storage): SavedShelterProfile[] {
  const raw = storage.getItem(key);
  if (raw === null) return [];
  try {
    const data = JSON.parse(raw);
    if (data.version !== 1 || !Array.isArray(data.profiles) || data.profiles.length > 50 || new Set(data.profiles.map((p: SavedShelterProfile) => p.id)).size !== data.profiles.length || !data.profiles.every((p: SavedShelterProfile) => typeof p.id === 'string' && p.id.trim() && typeof p.approvedBy === 'string' && p.approvedBy.trim() && typeof p.approvedAt === 'string' && Number.isFinite(Date.parse(p.approvedAt)) && validateShelterDraft(p.draft).length === 0)) throw new Error();
    return data.profiles;
  } catch { throw new Error('저장된 프로필이 손상되어 읽을 수 없습니다.'); }
}
function write(storage: Storage, profiles: SavedShelterProfile[]) {
  try { storage.setItem(key, JSON.stringify({ version: 1, profiles })); }
  catch { throw new Error('프로필 저장에 실패했습니다. 브라우저 저장 공간을 확인하세요.'); }
}
export function listShelterProfiles(storage: Storage = localStorage): SavedShelterProfile[] { return read(storage); }
export function saveShelterProfile(draft: ShelterDraft, approvedBy: string, reviewed: boolean, storage: Storage = localStorage): SavedShelterProfile {
  if (reviewed !== true || typeof approvedBy !== 'string' || !approvedBy.trim() || approvedBy.length > 100) throw new Error('직원 이름과 검토 확인이 필요합니다.');
  const errors = validateShelterDraft(draft); if (errors.length) throw new Error(errors.join(' '));
  const profiles = read(storage); if (profiles.length >= 50) throw new Error('프로필은 최대 50건입니다. 내보내거나 삭제한 뒤 저장하세요.');
  const saved = { id: crypto.randomUUID(), draft: JSON.parse(JSON.stringify(draft)) as ShelterDraft, approvedAt: new Date().toISOString(), approvedBy: approvedBy.trim() };
  write(storage, [saved, ...profiles]); return saved;
}
export function deleteShelterProfile(id: string, storage: Storage = localStorage): void { const profiles = read(storage); write(storage, profiles.filter(p => p.id !== id)); }
