import { describe, expect, it } from 'vitest';
import { FrameRing, type BufferedFrame } from './frame-ring';

const frame = (atMs: number, source: BufferedFrame['source'] = 'camera'): BufferedFrame => ({ id: `${source}-${atMs}`, atMs, source, bytes: new Blob(['x']) });
function filled(from: number, to: number, source: BufferedFrame['source'] = 'camera', ring = new FrameRing()) {
  for (let atMs = from; atMs <= to; atMs += 1000) ring.add(frame(atMs, source));
  return ring;
}
const ids = (frames: BufferedFrame[]) => frames.map(item => item.id);

describe('FrameRing', () => {
  it('keeps ten seconds of frames per ring', () => {
    const ring = filled(0, 20000);
    expect(ids(ring.around(10000, 10000, 20000))).toEqual(Array.from({ length: 8 }, (_, index) => `camera-${10000 + index * 1000}`));
    expect(ids(ring.around(9000, 1000, 500))).toEqual([]);
  });
  it('returns frames from five seconds before to two seconds after a moment', () => {
    const ring = filled(0, 9000);
    expect(ids(ring.around(6000))).toEqual(['camera-1000', 'camera-2000', 'camera-3000', 'camera-4000', 'camera-5000', 'camera-6000', 'camera-7000', 'camera-8000']);
  });
  it('limits each source separately, so a shared screen does not push out the camera', () => {
    const ring = filled(0, 9000, 'screen', filled(0, 9000));
    ring.add(frame(5500));
    const frames = ring.around(6000);
    expect(frames.filter(item => item.source === 'camera')).toHaveLength(8);
    expect(frames.filter(item => item.source === 'screen')).toHaveLength(8);
    expect(frames.filter(item => item.source === 'camera').map(item => item.atMs)).toContain(5500);
  });
  it('forgets everything when cleared', () => {
    const ring = filled(0, 5000);
    ring.clear();
    expect(ring.around(3000)).toEqual([]);
  });
});
