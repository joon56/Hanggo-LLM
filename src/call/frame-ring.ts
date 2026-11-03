export type FrameSource = 'camera' | 'screen';
export type BufferedFrame = { id: string; atMs: number; source: FrameSource; bytes: Blob };

const KEEP_MS = 10000;
// Photos come once a second, so looking back slightly further guarantees one from at least five seconds before.
const BEFORE_MS = 6000;
const AFTER_MS = 2000;
const MAX_PER_SOURCE = 8;

/** The last few seconds of scenes, held only in this browser until someone marks a moment. */
export class FrameRing {
  private frames: BufferedFrame[] = [];

  add(frame: BufferedFrame) {
    this.frames = [...this.frames.filter(item => item.source !== frame.source || item.atMs >= frame.atMs - KEEP_MS), frame];
  }

  around(atMs: number, beforeMs = BEFORE_MS, afterMs = AFTER_MS) {
    const inRange = this.frames.filter(item => item.atMs >= atMs - beforeMs && item.atMs <= atMs + afterMs).sort((left, right) => left.atMs - right.atMs);
    return (['camera', 'screen'] as const).flatMap(source => inRange.filter(item => item.source === source).slice(-MAX_PER_SOURCE));
  }

  clear() { this.frames = []; }
}
