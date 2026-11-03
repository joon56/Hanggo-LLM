/** Reads mono 16kHz 16-bit PCM, the only format the capture and conversion paths produce. */
export function wavToPcm(wav: Buffer): Float32Array {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Upload standalone PCM WAV.');
  let offset = 12; let valid = false;
  while (offset + 8 <= wav.length) {
    const kind = wav.toString('ascii', offset, offset + 4); const size = wav.readUInt32LE(offset + 4); const at = offset + 8;
    if (at + size > wav.length) throw new Error('Truncated WAV chunk.');
    if (kind === 'fmt ') valid = size >= 16 && wav.readUInt16LE(at) === 1 && wav.readUInt16LE(at + 2) === 1 && wav.readUInt32LE(at + 4) === 16000 && wav.readUInt16LE(at + 14) === 16;
    if (kind === 'data') {
      if (!valid) throw new Error('WAV must be mono 16kHz 16-bit PCM.');
      const pcm = new Float32Array(Math.floor(size / 2));
      for (let index = 0; index < pcm.length; index++) pcm[index] = wav.readInt16LE(at + index * 2) / 32768;
      return pcm;
    }
    offset = at + size + (size % 2);
  }
  throw new Error('WAV has no audio data.');
}
