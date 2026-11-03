import type { Speaker } from '../domain/coaching';
import { FrameRing, type BufferedFrame, type FrameSource } from './frame-ring';
import { SpeechWindows, type SpeechWindow } from './speech-windows';
import { UploadQueue } from './upload-queue';

export type MicrophoneTap = { sampleRate: number; stop(): void };
export type FrameGrabber = { grab(): Promise<Blob | null>; close(): void };
type Options = {
  role: Speaker; localStream: MediaStream;
  tapMicrophone: (track: MediaStreamTrack, onSamples: (samples: Float32Array) => void) => Promise<MicrophoneTap>;
  createGrabber: (stream: MediaStream) => FrameGrabber;
  uploadAudio: (window: SpeechWindow) => Promise<unknown>;
  uploadFrame: (frame: BufferedFrame, momentId?: string) => Promise<unknown>;
  isPermanent: (error: unknown) => boolean;
  onLost: () => void;
  /** False when the server has no speech model, so windows would only be refused. */
  transcribes?: () => boolean;
  createId?: () => string;
};

const CAPTURE_INTERVAL_MS = 1000;
const GUARDIAN_CAMERA_INTERVAL_MS = 30000;
const AFTER_MOMENT_MS = 2000;
const MAX_DRIFT_MS = 1000;
// A phone can drop off the network for a while, and what was said meanwhile is worth waiting for.
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000, 30000, 30000];
const MAX_WAITING_AUDIO = 40;
const MAX_WAITING_FRAMES = 64;

/** Runs only between consent and withdrawal: nothing is captured before it starts, and nothing buffered survives a withdrawal. */
export class CallRecorder {
  private readonly options: Options;
  private readonly audio: UploadQueue<SpeechWindow>;
  private readonly frames: UploadQueue<{ frame: BufferedFrame; momentId?: string }>;
  private readonly ring = new FrameRing();
  private clock: (() => number) | undefined;
  /** Bumped on every stop, so work that finishes afterwards knows it no longer counts. */
  private generation = 0;
  private tap: MicrophoneTap | undefined;
  private windows: SpeechWindows | undefined;
  private base = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private capturing = false;
  private grabbers: Partial<Record<FrameSource, FrameGrabber>> = {};
  private screen: MediaStream | null = null;
  private lastCameraUpload = -Infinity;
  private moments = new Map<ReturnType<typeof setTimeout>, () => void>();

  constructor(options: Options) {
    this.options = options;
    const { isPermanent, onLost, uploadAudio, uploadFrame } = options;
    this.audio = new UploadQueue({ send: uploadAudio, retryDelaysMs: RETRY_DELAYS_MS, limit: MAX_WAITING_AUDIO, isPermanent, onLost });
    this.frames = new UploadQueue({ send: ({ frame, momentId }) => uploadFrame(frame, momentId), retryDelaysMs: RETRY_DELAYS_MS, limit: MAX_WAITING_FRAMES, isPermanent, onLost });
  }

  /** `clock` reads the time since the recording began, on the server's clock. */
  start(clock: () => number) {
    if (this.clock) return;
    this.clock = clock;
    this.lastCameraUpload = -Infinity;
    const { localStream, createGrabber } = this.options;
    if (localStream.getVideoTracks().length) this.grabbers.camera = createGrabber(localStream);
    if (this.screen) this.grabbers.screen = createGrabber(this.screen);
    this.timer = setInterval(() => { void this.capture(); }, CAPTURE_INTERVAL_MS);
    void this.openMicrophone();
  }

  stop({ flush }: { flush: boolean }) {
    if (!this.clock) return;
    this.clock = undefined;
    this.generation += 1;
    clearInterval(this.timer);
    this.tap?.stop(); this.tap = undefined;
    for (const grabber of Object.values(this.grabbers)) grabber.close();
    this.grabbers = {};
    for (const [timer, upload] of this.moments) { clearTimeout(timer); if (flush) upload(); }
    this.moments.clear();
    if (flush) this.windows?.flush();
    else { this.audio.clear(); this.frames.clear(); }
    this.windows = undefined;
    this.ring.clear();
  }

  moment({ id, atMs }: { id: string; atMs: number }) {
    if (!this.clock) return;
    const upload = () => { for (const frame of this.ring.around(atMs)) this.frames.add({ frame, momentId: id }); };
    const timer = setTimeout(() => { this.moments.delete(timer); upload(); }, Math.max(0, atMs + AFTER_MOMENT_MS - this.clock()));
    this.moments.set(timer, upload);
  }

  setScreen(stream: MediaStream | null) {
    this.screen = stream;
    this.grabbers.screen?.close();
    delete this.grabbers.screen;
    if (stream && this.clock) this.grabbers.screen = this.options.createGrabber(stream);
  }

  private async openMicrophone() {
    const { localStream, tapMicrophone, onLost } = this.options;
    const [track] = localStream.getAudioTracks();
    if (!track) return;
    const { generation } = this;
    try {
      const tap = await tapMicrophone(track, samples => this.onSamples(samples));
      if (generation !== this.generation) { tap.stop(); return; }
      this.tap = tap;
      this.windows = new SpeechWindows(tap.sampleRate, window => {
        if (this.options.transcribes?.() === false) return;
        const offset = Math.max(0, Math.round(this.base));
        this.audio.add({ bytes: window.bytes, startMs: offset + window.startMs, endMs: offset + window.endMs });
      });
    } catch { if (generation === this.generation) onLost(); }
  }

  private onSamples(samples: Float32Array) {
    if (!this.windows || !this.clock) return;
    // The first samples set the clock. After that, a suspended AudioContext makes no samples, which would leave every later time behind the call.
    const drift = this.clock() - (this.base + this.windows.durationMs);
    if (this.windows.durationMs === 0 || Math.abs(drift) > MAX_DRIFT_MS) this.base += drift;
    this.windows.push(samples);
  }

  private async capture() {
    if (this.capturing) return;
    this.capturing = true;
    const { generation } = this;
    const { createId = () => crypto.randomUUID(), role } = this.options;
    try {
      for (const source of ['camera', 'screen'] as const) {
        const grabber = this.grabbers[source];
        if (!grabber || !this.clock) continue;
        const atMs = Math.max(0, Math.round(this.clock()));
        const bytes = await grabber.grab();
        if (!bytes || generation !== this.generation) continue;
        const frame = { id: createId(), atMs, source, bytes };
        this.ring.add(frame);
        if (role === 'guardian' && source === 'camera' && atMs - this.lastCameraUpload >= GUARDIAN_CAMERA_INTERVAL_MS) {
          this.lastCameraUpload = atMs;
          this.frames.add({ frame });
        }
      }
    } catch { /* A frame that cannot be drawn is simply missing; the next tick tries again. */ }
    finally { this.capturing = false; }
  }
}
