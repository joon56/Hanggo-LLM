import { StoreError } from './store.ts';

const MAX_MS = 15000;
const AUDIBLE = 0.003;
const WINDOW_BYTES = 3200;
const invalid = () => new StoreError('AUDIO_INPUT', 'WAV must be mono 16kHz PCM with matching timestamps and at most 15 seconds.');

/** Validates the browser's WAV and reports whether any 100ms of it is audible, which keeps quiet speech. */
export function isSilentWav(bytes: Buffer, startMs: number, endMs: number) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.readUInt32LE(4) + 8 !== bytes.length) throw invalid();
  let offset = 12; let pcm = false; let dataBytes = 0; let audible = false;
  while (offset + 8 <= bytes.length) {
    const kind = bytes.toString('ascii', offset, offset + 4); const size = bytes.readUInt32LE(offset + 4); const at = offset + 8;
    if (at + size > bytes.length) throw invalid();
    if (kind === 'fmt ') pcm = size >= 16 && bytes.readUInt16LE(at) === 1 && bytes.readUInt16LE(at + 2) === 1 && bytes.readUInt32LE(at + 4) === 16000 && bytes.readUInt32LE(at + 8) === 32000 && bytes.readUInt16LE(at + 12) === 2 && bytes.readUInt16LE(at + 14) === 16;
    if (kind === 'data') {
      if (size % 2) throw invalid();
      dataBytes += size;
      for (let window = at; window < at + size; window += WINDOW_BYTES) {
        const end = Math.min(window + WINDOW_BYTES, at + size); let squares = 0;
        for (let sample = window; sample < end; sample += 2) squares += (bytes.readInt16LE(sample) / 32768) ** 2;
        if (Math.sqrt(squares / ((end - window) / 2)) >= AUDIBLE) audible = true;
      }
    }
    offset = at + size + (size % 2);
  }
  const durationMs = dataBytes / 32;
  if (!pcm || !dataBytes || durationMs > MAX_MS || Math.abs(durationMs - (endMs - startMs)) > 2) throw invalid();
  return !audible;
}
