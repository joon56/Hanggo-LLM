import { useEffect, useRef, useState } from 'react';
import { createConsultation, finishConsultation, uploadAudio, uploadMedia } from '../consultation-api';
import type { Metadata } from '../domain/notes';
import type { ConsultationSession } from '../domain/consultation';

const MAX_MS = 3600000;
type AudioWindow = { bytes: Blob; startMs: number; endMs: number };
function wav(samples: Float32Array): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2); const view = new DataView(buffer);
  const text = (at: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) { const sample = Math.max(-1, Math.min(1, samples[i])); view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true); }
  return new Blob([buffer], { type: 'audio/wav' });
}
/** Streaming resampling preserves fractional position across worklet blocks. */
export class AudioWindows {
  private buffer = new Float32Array(160000); private length = 0; private emitted = 0; private count = 0;
  private weighted = 0; private weight = 0; private readonly ratio: number;
  constructor(sampleRate: number, private emit: (window: AudioWindow) => void) { this.ratio = sampleRate / 16000; }
  get durationMs() { return Math.round(this.count / 16); }
  push(samples: Float32Array) {
    for (const sample of samples) {
      let remaining = 1;
      while (remaining > 1e-9 && this.count < MAX_MS * 16) {
        const part = Math.min(remaining, this.ratio - this.weight); this.weighted += sample * part; this.weight += part; remaining -= part;
        if (this.weight >= this.ratio - 1e-9) { this.buffer[this.length++] = this.weighted / this.ratio; this.count++; this.weighted = 0; this.weight = 0; if (this.length === this.buffer.length) this.output(); }
      }
    }
  }
  private output() {
    if (!this.length) return;
    const startMs = Math.round(this.emitted / 16); this.emitted += this.length;
    this.emit({ bytes: wav(this.buffer.slice(0, this.length)), startMs, endMs: Math.max(startMs + 1, Math.round(this.emitted / 16)) }); this.length = 0;
  }
  flush() { this.output(); }
}

/** Retry preserves head bytes and sequence until server acknowledgement. */
export class OrderedUploadQueue {
  private items: { bytes: Blob; sequence: number }[] = []; private next = 0; private running?: Promise<void>; private failure?: Error;
  constructor(private limit: number, private send: (bytes: Blob, sequence: number) => Promise<unknown>, private onFailure?: (error: Error) => void) {}
  get pendingBytes() { return this.items.reduce((sum, item) => sum + item.bytes.size, 0); }
  get pendingCount() { return this.items.length; }
  add(bytes: Blob) {
    if (this.pendingBytes + bytes.size > this.limit) throw new Error('업로드 대기 용량 초과. 녹화를 중지하고 저장 상태를 확인해 주세요.');
    this.items.push({ bytes, sequence: this.next++ }); this.run();
  }
  private run() {
    if (this.running || this.failure || !this.items.length) return;
    this.running = (async () => {
      while (this.items.length) { const item = this.items[0]; await this.send(item.bytes, item.sequence); this.items.shift(); }
    })().catch(error => { this.failure = error instanceof Error ? error : new Error(String(error)); this.onFailure?.(this.failure); }).finally(() => { this.running = undefined; });
  }
  async drain() { this.run(); await this.running; if (this.failure) throw this.failure; }
  async retry() { await this.running; this.failure = undefined; await this.drain(); }
}

type Status = 'idle' | 'requesting' | 'preparing' | 'recording' | 'finishing' | 'blocked' | 'ready';
type Capture = {
  display?: MediaStream; microphone?: MediaStream; context?: AudioContext; worklet?: AudioWorkletNode; recorder?: MediaRecorder;
  session?: ConsultationSession; audio?: AudioWindows; mediaQueue?: OrderedUploadQueue; audioQueue?: OrderedUploadQueue;
  timer?: ReturnType<typeof setInterval>; cutoff?: ReturnType<typeof setTimeout>; stopped?: Promise<void>; flushResolve?: () => void; stopping: boolean; cancelled: boolean; durationMs: number; fatal?: string; startedAt?: number; stoppedAt?: number;
};
export function useConsultationRecorder() {
  const [status, setStatus] = useState<Status>('idle'); const [error, setError] = useState(''); const [session, setSession] = useState<ConsultationSession | null>(null);
  const [durationMs, setDurationMs] = useState(0); const [pendingBytes, setPendingBytes] = useState(0); const [preview, setPreview] = useState<MediaStream | null>(null);
  const [audioLevel, setAudioLevel] = useState(0);
  const capture = useRef<Capture | null>(null); const mounted = useRef(true); const stopRef = useRef<() => Promise<void>>(async () => {});
  const update = (fn: () => void) => { if (mounted.current) fn(); };
  const release = (current: Capture) => {
    clearInterval(current.timer); clearTimeout(current.cutoff); current.display?.getTracks().forEach(track => track.stop()); current.microphone?.getTracks().forEach(track => track.stop());
    current.worklet?.disconnect(); void current.context?.close().catch(() => {}); update(() => { setPreview(null); setAudioLevel(0); });
  };
  const finish = async (current: Capture) => {
    try {
      await Promise.all([current.mediaQueue?.drain(), current.audioQueue?.drain()]);
      update(() => { setStatus('finishing'); setPendingBytes(0); });
      if (current.fatal && current.startedAt !== undefined) current.durationMs = Math.min(MAX_MS, Math.max(current.durationMs, (current.stoppedAt ?? Date.now()) - current.startedAt));
      if (current.session) { const saved = current.fatal ? await finishConsultation(current.session.id, current.durationMs, current.fatal) : await finishConsultation(current.session.id, current.durationMs); update(() => setSession(saved)); }
      update(() => setStatus('ready'));
    } catch (cause) { update(() => { setStatus('blocked'); setError(`저장 미완료: ${cause instanceof Error ? cause.message : '업로드 실패'}. 대기 데이터는 이 탭에 남아 있습니다. 저장 재시도 후 화면을 닫아 주세요.`); }); }
  };
  const stop = async () => {
    const current = capture.current; if (!current) return;
    if (current.stopped) return current.stopped;
    current.cancelled = true;
    if (!current.session) { release(current); return; }
    current.stopping = true; update(() => setStatus('finishing')); clearInterval(current.timer); clearTimeout(current.cutoff);
    current.stoppedAt = Date.now();
    current.stopped = (async () => {
      if (current.worklet) {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('오디오 종료 응답 없음. 받아쓰기 끝부분이 누락될 수 있습니다.')), 5000);
          current.flushResolve = () => { clearTimeout(timeout); resolve(); }; current.worklet!.port.postMessage({ type: 'flush' });
        }).catch(cause => { current.fatal = cause.message; update(() => setError(cause.message)); });
      }
      try { current.audio?.flush(); } catch (cause) { current.fatal = String(cause); update(() => setError(String(cause))); }
      current.durationMs = current.audio?.durationMs ?? 0; update(() => setDurationMs(current.durationMs));
      if (current.recorder && current.recorder.state !== 'inactive') await new Promise<void>(resolve => { current.recorder!.onstop = () => resolve(); current.recorder!.stop(); });
      release(current); await finish(current);
    })();
    return current.stopped;
  };
  stopRef.current = stop;
  const start = async (metadata: Metadata, microphoneEnabled: boolean, source: 'camera' | 'tab' = 'tab') => {
    if (capture.current && !['idle', 'ready'].includes(status)) return;
    const current: Capture = { stopping: false, cancelled: false, durationMs: 0 }; capture.current = current;
    update(() => { setStatus('requesting'); setError(''); setSession(null); setDurationMs(0); setPendingBytes(0); });
    try {
      if (!(source === 'camera' ? navigator.mediaDevices?.getUserMedia : navigator.mediaDevices?.getDisplayMedia) || typeof AudioWorkletNode === 'undefined' || typeof MediaRecorder === 'undefined') throw new Error('Windows Chrome/Edge에서 카메라·탭과 오디오 녹화를 지원하는지 확인해 주세요.');
      // First await comes after display picker to preserve user activation.
      const video = { width: { max: 1280 }, height: { max: 720 }, frameRate: { max: 15 } };
      const selected = source === 'camera'
        ? navigator.mediaDevices.getUserMedia({ video, audio: { echoCancellation: true, noiseSuppression: true } })
        : navigator.mediaDevices.getDisplayMedia({ video, audio: true });
      current.display = await selected;
      if (current.cancelled) { release(current); update(() => setStatus('idle')); return; }
      if (!current.display.getVideoTracks().length) throw new Error('카메라 영상이 없습니다. 카메라 연결과 권한을 확인해 주세요.');
      if (source === 'tab' && current.display.getVideoTracks()[0]?.getSettings().displaySurface !== 'browser') throw new Error('브라우저 탭만 공유할 수 있습니다. 창·전체 화면 대신 상담 탭을 선택해 주세요.');
      if (!current.display.getAudioTracks().length) throw new Error(source === 'camera' ? '마이크 음성이 없습니다. 마이크 연결과 권한을 확인해 주세요.' : '탭 오디오가 없습니다. 탭 오디오 공유를 켜고 다시 선택해 주세요.');
      current.display.getVideoTracks()[0].addEventListener('ended', () => { if (source === 'camera' && !current.stopping && !current.cancelled) { current.fatal = '카메라 연결이 끊겼습니다. 영상 일부가 누락될 수 있습니다.'; update(() => setError(current.fatal!)); } void stopRef.current(); }, { once: true });
      if (source === 'tab' && microphoneEnabled) current.microphone = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      if (current.cancelled) { release(current); update(() => setStatus('idle')); return; }
      current.context = new AudioContext(); await current.context.audioWorklet.addModule('/consultation-audio-worklet.js'); await current.context.resume();
      if (current.cancelled) { release(current); update(() => setStatus('idle')); return; }
      const mix = current.context.createMediaStreamDestination(); const worklet = new AudioWorkletNode(current.context, 'consultation-audio'); current.worklet = worklet;
      const mute = current.context.createGain(); mute.gain.value = 0; worklet.connect(mute); mute.connect(current.context.destination);
      const sources = [current.display, ...(current.microphone ? [current.microphone] : [])];
      const connectSources = () => { for (const stream of sources) { const source = current.context!.createMediaStreamSource(stream); source.connect(mix); source.connect(worklet); } };
      update(() => setStatus('preparing')); current.session = await createConsultation(metadata, source); update(() => setSession(current.session!));
      if (current.cancelled) { release(current); await finish(current); return; }
      if (current.display.getVideoTracks().some(track => track.readyState === 'ended') || current.display.getAudioTracks().some(track => track.readyState === 'ended') || current.microphone?.getAudioTracks().some(track => track.readyState === 'ended')) {
        current.fatal = current.display.getAudioTracks().some(track => track.readyState === 'ended') ? '모델 준비 중 탭 오디오가 끊겼습니다. 다시 공유해 주세요.' : '모델 준비 중 마이크가 끊겼습니다. 연결 후 다시 시작해 주세요.';
        if (source === 'camera') current.fatal = '모델 준비 중 카메라·마이크 연결이 끊겼습니다. 연결 후 다시 시작해 주세요.';
        throw new Error(current.fatal);
      }
      const failed = (cause: Error) => { update(() => setError(`업로드 중지: ${cause.message}. 데이터 보존 후 재시도 필요.`)); if (!current.stopping) void stopRef.current(); };
      const lostAudio = (message: string) => { if (current.stopping || current.cancelled) return; current.fatal = message; failed(new Error(message)); };
      current.display.getAudioTracks().forEach(track => track.addEventListener('ended', () => { if (current.display!.getVideoTracks()[0].readyState === 'ended') { void stopRef.current(); } else lostAudio(source === 'camera' ? '카메라 마이크가 끊겼습니다. 받아쓰기 일부가 누락될 수 있습니다.' : '탭 오디오가 끊겼습니다. 받아쓰기 일부가 누락될 수 있습니다.'); }, { once: true }));
      current.microphone?.getAudioTracks().forEach(track => track.addEventListener('ended', () => lostAudio('마이크가 끊겼습니다. 내 목소리 일부가 누락될 수 있습니다.'), { once: true }));
      worklet.onprocessorerror = () => lostAudio('오디오 처리 오류. 받아쓰기 일부가 누락될 수 있습니다.');
      const changed = () => { const bytes = (current.mediaQueue?.pendingBytes ?? 0) + (current.audioQueue?.pendingBytes ?? 0); update(() => setPendingBytes(bytes)); if (bytes > 32 * 1024 * 1024 && !current.stopping) failed(new Error('업로드 대기 증가')); };
      const windows = new Map<number, AudioWindow>();
      current.audioQueue = new OrderedUploadQueue(8 * 1024 * 1024, async (bytes, sequence) => { const window = windows.get(sequence)!; await uploadAudio(current.session!.id, sequence, bytes, window.startMs, window.endMs); windows.delete(sequence); changed(); }, failed);
      let audioSequence = 0;
      current.audio = new AudioWindows(current.context.sampleRate, window => { windows.set(audioSequence++, window); current.audioQueue!.add(window.bytes); changed(); if (current.audioQueue!.pendingCount >= 12 && !current.stopping) failed(new Error('받아쓰기 대기 구간 증가')); });
      worklet.port.onmessage = event => {
        if (event.data.type === 'samples') { try { const samples = event.data.samples as Float32Array; current.audio!.push(samples); let energy = 0; for (const sample of samples) energy += sample * sample; const level = Math.min(1, Math.round(Math.sqrt(energy / Math.max(1, samples.length)) * 20) / 20); update(() => { setAudioLevel(level); setDurationMs(current.audio!.durationMs); }); } catch (cause) { current.fatal = String(cause); failed(new Error(String(cause))); } }
        else if (event.data.type === 'flushed') current.flushResolve?.();
      };
      current.mediaQueue = new OrderedUploadQueue(64 * 1024 * 1024, async (bytes, sequence) => { await uploadMedia(current.session!.id, sequence, bytes); changed(); }, failed);
      const mimeType = ['video/webm;codecs=vp8,opus', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type)); if (!mimeType) throw new Error('WebM 녹화를 지원하지 않습니다. Chrome/Edge를 사용해 주세요.');
      const recordingStream = new MediaStream([...current.display.getVideoTracks(), ...mix.stream.getAudioTracks()]);
      const media = new MediaRecorder(recordingStream, { mimeType, videoBitsPerSecond: 1200000, audioBitsPerSecond: 64000 }); current.recorder = media;
      media.ondataavailable = event => { if (!event.data.size) return; try { if (event.data.size > 16 * 1024 * 1024) throw new Error('녹화 구간이 16MB를 초과했습니다. 저장 일부가 누락될 수 있습니다.'); current.mediaQueue!.add(event.data); changed(); } catch (cause) { current.fatal = String(cause); failed(new Error(String(cause))); } };
      media.onerror = () => { current.fatal = '브라우저 녹화 오류. 영상 일부가 누락될 수 있습니다.'; failed(new Error(current.fatal)); };
      current.startedAt = Date.now(); connectSources(); media.start(2000); update(() => { setStatus('recording'); setPreview(current.display!); });
      current.timer = setInterval(() => { changed(); if (current.context?.state === 'suspended') { current.fatal = '오디오 처리 일시 중지. 끝부분 누락을 확인해 주세요.'; failed(new Error(current.fatal)); } }, 1000);
      current.cutoff = setTimeout(() => { update(() => setError('60분 제한에 도달해 녹화를 종료합니다.')); void stopRef.current(); }, MAX_MS);
    } catch (cause) {
      const message = cause instanceof DOMException && cause.name === 'NotAllowedError' ? '카메라·공유 또는 마이크 권한이 거부되었습니다. 권한을 확인하고 다시 시작해 주세요.'
        : cause instanceof DOMException && ['NotFoundError', 'NotReadableError'].includes(cause.name) ? '카메라·마이크를 사용할 수 없습니다. 장치 연결을 확인하고 다른 앱의 장치 사용을 종료한 뒤 다시 시작해 주세요.'
        : cause instanceof Error ? cause.message : '녹화를 시작하지 못했습니다.';
      update(() => setError(message)); release(current);
      if (current.session) await finish(current); else update(() => setStatus('idle'));
    }
  };
  const retry = async () => {
    const current = capture.current; if (!current?.session) return; update(() => { setStatus('finishing'); setError(current.fatal ?? ''); });
    try { await Promise.all([current.audioQueue?.retry(), current.mediaQueue?.retry()]); await finish(current); } catch (cause) { update(() => { setStatus('blocked'); setError(`저장 재시도 실패: ${cause instanceof Error ? cause.message : String(cause)}. 이 탭을 유지해 주세요.`); }); }
  };
  useEffect(() => {
    mounted.current = true;
    const beforeUnload = (event: BeforeUnloadEvent) => { if (capture.current && !['ready', 'idle'].includes(status)) { event.preventDefault(); event.returnValue = ''; } };
    const pageHide = () => {
      const current = capture.current; if (!current || ['ready', 'idle'].includes(status)) return;
      current.cancelled = true; current.stopping = true; current.stoppedAt = Date.now();
      current.fatal = '공유 탭이 닫혀 저장된 구간만 복구할 수 있습니다. 전송되지 않은 끝부분이 누락될 수 있습니다.';
      current.durationMs = Math.min(MAX_MS, Math.max(current.audio?.durationMs ?? 0, current.startedAt === undefined ? 0 : current.stoppedAt - current.startedAt));
      if (current.recorder && current.recorder.state !== 'inactive') { current.recorder.ondataavailable = null; current.recorder.stop(); }
      release(current); current.stopped = Promise.resolve(); update(() => { setStatus('idle'); setError(current.fatal!); });
      // Page departure cannot guarantee large pending bytes flush. Persist incomplete
      // status best-effort; otherwise recovered capture offers explicit finalization.
      if (current.session) void fetch(`/api/consultations/${encodeURIComponent(current.session.id)}/finish`, { method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ durationMs: current.durationMs, captureError: current.fatal }) }).catch(() => {});
    };
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('pagehide', pageHide);
    return () => { mounted.current = false; window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('pagehide', pageHide); };
  }, [status]);
  useEffect(() => () => { mounted.current = false; const current = capture.current; if (current) { current.cancelled = true; void stopRef.current(); } }, []);
  return { status, error, session, durationMs, pendingBytes, audioLevel, preview, start, stop, retry, busy: ['requesting', 'preparing', 'recording', 'finishing', 'blocked'].includes(status) };
}
