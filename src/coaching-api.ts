import { request } from './api';
import type { CoachingCase, Consultation, Moment } from './domain/coaching';
import type { CoachingNote, NoteDelivery } from './domain/coaching-note';

export type CaseView = Pick<CoachingCase, 'id' | 'petName' | 'guardianName' | 'trainerName' | 'createdAt'>;
export type CaseDetail = CaseView & { consultations: Consultation[] };
export type CaseInput = Pick<CoachingCase, 'petName' | 'guardianName' | 'trainerName'>;
export type Me = { role: 'trainer' } | { role: 'guardian'; caseId: string };
export type IceConfig = { iceServers: RTCIceServer[]; relayAvailable: boolean };

const post = <T>(path: string, body: unknown = {}) => request<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const base = '/api/coaching';

export type Delivery = { note: NoteDelivery; scenes: { id: string; atMs: number; frameIds: string[] }[] };
const send = <T>(method: string, path: string, body: unknown) => request<T>(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

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
export const frameUrl = (id: string, frameId: string) => `${base}/consultations/${id}/frames/${frameId}`;
export const setSegment = (id: string, segmentId: string, change: { text?: string; echoSuspect?: boolean }) => send<Consultation>('PATCH', `${base}/consultations/${id}/segments/${segmentId}`, change);
export const setObservation = (id: string, sceneId: string, observationId: string, change: { text?: string; reviewed?: boolean }) => send<Consultation>('PATCH', `${base}/consultations/${id}/scenes/${sceneId}/observations/${observationId}`, change);
export const saveNote = (id: string, note: CoachingNote) => send<Consultation>('PUT', `${base}/consultations/${id}/note`, note);
export const regenerateNote = (id: string) => post<Consultation>(`${base}/consultations/${id}/note`);
export const approveConsultation = (id: string) => post<Consultation>(`${base}/consultations/${id}/approve`);
export const getDelivery = (id: string) => request<Delivery>(`${base}/consultations/${id}/delivery`);
export const createMoment = (id: string) => post<Moment>(`${base}/consultations/${id}/moments`);
export const setMomentMemo = (id: string, momentId: string, text: string) => request<Moment>(`${base}/consultations/${id}/moments/${momentId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
export const uploadAudio = (id: string, { bytes, startMs, endMs }: { bytes: Blob; startMs: number; endMs: number }) => request(`${base}/consultations/${id}/audio/${startMs}?endMs=${endMs}`, { method: 'PUT', headers: { 'Content-Type': 'audio/wav' }, body: bytes });
export function uploadFrame(id: string, frame: { id: string; atMs: number; source: string; bytes: Blob }, momentId?: string) {
  const query = new URLSearchParams({ atMs: String(frame.atMs), source: frame.source, ...(momentId ? { moment: momentId } : {}) });
  return request(`${base}/consultations/${id}/frames/${frame.id}?${query}`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: frame.bytes });
}
