import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AudioWindows, OrderedUploadQueue, useConsultationRecorder } from './useConsultationRecorder';
import * as api from '../consultation-api';

vi.mock('../consultation-api', () => ({ createConsultation: vi.fn(), finishConsultation: vi.fn(), uploadAudio: vi.fn(), uploadMedia: vi.fn() }));
const metadata = { petName: '초코', trainerName: '훈련사', sessionDate: '2026-10-07' };
const session = { id: 'session-1', metadata, state: 'recording', createdAt: '', durationMs: 0, segments: [], bookmarks: [], recordingChunkCount: 0, errors: [] } as const;
class Track extends EventTarget { kind: string; stop = vi.fn(); constructor(kind: string, private surface = 'browser') { super(); this.kind = kind; } getSettings() { return { displaySurface: this.surface }; } }
class Stream { constructor(private tracks: Track[]) {} getTracks() { return this.tracks; } getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); } getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); } }
let display: Stream; const getDisplayMedia = vi.fn(); const getUserMedia = vi.fn();
let worklet: Worklet;
class Worklet { onprocessorerror: (()=>void) | null=null; port = { onmessage: null as ((e: {data: unknown}) => void) | null, postMessage: (data: { type: string }) => { if (data.type === 'flush') this.port.onmessage?.({ data: { type: 'flushed' } }); } }; constructor() { worklet = this; } connect() {} disconnect() {} }
class Context { sampleRate = 48000; currentTime = 0; state = 'running'; destination = {}; audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) }; createMediaStreamSource() { return { connect() {}, disconnect() {} }; } createMediaStreamDestination() { return { stream: new Stream([new Track('audio')]) }; } createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; } resume() { return Promise.resolve(); } close() { return Promise.resolve(); } }
let recorder: Recorder;
class Recorder { static isTypeSupported = () => true; state = 'inactive'; ondataavailable: ((e:{data:Blob}) => void) | null = null; onstop: (() => void) | null = null; onerror: (() => void) | null = null; constructor() { recorder = this; } start() { this.state = 'recording'; } stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['webm'], { type: 'video/webm' }) }); this.onstop?.(); } }
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); display = new Stream([new Track('video'), new Track('audio')]);
  getDisplayMedia.mockResolvedValue(display); getUserMedia.mockResolvedValue(new Stream([new Track('audio')]));
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia, getUserMedia } });
  vi.stubGlobal('AudioContext', Context); vi.stubGlobal('AudioWorkletNode', Worklet); vi.stubGlobal('MediaStream', Stream); vi.stubGlobal('MediaRecorder', Recorder);
  vi.mocked(api.createConsultation).mockResolvedValue(session as never); vi.mocked(api.finishConsultation).mockResolvedValue({ ...session, state: 'ready' } as never); vi.mocked(api.uploadAudio).mockResolvedValue(session as never); vi.mocked(api.uploadMedia).mockResolvedValue(session as never);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
test('WAV windows preserve full resampled timeline and flush short tail', () => {
  const windows: {bytes: Blob; startMs:number; endMs:number}[] = [];
  const audio = new AudioWindows(48000, w => windows.push(w));
  for (let i = 0; i < 21; i++) audio.push(new Float32Array(24000).fill(0.2));
  audio.flush();
  expect(windows.map(w => [w.startMs, w.endMs])).toEqual([[0, 10000], [10000, 10500]]);
  expect(windows.map(w => w.bytes.size)).toEqual([320044, 16044]);
});
test('canonical WAV is mono16k16bit with exact44byte header', async () => {
  vi.useRealTimers();
  let wav!: Blob; const audio = new AudioWindows(16000, w => { wav = w.bytes; }); audio.push(new Float32Array([1, -1, 0])); audio.flush();
  const bytes = await new Promise<ArrayBuffer>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result as ArrayBuffer);reader.onerror=()=>reject(reader.error);reader.readAsArrayBuffer(wav);}); const view = new DataView(bytes);
  expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('RIFF'); expect(view.getUint16(22, true)).toBe(1); expect(view.getUint32(24, true)).toBe(16000); expect(view.getUint16(34, true)).toBe(16); expect(view.getUint32(40, true)).toBe(6);
});
test('ordered queue retains failed bytes and retries same head before next', async () => {
  const seen:number[]=[]; let fail=true;
  const queue = new OrderedUploadQueue(100, async (_bytes, sequence) => { seen.push(sequence); if (fail) throw new Error('offline'); });
  queue.add(new Blob(['first'])); queue.add(new Blob(['next'])); await expect(queue.drain()).rejects.toThrow('offline'); expect(queue.pendingBytes).toBe(9);
  fail=false; await queue.retry(); expect(seen).toEqual([0,0,1]); expect(queue.pendingBytes).toBe(0);
});
test('bounded queue refuses oversized backlog visibly', async () => {
  const queue = new OrderedUploadQueue(4, async () => { throw new Error('offline'); }); queue.add(new Blob(['1234']));
  expect(() => queue.add(new Blob(['5']))).toThrow(/업로드/); await expect(queue.drain()).rejects.toThrow();
});
test('display picker runs in click gesture before model prepare', async () => {
  const { result } = renderHook(() => useConsultationRecorder()); let start!:Promise<void>;
  act(() => { start=result.current.start(metadata, false); expect(getDisplayMedia).toHaveBeenCalledTimes(1); expect(api.createConsultation).not.toHaveBeenCalled(); });
  await act(() => start); expect(result.current.status).toBe('recording'); expect(getUserMedia).not.toHaveBeenCalled();
  await act(() => result.current.stop());
});
test('permission rejection never creates server capture', async () => {
  getDisplayMedia.mockRejectedValue(new DOMException('denied','NotAllowedError')); const {result}=renderHook(()=>useConsultationRecorder()); await act(()=>result.current.start(metadata,false));
  expect(result.current.error).toMatch(/권한/); expect(api.createConsultation).not.toHaveBeenCalled();
});
test.each(['no-audio','monitor'])('rejects invalid capture %s and releases tracks', async mode => {
  display = new Stream([new Track('video', mode==='monitor'?'monitor':'browser'), ...(mode==='no-audio'?[]:[new Track('audio')])]); getDisplayMedia.mockResolvedValue(display);
  const {result}=renderHook(()=>useConsultationRecorder()); await act(()=>result.current.start(metadata,false)); expect(result.current.error).toMatch(/탭/); expect(api.createConsultation).not.toHaveBeenCalled(); expect(display.getTracks()[0].stop).toHaveBeenCalled();
});
test('optional microphone uses echo cancellation and is released on stop', async () => {
  const {result}=renderHook(()=>useConsultationRecorder()); await act(()=>result.current.start(metadata,true)); expect(getUserMedia).toHaveBeenCalledWith({audio:{echoCancellation:true,noiseSuppression:true},video:false});
  await act(()=>result.current.stop()); expect(display.getTracks()[0].stop).toHaveBeenCalled();
});
test('stop flushes final audio and media before finish', async () => {
  const order:string[]=[]; vi.mocked(api.uploadAudio).mockImplementation(async()=>{order.push('audio');return session as never;}); vi.mocked(api.uploadMedia).mockImplementation(async()=>{order.push('media');return session as never;}); vi.mocked(api.finishConsultation).mockImplementation(async()=>{order.push('finish');return session as never;});
  const {result}=renderHook(()=>useConsultationRecorder()); await act(()=>result.current.start(metadata,false));
  act(()=>worklet.port.onmessage?.({data:{type:'samples',samples:new Float32Array(24000).fill(.2)}})); await act(()=>result.current.stop());
  expect(order.at(-1)).toBe('finish'); expect(order).toContain('audio'); expect(order).toContain('media'); expect(api.finishConsultation).toHaveBeenCalledWith('session-1',500);
});
test('sharing-ended invokes same finalization', async () => {
  const {result}=renderHook(()=>useConsultationRecorder()); await act(()=>result.current.start(metadata,false)); await act(async()=>display.getVideoTracks()[0].dispatchEvent(new Event('ended'))); expect(api.finishConsultation).toHaveBeenCalledTimes(1);
});
test('60minute wall limit stops recording and flushes', async () => {
  const {result}=renderHook(()=>useConsultationRecorder()); await act(()=>result.current.start(metadata,false)); await act(async()=>vi.advanceTimersByTime(3600000)); expect(recorder.state).toBe('inactive'); expect(api.finishConsultation).toHaveBeenCalledTimes(1);
});
test('failed media remains available for retry and prevents premature finish', async () => {
  vi.mocked(api.uploadMedia).mockRejectedValue(new Error('offline')); const {result}=renderHook(()=>useConsultationRecorder()); await act(()=>result.current.start(metadata,false)); await act(()=>result.current.stop()); expect(result.current.status).toBe('blocked'); expect(api.finishConsultation).not.toHaveBeenCalled();
  vi.mocked(api.uploadMedia).mockResolvedValue(session as never); await act(()=>result.current.retry()); expect(api.finishConsultation).toHaveBeenCalledTimes(1); expect(result.current.status).toBe('ready');
});
test('irrecoverable media failure reports captureError and actual elapsed duration', async()=>{
  const {result}=renderHook(()=>useConsultationRecorder()); await act(()=>result.current.start(metadata,false)); act(()=>vi.advanceTimersByTime(2000)); await act(async()=>recorder.onerror?.());
  expect(api.finishConsultation).toHaveBeenCalledWith('session-1',2000,expect.stringContaining('누락')); expect(result.current.error).toContain('누락');
});
test('unmount finalizes accepted capture and releases sharing tracks',async()=>{
  const {result,unmount}=renderHook(()=>useConsultationRecorder()); await act(()=>result.current.start(metadata,false)); await act(async()=>unmount()); expect(display.getTracks()[0].stop).toHaveBeenCalled(); expect(api.finishConsultation).toHaveBeenCalledTimes(1);
});
test.each(['microphone','tab-audio','processor'])('irrecoverable %s disconnect reports loss and stops capture',async(kind)=>{
  const {result}=renderHook(()=>useConsultationRecorder()); await act(()=>result.current.start(metadata,kind==='microphone')); act(()=>vi.advanceTimersByTime(1000));
  await act(async()=>{if(kind==='processor')worklet.onprocessorerror?.();else if(kind==='microphone')(await getUserMedia.mock.results[0].value).getAudioTracks()[0].dispatchEvent(new Event('ended'));else display.getAudioTracks()[0].dispatchEvent(new Event('ended'));});
  expect(api.finishConsultation).toHaveBeenCalledWith('session-1',1000,expect.any(String)); expect(display.getVideoTracks()[0].stop).toHaveBeenCalled();
});
test('audio meter returns to zero after capture stops',async()=>{
  const {result}=renderHook(()=>useConsultationRecorder());await act(()=>result.current.start(metadata,false));act(()=>worklet.port.onmessage?.({data:{type:'samples',samples:new Float32Array(4800).fill(.2)}}));expect(result.current.audioLevel).toBe(.2);await act(()=>result.current.stop());expect(result.current.audioLevel).toBe(0);
});
test('page departure releases hardware and reports incomplete recovery with keepalive',async()=>{
  const fetcher=vi.fn().mockResolvedValue({ok:true});vi.stubGlobal('fetch',fetcher);const {result}=renderHook(()=>useConsultationRecorder());await act(()=>result.current.start(metadata,false));act(()=>vi.advanceTimersByTime(1000));act(()=>window.dispatchEvent(new Event('pagehide')));expect(display.getVideoTracks()[0].stop).toHaveBeenCalled();expect(fetcher).toHaveBeenCalledWith('/api/consultations/session-1/finish',expect.objectContaining({method:'POST',credentials:'same-origin',keepalive:true}));expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({durationMs:1000,captureError:expect.stringContaining('닫혀')});
});
