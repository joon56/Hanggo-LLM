import { request } from './api';
import type { CoachingCase, Consultation, Moment } from './domain/coaching';

export type CaseView = Pick<CoachingCase, 'id' | 'petName' | 'guardianName' | 'trainerName' | 'createdAt'>;
export type CaseDetail = CaseView & { consultations: Consultation[] };
export type CaseInput = Pick<CoachingCase, 'petName' | 'guardianName' | 'trainerName'>;
export type Me = { role: 'trainer' } | { role: 'guardian'; caseId: string };
export type IceConfig = { iceServers: RTCIceServer[]; relayAvailable: boolean };

const post = <T>(path: string, body: unknown = {}) => request<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const base = '/api/coaching';

export const getMe = () => request<Me>(`${base}/me`);
export const listCases = () => request<{ cases: CaseView[] }>(`${base}/cases`);
export const getCase = (id: string) => request<CaseDetail>(`${base}/cases/${id}`);
export const createCase = (input: CaseInput) => post<{ case: CaseView; inviteToken: string }>(`${base}/cases`, input);
export const reissueInvite = (id: string) => post<{ inviteToken: string }>(`${base}/cases/${id}/invite`);
export const joinWithInvite = (token: string) => post<{ case: CaseView }>(`${base}/join`, { token });
export const startConsultation = (caseId: string) => post<Consultation>(`${base}/cases/${caseId}/consultations`);
export const getConsultation = (id: string) => request<Consultation>(`${base}/consultations/${id}`);
export const getIce = (id: string) => request<IceConfig>(`${base}/consultations/${id}/ice`);
export const setConsent = (id: string, value: boolean) => post<Consultation>(`${base}/consultations/${id}/consent`, { value });
export const endConsultation = (id: string) => post<Consultation>(`${base}/consultations/${id}/end`);
export const createMoment = (id: string) => post<Moment>(`${base}/consultations/${id}/moments`);
export const setMomentMemo = (id: string, momentId: string, text: string) => request<Moment>(`${base}/consultations/${id}/moments/${momentId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
export const uploadAudio = (id: string, { bytes, startMs, endMs }: { bytes: Blob; startMs: number; endMs: number }) => request(`${base}/consultations/${id}/audio/${startMs}?endMs=${endMs}`, { method: 'PUT', headers: { 'Content-Type': 'audio/wav' }, body: bytes });
export function uploadFrame(id: string, frame: { id: string; atMs: number; source: string; bytes: Blob }, momentId?: string) {
  const query = new URLSearchParams({ atMs: String(frame.atMs), source: frame.source, ...(momentId ? { moment: momentId } : {}) });
  return request(`${base}/consultations/${id}/frames/${frame.id}?${query}`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: frame.bytes });
}
