import type { Draft, SourceKind } from './domain/notes';

export type Session = {
  features?: import('./domain/workspace-types').FeatureFlags;
  authenticated: boolean;
  requirePassword: boolean;
  aiEnabled: boolean;
  configured: boolean;
  textModel: string;
  sttModel: string;
};
export type NoteResult = { draft: Draft; fallbackUsed: boolean; requestId: string; latencyMs: number; model: string; warnings: string[] };
export type TranscriptResult = { text: string; requestId: string; latencyMs: number; model: string };

export class ApiError extends Error {
  constructor(message: string, public code = 'REQUEST_FAILED', public requestId = '') { super(message); }
}

async function readResponse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(body?.error || `요청에 실패했습니다 (${response.status}).`, body?.code, body?.requestId);
  return body as T;
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  try {
    return await readResponse<T>(await fetch(path, { credentials: 'same-origin', ...init }));
  } catch (error) {
    if (error instanceof ApiError || (error instanceof DOMException && error.name === 'AbortError')) throw error;
    throw new ApiError('서버에 연결할 수 없습니다. 연결 상태를 확인하고 다시 시도해 주세요.', 'NETWORK_ERROR');
  }
}

export const getSession = (signal?: AbortSignal) => request<Session>('/api/session', { signal });
export const login = (password: string, signal?: AbortSignal) => request<Session>('/api/session', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }), signal,
});
export const logout = (signal?: AbortSignal) => request<Session>('/api/session', { method: 'DELETE', signal });
export const generateNote = (text: string, sourceKind: SourceKind, signal?: AbortSignal) => request<NoteResult>('/api/notes', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, sourceKind, consent: true }), signal,
});
export async function verifyAudibleAudio(audio: Blob): Promise<void> {
  if (!audio.size) throw new ApiError('녹음이 비어 있습니다. 다시 녹음해 주세요.', 'EMPTY_AUDIO');
  if (typeof AudioContext === 'undefined') throw new ApiError('이 브라우저에서 녹음 소리를 확인할 수 없습니다. 녹음을 다시 듣고 텍스트로 입력해 주세요.', 'AUDIO_CHECK_UNAVAILABLE');
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await audio.arrayBuffer());
    let audible = false;
    for (let channel = 0; channel < decoded.numberOfChannels && !audible; channel++) {
      const samples = decoded.getChannelData(channel);
      const windowSize = Math.max(1, Math.floor(decoded.sampleRate / 10));
      for (let start = 0; start < samples.length; start += windowSize) {
        let energy = 0;
        for (let index = start; index < Math.min(start + windowSize, samples.length); index++) energy += samples[index] * samples[index];
        if (Math.sqrt(energy / Math.min(windowSize, samples.length - start)) > 0.003) { audible = true; break; }
      }
    }
    if (!audible) throw new ApiError('녹음에서 소리가 감지되지 않았습니다. 다시 녹음해 주세요.', 'SILENT_AUDIO');
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('녹음 소리를 확인할 수 없습니다. 녹음을 다시 듣고 텍스트로 입력해 주세요.', 'AUDIO_CHECK_UNAVAILABLE');
  } finally { await context.close(); }
}
export function transcribe(audio: Blob, duration: number, petName: string, signal?: AbortSignal) {
  const form = new FormData();
  form.append('audio', audio, audio.type.includes('mp4') ? 'recording.mp4' : 'recording.webm');
  form.append('duration', String(duration));
  form.append('petName', petName);
  form.append('consent', 'true');
  return request<TranscriptResult>('/api/transcribe', { method: 'POST', body: form, signal });
}
