import { request } from './api';
import type { OwnerInput, OwnerDraft, BriefInput, BriefDraft, ShelterInput, ShelterDraft, ServiceResult } from './domain/workspace-types';

function generate<T>(path: string, input: unknown, signal?: AbortSignal) {
  return request<ServiceResult<T>>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input, consent: true }), signal });
}
export const generateOwnerLog = (input: OwnerInput, signal?: AbortSignal) => generate<OwnerDraft>('/api/owner-logs', input, signal);
export const generateBrief = (input: BriefInput, signal?: AbortSignal) => generate<BriefDraft>('/api/briefs', input, signal);
export const generateShelterProfile = (input: ShelterInput, signal?: AbortSignal) => generate<ShelterDraft>('/api/shelter-profiles', input, signal);
