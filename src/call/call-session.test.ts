import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallSession, type SignalChannel, type SignalHandler } from './call-session';

class FakeTrack extends EventTarget {
  readonly id = crypto.randomUUID(); enabled = true; readyState = 'live'; muted = false;
  constructor(readonly kind: 'audio' | 'video') { super(); }
  stop = vi.fn(() => { this.readyState = 'ended'; });
}
class FakeStream {
  constructor(private tracks: FakeTrack[] = []) {}
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); }
  getVideoTracks() { return this.tracks.filter(track => track.kind === 'video'); }
  addTrack(track: FakeTrack) { this.tracks.push(track); }
  removeTrack(track: FakeTrack) { this.tracks = this.tracks.filter(item => item !== track); }
}
class FakeTransceiver {
  mid: string | null = null; direction = 'sendrecv'; currentDirection: string | null = null;
  sender = { track: null as FakeTrack | null, replaceTrack: vi.fn(async (track: FakeTrack | null) => { this.sender.track = track; }) };
  receiver: { track: FakeTrack };
  constructor(readonly kind: 'audio' | 'video') { this.receiver = { track: new FakeTrack(kind) }; }
}
class FakePeer extends EventTarget {
  static instances: FakePeer[] = [];
  transceivers: FakeTransceiver[] = [];
  signalingState = 'stable'; iceConnectionState = 'new'; connectionState = 'new';
  localDescription: { type: string; sdp: string } | null = null; remoteDescription: { type: string; sdp: string } | null = null;
  setRemoteDescription = vi.fn(async (description: { type: string; sdp: string }) => { this.remoteDescription = description; this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable'; if (description.type === 'offer' && !this.transceivers.length) { this.transceivers = [new FakeTransceiver('audio'), new FakeTransceiver('video')]; } });
  setLocalDescription = vi.fn(async () => { const type = this.signalingState === 'have-remote-offer' ? 'answer' : 'offer'; this.localDescription = { type, sdp: `${type}-sdp` }; this.signalingState = type === 'offer' ? 'have-local-offer' : 'stable'; });
  addIceCandidate = vi.fn(async (_candidate: unknown) => {});
  restartIce = vi.fn();
  close = vi.fn();
  getStats = vi.fn(async () => new Map());
  addTrack = vi.fn((track: FakeTrack) => { const transceiver = new FakeTransceiver(track.kind); transceiver.sender.track = track; this.transceivers.push(transceiver); return transceiver.sender; });
  removeTrack = vi.fn((sender: { track: FakeTrack | null }) => { sender.track = null; });
  constructor(readonly config: RTCConfiguration) { super(); FakePeer.instances.push(this); }
  addTransceiver(kind: 'audio' | 'video') { const transceiver = new FakeTransceiver(kind); this.transceivers.push(transceiver); return transceiver; }
  getTransceivers() { return this.transceivers; }
  getSenders() { return this.transceivers.map(item => item.sender); }
  needNegotiation() { this.dispatchEvent(new Event('negotiationneeded')); }
  setIce(state: string) { this.iceConnectionState = state; this.dispatchEvent(new Event('iceconnectionstatechange')); }
}
function fakeSignal() {
  const sent: any[] = []; let handler: SignalHandler = () => {};
  const channel: SignalChannel = { send: message => { sent.push(message); }, close: vi.fn() };
  return { sent, channel, open: (next: SignalHandler) => { handler = next; return channel; }, emit: (message: any) => handler(message) };
}
const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
function build(role: 'trainer' | 'guardian', options: { tracks?: FakeTrack[]; display?: () => Promise<MediaStream>; forceRelay?: boolean } = {}) {
  const signal = fakeSignal();
  const local = new FakeStream(options.tracks ?? [new FakeTrack('audio'), new FakeTrack('video')]);
  const session = new CallSession({ role, iceServers: [{ urls: 'stun:example' }], forceRelay: options.forceRelay, localStream: local as unknown as MediaStream, openSignal: signal.open,
    createPeer: config => new FakePeer(config) as unknown as RTCPeerConnection, createStream: () => new FakeStream() as unknown as MediaStream, getDisplayMedia: options.display });
  session.start();
  return { session, signal, local, peer: () => FakePeer.instances.at(-1)! };
}

beforeEach(() => { FakePeer.instances = []; vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('first connection', () => {
  it('passes ICE servers and the relay policy to the peer', () => {
    const { peer } = build('trainer', { forceRelay: true });
    expect(peer().config).toMatchObject({ iceServers: [{ urls: 'stun:example' }], iceTransportPolicy: 'relay' });
  });
  it('makes the trainer offer once the guardian is online, not before', async () => {
    const { signal, peer } = build('trainer');
    peer().needNegotiation(); await flush();
    expect(signal.sent).toEqual([]);
    signal.emit({ type: 'hello', role: 'trainer', serverNow: 1, peerOnline: true }); await flush();
    expect(signal.sent.filter(item => item.type === 'offer')).toHaveLength(1);
  });
  it('never makes the guardian send the first offer', async () => {
    const { signal, peer } = build('guardian');
    signal.emit({ type: 'hello', role: 'guardian', serverNow: 1, peerOnline: true }); await flush();
    peer().needNegotiation(); await flush();
    expect(signal.sent.filter(item => item.type === 'offer')).toHaveLength(0);
  });
  it('attaches the guardian local tracks to the transceivers from the trainer offer', async () => {
    const audio = new FakeTrack('audio'); const video = new FakeTrack('video');
    const { signal, peer } = build('guardian', { tracks: [audio, video] });
    signal.emit({ type: 'offer', sdp: 'trainer' }); await flush();
    expect(peer().transceivers[0].sender.replaceTrack).toHaveBeenCalledWith(audio);
    expect(peer().transceivers[1].sender.replaceTrack).toHaveBeenCalledWith(video);
    expect(signal.sent.at(-1)).toEqual({ type: 'answer', sdp: 'answer-sdp' });
  });
  it('offers receive slots for audio and video even without local devices', async () => {
    const { peer } = build('trainer', { tracks: [] });
    expect(peer().transceivers.map(item => item.kind)).toEqual(['audio', 'video']);
    expect(peer().transceivers.every(item => item.sender.track === null)).toBe(true);
  });
  it('announces media state to the peer when it comes online', async () => {
    const { signal } = build('trainer');
    signal.emit({ type: 'hello', role: 'trainer', serverNow: 1, peerOnline: false });
    signal.emit({ type: 'peer-joined' }); await flush();
    expect(signal.sent).toContainEqual({ type: 'media', camera: true, microphone: true, screen: false });
  });
});

describe('perfect negotiation', () => {
  it('has the impolite trainer ignore a colliding offer', async () => {
    const { signal, peer } = build('trainer');
    signal.emit({ type: 'hello', role: 'trainer', serverNow: 1, peerOnline: true }); await flush();
    expect(peer().signalingState).toBe('have-local-offer');
    peer().setRemoteDescription.mockClear();
    signal.emit({ type: 'offer', sdp: 'guardian' }); await flush();
    expect(peer().setRemoteDescription).not.toHaveBeenCalled();
  });
  it('has the polite guardian accept a colliding offer and answer', async () => {
    const { signal, peer } = build('guardian');
    signal.emit({ type: 'offer', sdp: 'first' }); await flush();
    signal.emit({ type: 'answer', sdp: 'ignored' });
    peer().signalingState = 'have-local-offer';
    signal.emit({ type: 'offer', sdp: 'colliding' }); await flush();
    expect(peer().setRemoteDescription).toHaveBeenCalledWith({ type: 'offer', sdp: 'colliding' });
  });
  it('swallows candidate errors only for an ignored offer', async () => {
    const { signal, peer } = build('trainer');
    signal.emit({ type: 'hello', role: 'trainer', serverNow: 1, peerOnline: true }); await flush();
    signal.emit({ type: 'offer', sdp: 'guardian' }); await flush();
    peer().addIceCandidate.mockRejectedValueOnce(new Error('late'));
    signal.emit({ type: 'candidate', candidate: { candidate: 'x' } }); await flush();
    expect(peer().addIceCandidate).toHaveBeenCalled();
  });
  it('sends local candidates through the signal channel', async () => {
    const { signal, peer } = build('trainer');
    const event = Object.assign(new Event('icecandidate'), { candidate: { toJSON: () => ({ candidate: 'local' }) } });
    peer().dispatchEvent(event);
    expect(signal.sent).toContainEqual({ type: 'candidate', candidate: { candidate: 'local' } });
  });
});

describe('remote media', () => {
  function track(peer: FakePeer, transceiver: FakeTransceiver) {
    peer.dispatchEvent(Object.assign(new Event('track'), { track: transceiver.receiver.track, transceiver, streams: [] }));
  }
  it('puts the first audio and video in the remote stream and later video in the screen stream', async () => {
    const { session, signal, peer } = build('guardian');
    signal.emit({ type: 'offer', sdp: 'trainer' }); await flush();
    const [audio, video] = peer().transceivers;
    track(peer(), audio); track(peer(), video);
    const screen = new FakeTransceiver('video'); peer().transceivers.push(screen);
    track(peer(), screen);
    const state = session.snapshot();
    expect(state.remoteStream?.getTracks()).toHaveLength(2);
    expect(state.remoteScreen?.getVideoTracks()).toHaveLength(1);
  });
  it('shows the peer screen only while the peer reports sharing', async () => {
    const { session, signal } = build('guardian');
    signal.emit({ type: 'media', camera: true, microphone: false, screen: true });
    expect(session.snapshot().peerMedia).toEqual({ camera: true, microphone: false, screen: true });
    signal.emit({ type: 'media', camera: false, microphone: false, screen: false });
    expect(session.snapshot().peerMedia.screen).toBe(false);
  });
});

describe('controls', () => {
  it('toggles tracks and tells the peer', async () => {
    const audio = new FakeTrack('audio'); const video = new FakeTrack('video');
    const { session, signal } = build('trainer', { tracks: [audio, video] });
    session.toggleMicrophone();
    expect(audio.enabled).toBe(false);
    expect(signal.sent.at(-1)).toEqual({ type: 'media', camera: true, microphone: false, screen: false });
    session.toggleCamera();
    expect(video.enabled).toBe(false);
    expect(signal.sent.at(-1)).toEqual({ type: 'media', camera: false, microphone: false, screen: false });
  });
  it('adds a shared screen as separate tracks and keeps the camera', async () => {
    const screenVideo = new FakeTrack('video'); const screenAudio = new FakeTrack('audio');
    const camera = new FakeTrack('video');
    const display = vi.fn(async () => new FakeStream([screenVideo, screenAudio]) as unknown as MediaStream);
    const { session, signal, peer } = build('trainer', { tracks: [camera], display });
    await session.startScreenShare();
    expect(display).toHaveBeenCalledWith(expect.objectContaining({ audio: true, systemAudio: 'include', monitorTypeSurfaces: 'include', surfaceSwitching: 'include' }));
    expect(peer().addTrack).toHaveBeenCalledTimes(2);
    expect(peer().transceivers.find(item => item.kind === 'video')!.sender.track).toBe(camera);
    expect(signal.sent.at(-1)).toMatchObject({ type: 'media', screen: true });
    expect(session.snapshot().localScreen).toBeTruthy();
  });
  it('stops sharing when the browser ends the capture', async () => {
    const screenVideo = new FakeTrack('video');
    const { session, signal, peer } = build('trainer', { display: async () => new FakeStream([screenVideo]) as unknown as MediaStream });
    await session.startScreenShare();
    screenVideo.dispatchEvent(new Event('ended'));
    expect(peer().removeTrack).toHaveBeenCalled();
    expect(signal.sent.at(-1)).toMatchObject({ type: 'media', screen: false });
    expect(session.snapshot().localScreen).toBeNull();
  });
  it('reports a cancelled share picker without treating it as an error', async () => {
    const { session } = build('trainer', { display: async () => { throw new DOMException('cancelled', 'NotAllowedError'); } });
    await expect(session.startScreenShare()).resolves.toBeUndefined();
    expect(session.snapshot().error).toBe('');
    expect(session.snapshot().localScreen).toBeNull();
  });
  it('replaces the camera in place without renegotiating', async () => {
    const first = new FakeTrack('video'); const next = new FakeTrack('video');
    const { session, peer } = build('trainer', { tracks: [first] });
    const video = peer().transceivers.find(item => item.kind === 'video')!;
    await session.replaceCamera(next as unknown as MediaStreamTrack);
    expect(video.sender.replaceTrack).toHaveBeenCalledWith(next);
    expect(first.stop).toHaveBeenCalled();
    expect(peer().addTrack).not.toHaveBeenCalled();
  });
  it('closes everything on leave', () => {
    const audio = new FakeTrack('audio');
    const { session, signal, peer } = build('trainer', { tracks: [audio] });
    session.leave();
    expect(audio.stop).toHaveBeenCalled();
    expect(peer().close).toHaveBeenCalled();
    expect(signal.channel.close).toHaveBeenCalled();
    expect(session.snapshot().status).toBe('left');
  });
});

describe('recovery', () => {
  it('restarts ICE when the connection stays disconnected for five seconds', async () => {
    const { peer } = build('trainer');
    peer().setIce('disconnected');
    await vi.advanceTimersByTimeAsync(4900);
    expect(peer().restartIce).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(peer().restartIce).toHaveBeenCalledTimes(1);
  });
  it('cancels the restart when the connection recovers by itself', async () => {
    const { peer } = build('trainer');
    peer().setIce('disconnected');
    await vi.advanceTimersByTimeAsync(2000);
    peer().setIce('connected');
    await vi.advanceTimersByTimeAsync(5000);
    expect(peer().restartIce).not.toHaveBeenCalled();
  });
  it('restarts immediately on failure and reports reconnecting', () => {
    const { session, peer } = build('trainer');
    peer().setIce('failed');
    expect(peer().restartIce).toHaveBeenCalledTimes(1);
    expect(session.snapshot().status).toBe('reconnecting');
  });
  it('rebuilds the peer when the other side rejoins with a new call and keeps local tracks', async () => {
    const audio = new FakeTrack('audio');
    const { signal, peer } = build('trainer', { tracks: [audio] });
    const first = peer();
    signal.emit({ type: 'hello', role: 'trainer', serverNow: 1, peerOnline: true }); await flush();
    signal.emit({ type: 'peer-joined' }); await flush();
    expect(first.close).toHaveBeenCalled();
    expect(peer()).not.toBe(first);
    expect(peer().transceivers[0].sender.track).toBe(audio);
    expect(audio.stop).not.toHaveBeenCalled();
    expect(signal.sent.filter(item => item.type === 'offer').length).toBeGreaterThanOrEqual(2);
  });
  it('reports connected and exposes parsed stats', async () => {
    const { session, peer } = build('trainer');
    peer().getStats.mockResolvedValue(new Map<string, unknown>([
      ['v', { type: 'inbound-rtp', kind: 'video', framesDecoded: 12 }],
      ['a', { type: 'inbound-rtp', kind: 'audio', bytesReceived: 900, totalAudioEnergy: 0.25 }],
      ['p', { type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 0.05, localCandidateId: 'l' }],
      ['l', { type: 'local-candidate', candidateType: 'relay' }],
    ]) as never);
    peer().setIce('connected');
    expect(session.snapshot().status).toBe('connected');
    await vi.advanceTimersByTimeAsync(1100);
    expect(session.snapshot().stats).toEqual({ inboundVideoFrames: 12, inboundAudioBytes: 900, inboundAudioEnergy: 0.25, roundTripMs: 50, relayed: true });
  });
  it('stops polling stats after leaving', async () => {
    const { session, peer } = build('trainer');
    session.leave();
    peer().getStats.mockClear();
    await vi.advanceTimersByTimeAsync(3000);
    expect(peer().getStats).not.toHaveBeenCalled();
  });
});
