import { describe, expect, it, vi } from 'vitest';
import { openDevices } from './devices';

const track = (kind: 'audio' | 'video') => ({ kind, stop: vi.fn(), enabled: true }) as unknown as MediaStreamTrack;
const stream = (...tracks: MediaStreamTrack[]) => ({ getTracks: () => tracks, getAudioTracks: () => tracks.filter(item => item.kind === 'audio'), getVideoTracks: () => tracks.filter(item => item.kind === 'video') }) as unknown as MediaStream;
const failure = (name: string) => new DOMException('failed', name);

function media(handler: (constraints: MediaStreamConstraints) => Promise<MediaStream>) {
  return { getUserMedia: vi.fn(handler) };
}

describe('openDevices', () => {
  it('returns camera and microphone when both open', async () => {
    const result = await openDevices({}, media(async () => stream(track('audio'), track('video'))), () => stream());
    expect(result.missing).toEqual([]);
    expect(result.stream.getTracks()).toHaveLength(2);
  });
  it('falls back to audio only when the camera fails, reporting the reason', async () => {
    const devices = media(async constraints => { if (constraints.video) throw failure('NotFoundError'); return stream(track('audio')); });
    const result = await openDevices({}, devices, () => stream());
    expect(result.missing).toEqual([{ device: 'camera', reason: 'not-found' }]);
    expect(result.stream.getAudioTracks()).toHaveLength(1);
  });
  it('falls back to video only when the microphone fails', async () => {
    const devices = media(async constraints => { if (constraints.audio) throw failure('NotReadableError'); return stream(track('video')); });
    const result = await openDevices({}, devices, () => stream());
    expect(result.missing).toEqual([{ device: 'microphone', reason: 'busy' }]);
    expect(result.stream.getVideoTracks()).toHaveLength(1);
  });
  it('still returns an empty stream to receive-only join when nothing opens', async () => {
    const result = await openDevices({}, media(async () => { throw failure('NotAllowedError'); }), () => stream());
    expect(result.missing).toEqual([{ device: 'microphone', reason: 'denied' }, { device: 'camera', reason: 'denied' }]);
    expect(result.stream.getTracks()).toHaveLength(0);
  });
  it('reports unsupported browsers without calling getUserMedia', async () => {
    const result = await openDevices({}, undefined, () => stream());
    expect(result.missing.map(item => item.reason)).toEqual(['unsupported', 'unsupported']);
  });
  it('requests the chosen devices, facing mode, and voice processing', async () => {
    const devices = media(async () => stream(track('audio'), track('video')));
    await openDevices({ microphoneId: 'mic-1', cameraId: 'cam-1', facingMode: 'environment' }, devices, () => stream());
    const constraints = devices.getUserMedia.mock.calls[0][0] as { audio: MediaTrackConstraints; video: MediaTrackConstraints };
    expect(constraints.audio).toMatchObject({ deviceId: { exact: 'mic-1' }, echoCancellation: true, noiseSuppression: true });
    expect(constraints.video).toMatchObject({ deviceId: { exact: 'cam-1' } });
    await openDevices({ facingMode: 'environment' }, devices, () => stream());
    expect((devices.getUserMedia.mock.calls[1][0] as { video: MediaTrackConstraints }).video.facingMode).toEqual({ ideal: 'environment' });
  });
  it('skips devices the user turned off without reporting them missing', async () => {
    const devices = media(async () => stream(track('audio')));
    const result = await openDevices({ camera: false }, devices, () => stream());
    expect(result.missing).toEqual([]);
    expect(devices.getUserMedia.mock.calls[0][0]).toMatchObject({ video: false });
  });
});
