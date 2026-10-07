import { ApiError, request } from './api';
import type { Metadata } from './domain/notes';
import type { ConsultationNote, ConsultationSession } from './domain/consultation';

const base = '/api/consultations';
const path = (id: string) => `${base}/${encodeURIComponent(id)}`;
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
export const listConsultations = () => request<{ sessions: ConsultationSession[] }>(base);
export const getConsultation = (id: string) => request<ConsultationSession>(path(id));
export const createConsultation = (metadata: Metadata) => request<ConsultationSession>(base, json('POST', { metadata, consent: true }));
export const finishConsultation = (id: string, durationMs: number, captureError?: string) => request<ConsultationSession>(`${path(id)}/finish`, json('POST', { durationMs, ...(captureError ? { captureError: captureError.slice(0, 500) } : {}) }));
export const addBookmark = (id: string, atMs: number, text: string) => request<ConsultationSession>(`${path(id)}/bookmarks`, json('POST', { atMs, text }));
export const updateSegment = (id: string, segmentId: string, text: string) => request<ConsultationSession>(`${path(id)}/segments/${encodeURIComponent(segmentId)}`, json('PATCH', { text }));
export const generateConsultationNote = (id: string) => request<ConsultationSession>(`${path(id)}/note`, json('POST', {}));
export const updateConsultationNote = (id: string, note: ConsultationNote) => request<ConsultationSession>(`${path(id)}/note`, json('PATCH', { note }));
export const approveConsultation = (id: string) => request<ConsultationSession>(`${path(id)}/approve`, json('POST', { reviewed: true }));
export const recordingUrl = (id: string) => `${path(id)}/recording`;
export const exportUrl = (id: string) => `${path(id)}/export`;
export async function uploadAudio(id: string, sequence: number, bytes: Blob, startMs: number, endMs: number) {
  return request<ConsultationSession>(`${path(id)}/audio/${sequence}?startMs=${startMs}&endMs=${endMs}`, { method: 'PUT', headers: { 'Content-Type': 'audio/wav' }, body: bytes, signal: AbortSignal.timeout(30000) });
}
export async function uploadMedia(id: string, sequence: number, bytes: Blob) {
  return request<ConsultationSession>(`${path(id)}/media/${sequence}`, { method: 'PUT', headers: { 'Content-Type': 'video/webm' }, body: bytes, signal: AbortSignal.timeout(30000) });
}
export async function deleteConsultation(id: string): Promise<void> {
  const response = await fetch(path(id), { method: 'DELETE', credentials: 'same-origin' });
  if (!response.ok) { const body = await response.json().catch(() => null); throw new ApiError(body?.error || `삭제 실패 (${response.status})`, body?.code); }
}
