import { MAX_RECORDING_MS, type Caption, type MomentNotice, type Speaker, type SpeechStatus } from '../domain/coaching';
import { estimateOffset, type ClockSample } from './clock';

export type PeerMedia = { camera: boolean; microphone: boolean; screen: boolean };
export type SignalMessage =
  | { type: 'hello'; role: Speaker; serverNow: number; peerOnline: boolean }
  | { type: 'peer-joined' }
  | { type: 'offer' | 'answer'; sdp: string }
  | { type: 'candidate'; candidate: RTCIceCandidateInit | null }
  | ({ type: 'media' } & PeerMedia)
  | { type: 'state'; consent: Record<Speaker, boolean>; recording: boolean; recordingStartedAt?: number; state: string; peerOnline: boolean }
  | { type: 'caption'; replay?: boolean; segments: Caption[] }
  | ({ type: 'moment' } & MomentNotice)
  | { type: 'speech'; status: SpeechStatus }
  | { type: 'pong'; at: number; serverNow: number }
  | { type: 'error'; code: string };
export type OutgoingSignal = Extract<SignalMessage, { type: 'offer' | 'answer' | 'candidate' | 'media' }> | { type: 'ping'; at: number };
export type SignalHandler = (message: SignalMessage) => void;
export type SignalChannel = { send(message: OutgoingSignal): void; close(): void };
export type CallStats = { inboundVideoFrames: number; inboundAudioBytes: number; inboundAudioEnergy: number; roundTripMs: number | null; relayed: boolean };
export type CallStatus = 'waiting' | 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'left';
export type CallSnapshot = {
  status: CallStatus; peerOnline: boolean; peerMedia: PeerMedia; stats: CallStats; error: string;
  microphoneOn: boolean; cameraOn: boolean; hasCamera: boolean; hasMicrophone: boolean;
  localStream: MediaStream; localScreen: MediaStream | null; remoteStream: MediaStream | null; remoteScreen: MediaStream | null;
  consent: Record<Speaker, boolean>; recording: boolean; consultationState: string;
  captions: Caption[]; speech: SpeechStatus; lastMoment: MomentNotice | null; captionLatencyMs: number | null; uploadLost: boolean;
  /** Minutes of recording left near the limit, 0 once it stopped, otherwise null. */
  recordingLeftMinutes: number | null;
};
export type SessionRecorder = {
  start(clock: () => number): void; stop(options: { flush: boolean }): void;
  moment(moment: { id: string; atMs: number }): void; setScreen(stream: MediaStream | null): void;
  drain(): Promise<void>;
};
type DisplayOptions = DisplayMediaStreamOptions & { systemAudio?: string; monitorTypeSurfaces?: string; surfaceSwitching?: string };
type Options = {
  role: Speaker; iceServers: RTCIceServer[]; forceRelay?: boolean; localStream: MediaStream;
  openSignal: (handler: SignalHandler) => SignalChannel;
  createPeer?: (config: RTCConfiguration) => RTCPeerConnection;
  createStream?: () => MediaStream;
  getDisplayMedia?: (options: DisplayOptions) => Promise<MediaStream>;
  recorder?: SessionRecorder;
  onChange?: () => void;
};

const DISCONNECT_GRACE_MS = 5000;
const CONNECT_LIMIT_MS = 30000;
const FINAL_UPLOAD_WAIT_MS = 4000;
const STATS_INTERVAL_MS = 1000;
const RECORDING_WARNING_MS = 5 * 60 * 1000;
// Stops a little early, since the last window has to end before the limit to be accepted.
const RECORDING_STOP_MARGIN_MS = 3000;
const CLOCK_PING_DELAYS_MS = [0, 250, 500];
const NO_STATS: CallStats = { inboundVideoFrames: 0, inboundAudioBytes: 0, inboundAudioEnergy: 0, roundTripMs: null, relayed: false };

/** One participant's side of the call, kept free of React so negotiation can be tested without a browser. */
export class CallSession {
  private readonly options: Options;
  private readonly polite: boolean;
  private readonly createStream: () => MediaStream;
  private signal: SignalChannel | undefined;
  private peer!: RTCPeerConnection;
  private makingOffer = false;
  private ignoreOffer = false;
  /** The trainer holds back offers until the guardian exists to receive them. */
  private canOffer = false;
  private needsOffer = false;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private connectTimer: ReturnType<typeof setTimeout> | undefined;
  private statsTimer: ReturnType<typeof setInterval> | undefined;
  private screenStream: MediaStream | null = null;
  private screenSenders: RTCRtpSender[] = [];
  private clockSamples: ClockSample[] = [];
  /** Server time minus browser time, once measured. */
  private clockOffset: number | undefined;
  private clockTimers: ReturnType<typeof setTimeout>[] = [];
  private recordingStartedAt: number | undefined;
  private snapshotValue: CallSnapshot;

  constructor(options: Options) {
    this.options = options;
    this.polite = options.role === 'guardian';
    this.createStream = options.createStream ?? (() => new MediaStream());
    const audio = options.localStream.getAudioTracks()[0]; const video = options.localStream.getVideoTracks()[0];
    this.snapshotValue = { status: 'waiting', peerOnline: false, peerMedia: { camera: false, microphone: false, screen: false }, stats: NO_STATS, error: '',
      microphoneOn: !!audio, cameraOn: !!video, hasCamera: !!video, hasMicrophone: !!audio,
      localStream: options.localStream, localScreen: null, remoteStream: null, remoteScreen: null,
      consent: { guardian: false, trainer: false }, recording: false, consultationState: 'live',
      captions: [], speech: 'off', lastMoment: null, captionLatencyMs: null, uploadLost: false, recordingLeftMinutes: null };
  }

  snapshot() { return this.snapshotValue; }
  private update(change: Partial<CallSnapshot>) {
    this.snapshotValue = { ...this.snapshotValue, ...change };
    this.watchConnection();
    this.options.onChange?.();
  }

  /** Trying forever looks the same as working, so a connection that stays down is reported. It can still recover afterwards. */
  private watchConnection() {
    const { status } = this.snapshotValue;
    if (status === 'connecting' || status === 'reconnecting') {
      this.connectTimer ??= setTimeout(() => { this.connectTimer = undefined; this.update({ status: 'failed' }); }, CONNECT_LIMIT_MS);
    } else if (status !== 'failed') { clearTimeout(this.connectTimer); this.connectTimer = undefined; }
  }

  start() {
    this.buildPeer();
    this.signal = this.options.openSignal(message => { void this.handleSignal(message); });
    this.statsTimer = setInterval(() => { this.checkRecordingLimit(); void this.readStats(); }, STATS_INTERVAL_MS);
  }

  private buildPeer() {
    const { iceServers, forceRelay, createPeer, role, localStream } = this.options;
    const config: RTCConfiguration = { iceServers, ...(forceRelay ? { iceTransportPolicy: 'relay' as const } : {}) };
    const peer = createPeer ? createPeer(config) : new RTCPeerConnection(config);
    this.peer = peer;
    this.makingOffer = false; this.ignoreOffer = false; this.screenSenders = [];
    this.update({ remoteStream: null, remoteScreen: null });
    // The offerer creates the m-lines so both sides agree on which slot is the camera and which is the microphone.
    if (role === 'trainer') for (const kind of ['audio', 'video'] as const) {
      const track = kind === 'audio' ? localStream.getAudioTracks()[0] : localStream.getVideoTracks()[0];
      const transceiver = peer.addTransceiver(kind, { direction: 'sendrecv' });
      void transceiver.sender.replaceTrack(track ?? null);
    }
    peer.addEventListener('negotiationneeded', () => { void this.negotiate(peer); });
    peer.addEventListener('icecandidate', event => { if (event.candidate) this.signal?.send({ type: 'candidate', candidate: event.candidate.toJSON() }); });
    peer.addEventListener('track', event => this.attachRemote(peer, event));
    peer.addEventListener('iceconnectionstatechange', () => this.onIceState(peer));
  }

  private async negotiate(peer: RTCPeerConnection) {
    if (peer !== this.peer) return;
    if (!this.canOffer) { this.needsOffer = true; return; }
    try {
      this.makingOffer = true;
      await peer.setLocalDescription();
      this.signal?.send({ type: 'offer', sdp: peer.localDescription!.sdp });
    } catch { this.update({ error: '연결 정보를 만들지 못했습니다. 다시 입장해 주세요.' }); }
    finally { this.makingOffer = false; }
  }

  private sendOfferNow() {
    this.canOffer = true; this.needsOffer = false;
    void this.negotiate(this.peer);
  }

  private async handleSignal(message: SignalMessage) {
    switch (message.type) {
      case 'hello':
        this.measureClock();
        this.update({ peerOnline: message.peerOnline, status: message.peerOnline ? 'connecting' : this.snapshotValue.status });
        if (message.peerOnline) this.announceMedia();
        if (message.peerOnline && this.options.role === 'trainer' && !this.peer.remoteDescription) this.sendOfferNow();
        return;
      case 'peer-joined':
        this.update({ peerOnline: true, status: 'connecting' });
        this.peer.close();
        this.canOffer = false;
        this.buildPeer();
        this.announceMedia();
        if (this.options.role === 'trainer') this.sendOfferNow();
        return;
      case 'offer':
      case 'answer': return this.handleDescription(message);
      case 'candidate':
        try { await this.peer.addIceCandidate(message.candidate ?? undefined); }
        catch { if (!this.ignoreOffer) this.update({ error: '연결 후보를 처리하지 못했습니다.' }); }
        return;
      case 'media': {
        const { camera, microphone, screen } = message;
        this.update({ peerMedia: { camera, microphone, screen } });
        return;
      }
      case 'state':
        this.recordingStartedAt = message.recordingStartedAt;
        this.update({ consent: message.consent, recording: message.recording, consultationState: message.state, peerOnline: message.peerOnline,
          ...(message.peerOnline ? this.snapshotValue.status === 'waiting' ? { status: 'connecting' as const } : {} : { status: 'waiting' as const, peerMedia: { camera: false, microphone: false, screen: false } }) });
        this.syncRecorder();
        return;
      case 'caption': return this.mergeCaptions(message.segments, !!message.replay);
      case 'moment': {
        const { id, atMs, createdBy } = message;
        this.update({ lastMoment: { id, atMs, createdBy } });
        this.options.recorder?.moment({ id, atMs });
        return;
      }
      case 'speech':
        this.update({ speech: message.status });
        return;
      case 'pong':
        this.clockSamples.push({ sentAt: message.at, receivedAt: Date.now(), serverNow: message.serverNow });
        this.clockOffset = estimateOffset(this.clockSamples);
        this.syncRecorder();
        return;
      case 'error': return;
    }
  }

  /** Samples are kept across reconnects, because the fastest round trip of the whole call is the most trustworthy. */
  private measureClock() {
    this.clockTimers.forEach(clearTimeout);
    this.clockTimers = CLOCK_PING_DELAYS_MS.map(delay => setTimeout(() => this.signal?.send({ type: 'ping', at: Date.now() }), delay));
  }

  /** Recording time on the server's clock, so both browsers place evidence on one timeline. */
  private recordingNow() {
    return Date.now() + this.clockOffset! - this.recordingStartedAt!;
  }

  private checkRecordingLimit() {
    if (!this.snapshotValue.recording || this.recordingStartedAt === undefined || this.clockOffset === undefined) return;
    const left = MAX_RECORDING_MS - this.recordingNow();
    const minutes = left <= RECORDING_STOP_MARGIN_MS ? 0 : left <= RECORDING_WARNING_MS ? Math.ceil(left / 60000) : null;
    if (minutes !== this.snapshotValue.recordingLeftMinutes) this.update({ recordingLeftMinutes: minutes });
    if (minutes === 0) this.options.recorder?.stop({ flush: true });
  }

  private syncRecorder() {
    const { recording, consultationState, recordingLeftMinutes } = this.snapshotValue;
    if (recordingLeftMinutes === 0 && recording) return;
    if (recording && this.recordingStartedAt !== undefined && this.clockOffset !== undefined) this.options.recorder?.start(() => this.recordingNow());
    // A withdrawal means stop now and send nothing more. The end of the consultation still owes the last words.
    else if (!recording) this.options.recorder?.stop({ flush: consultationState !== 'live' });
  }

  private mergeCaptions(segments: Caption[], replay: boolean) {
    const byId = new Map(this.snapshotValue.captions.map(item => [item.id, item]));
    for (const segment of segments) byId.set(segment.id, segment);
    const captions = [...byId.values()].sort((left, right) => left.startMs - right.startMs);
    const newest = segments.at(-1);
    const measurable = !replay && newest?.state === 'complete' && this.recordingStartedAt !== undefined && this.clockOffset !== undefined;
    this.update({ captions, ...(measurable ? { captionLatencyMs: Math.round(this.recordingNow() - newest.endMs) } : {}) });
  }

  noteUploadLost() { this.update({ uploadLost: true }); }

  private async handleDescription(description: { type: 'offer' | 'answer'; sdp: string }) {
    const peer = this.peer;
    const collision = description.type === 'offer' && (this.makingOffer || peer.signalingState !== 'stable');
    this.ignoreOffer = !this.polite && collision;
    if (this.ignoreOffer) return;
    try {
      await peer.setRemoteDescription(description);
      if (description.type !== 'offer') return;
      if (this.options.role === 'guardian') await this.attachLocalToOffer(peer);
      await peer.setLocalDescription();
      this.signal?.send({ type: 'answer', sdp: peer.localDescription!.sdp });
      // After the first exchange the guardian may renegotiate too, for example to share a screen.
      if (this.polite) { this.canOffer = true; if (this.needsOffer) { this.needsOffer = false; void this.negotiate(peer); } }
    } catch { this.update({ error: '연결 설정을 적용하지 못했습니다. 다시 입장해 주세요.' }); }
  }

  /** The guardian answers on the trainer's slots rather than adding its own, which would duplicate the m-lines. */
  private async attachLocalToOffer(peer: RTCPeerConnection) {
    const { localStream } = this.options;
    for (const kind of ['audio', 'video'] as const) {
      const transceiver = peer.getTransceivers().find(item => this.kindOf(item) === kind);
      const track = kind === 'audio' ? localStream.getAudioTracks()[0] : localStream.getVideoTracks()[0];
      if (!transceiver || transceiver.sender.track === (track ?? null)) continue;
      transceiver.direction = 'sendrecv';
      await transceiver.sender.replaceTrack(track ?? null);
    }
  }

  private kindOf(transceiver: RTCRtpTransceiver) {
    return (transceiver as RTCRtpTransceiver & { kind?: string }).kind ?? transceiver.receiver.track.kind;
  }

  private attachRemote(peer: RTCPeerConnection, event: RTCTrackEvent) {
    const kind = event.track.kind;
    const primary = peer.getTransceivers().find(item => this.kindOf(item) === kind);
    if (event.transceiver === primary) {
      const stream = this.snapshotValue.remoteStream ?? this.createStream();
      stream.addTrack(event.track);
      this.update({ remoteStream: stream });
    } else {
      const stream = this.snapshotValue.remoteScreen ?? this.createStream();
      stream.addTrack(event.track);
      this.update({ remoteScreen: stream });
    }
  }

  private onIceState(peer: RTCPeerConnection) {
    if (peer !== this.peer) return;
    const state = peer.iceConnectionState;
    clearTimeout(this.restartTimer);
    if (state === 'connected' || state === 'completed') this.update({ status: 'connected', error: '' });
    else if (state === 'disconnected') {
      this.update({ status: 'reconnecting' });
      this.restartTimer = setTimeout(() => peer.restartIce(), DISCONNECT_GRACE_MS);
    } else if (state === 'failed') { this.update({ status: 'reconnecting' }); peer.restartIce(); }
  }

  private async readStats() {
    const reports = await this.peer.getStats().catch(() => null);
    if (!reports || this.snapshotValue.status === 'left') return;
    const stats: CallStats = { ...NO_STATS };
    reports.forEach((report: Record<string, unknown>) => {
      if (report.type === 'inbound-rtp' && report.kind === 'video') stats.inboundVideoFrames += Number(report.framesDecoded ?? 0);
      if (report.type === 'inbound-rtp' && report.kind === 'audio') { stats.inboundAudioBytes += Number(report.bytesReceived ?? 0); stats.inboundAudioEnergy += Number(report.totalAudioEnergy ?? 0); }
      if (report.type === 'candidate-pair' && report.nominated && report.state === 'succeeded') {
        if (typeof report.currentRoundTripTime === 'number') stats.roundTripMs = Math.round(report.currentRoundTripTime * 1000);
        const local = reports.get(String(report.localCandidateId)) as { candidateType?: string } | undefined;
        stats.relayed = local?.candidateType === 'relay';
      }
    });
    this.update({ stats });
  }

  private announceMedia() {
    const { microphoneOn, cameraOn, localScreen } = this.snapshotValue;
    this.signal?.send({ type: 'media', camera: cameraOn, microphone: microphoneOn, screen: !!localScreen });
  }

  toggleMicrophone() {
    const track = this.options.localStream.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    this.update({ microphoneOn: track.enabled });
    this.announceMedia();
  }

  toggleCamera() {
    const track = this.options.localStream.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    this.update({ cameraOn: track.enabled });
    this.announceMedia();
  }

  /** Swaps the camera without renegotiating, so a phone can flip lenses mid-call. */
  async replaceCamera(next: MediaStreamTrack) {
    const { localStream } = this.options;
    const current = localStream.getVideoTracks()[0];
    const transceiver = this.peer.getTransceivers().find(item => this.kindOf(item) === 'video');
    await transceiver?.sender.replaceTrack(next);
    if (current) { localStream.removeTrack(current); current.stop(); }
    localStream.addTrack(next);
    this.update({ hasCamera: true, cameraOn: next.enabled });
    this.announceMedia();
  }

  async startScreenShare() {
    if (this.screenStream) return;
    const capture = this.options.getDisplayMedia ?? ((options: DisplayOptions) => navigator.mediaDevices.getDisplayMedia(options));
    let stream: MediaStream;
    try { stream = await capture({ video: true, audio: true, systemAudio: 'include', monitorTypeSurfaces: 'include', surfaceSwitching: 'include' }); }
    catch (error) {
      // Closing the picker is a normal choice, not a failure.
      if (!(error instanceof DOMException && error.name === 'NotAllowedError')) this.update({ error: '화면을 공유하지 못했습니다. 다시 시도해 주세요.' });
      return;
    }
    this.screenStream = stream;
    this.screenSenders = stream.getTracks().map(track => this.peer.addTrack(track, stream));
    stream.getVideoTracks()[0]?.addEventListener('ended', () => this.stopScreenShare());
    this.options.recorder?.setScreen(stream);
    this.update({ localScreen: stream });
    this.announceMedia();
  }

  stopScreenShare() {
    const stream = this.screenStream;
    if (!stream) return;
    this.screenStream = null;
    for (const sender of this.screenSenders) this.peer.removeTrack(sender);
    this.screenSenders = [];
    stream.getTracks().forEach(track => track.stop());
    this.options.recorder?.setScreen(null);
    this.update({ localScreen: null });
    this.announceMedia();
  }

  /** Leaving the page would abort uploads in flight, so the last words get a moment to arrive first. */
  async finish() {
    this.leave();
    await Promise.race([this.options.recorder?.drain(), new Promise(resolve => setTimeout(resolve, FINAL_UPLOAD_WAIT_MS))]);
  }

  leave() {
    clearTimeout(this.restartTimer); clearInterval(this.statsTimer); clearTimeout(this.connectTimer);
    this.clockTimers.forEach(clearTimeout);
    this.options.recorder?.stop({ flush: true });
    this.screenStream?.getTracks().forEach(track => track.stop());
    this.options.localStream.getTracks().forEach(track => track.stop());
    this.peer?.close();
    this.signal?.close();
    this.update({ status: 'left' });
    clearTimeout(this.connectTimer);
  }
}
