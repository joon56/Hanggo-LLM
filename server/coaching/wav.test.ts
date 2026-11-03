// @vitest-environment node
import { expect, it } from 'vitest';
import { encodeWav } from '../../src/call/speech-windows.ts';
import { isSilentWav } from './wav.ts';
import { StoreError } from './store.ts';

const clip = (seconds: number, amplitude: number) => Buffer.from(encodeWav(Float32Array.from({ length: seconds * 16000 }, (_, index) => amplitude * Math.sin(index / 10))));

it('accepts what the browser encoder produces', () => {
  expect(isSilentWav(clip(2, 0.1), 1000, 3000)).toBe(false);
});
it('reports silence only when no 100ms of the clip is audible', () => {
  expect(isSilentWav(clip(2, 0), 0, 2000)).toBe(true);
  const quietExceptOnce = Buffer.concat([clip(1, 0).subarray(0, 44 + 16000), clip(1, 0.1).subarray(44, 44 + 16000)]);
  quietExceptOnce.writeUInt32LE(quietExceptOnce.length - 8, 4); quietExceptOnce.writeUInt32LE(32000, 40);
  expect(isSilentWav(quietExceptOnce, 0, 1000)).toBe(false);
});
it('rejects anything that is not the agreed format', () => {
  const wrongRate = clip(1, 0.1); wrongRate.writeUInt32LE(48000, 24);
  const stereo = clip(1, 0.1); stereo.writeUInt16LE(2, 22);
  const cases: [Buffer, number, number][] = [
    [Buffer.from('not audio'), 0, 1000],
    [wrongRate, 0, 1000],
    [stereo, 0, 1000],
    [clip(1, 0.1), 0, 2000],
    [clip(16, 0.1), 0, 16000],
    [Buffer.from(encodeWav(new Float32Array(0))), 0, 1],
  ];
  for (const [bytes, startMs, endMs] of cases) expect(() => isSilentWav(bytes, startMs, endMs)).toThrow(StoreError);
});
it('rejects a body that never parsed into bytes', () => {
  expect(() => isSilentWav(undefined as unknown as Buffer, 0, 1000)).toThrow(StoreError);
});
