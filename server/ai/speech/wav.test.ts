// @vitest-environment node
import { expect, it } from 'vitest';
import { wavToPcm } from './wav.ts';

function wav(samples: number[], { channels = 1, rate = 16000, bits = 16, format = 1 } = {}) {
  const buffer = Buffer.alloc(44 + samples.length * 2);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8); buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(format, 20); buffer.writeUInt16LE(channels, 22); buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * channels * bits / 8, 28);
  buffer.writeUInt16LE(channels * bits / 8, 32); buffer.writeUInt16LE(bits, 34); buffer.write('data', 36); buffer.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((sample, index) => buffer.writeInt16LE(sample, 44 + index * 2));
  return buffer;
}
it('converts mono 16kHz PCM samples to normalized floats', () => {
  expect(Array.from(wavToPcm(wav([0, 16384, -32768])))).toEqual([0, 0.5, -1]);
});
it('skips extra chunks before the data chunk', () => {
  const source = wav([16384]);
  const list = Buffer.alloc(8 + 4); list.write('LIST', 0); list.writeUInt32LE(4, 4);
  const withList = Buffer.concat([source.subarray(0, 36), list, source.subarray(36)]);
  expect(Array.from(wavToPcm(withList))).toEqual([0.5]);
});
it.each([
  ['non-WAV bytes', Buffer.from('not a wav file at all, definitely not one')],
  ['stereo', wav([1, 2], { channels: 2 })],
  ['other sample rates', wav([1], { rate: 44100 })],
  ['compressed formats', wav([1], { format: 3 })],
])('rejects %s', (_name, input) => {
  expect(() => wavToPcm(input)).toThrow(/WAV/);
});
it('rejects a data chunk that runs past the end of the file', () => {
  const source = wav([1, 2]); source.writeUInt32LE(1000, 40);
  expect(() => wavToPcm(source)).toThrow(/WAV/);
});
