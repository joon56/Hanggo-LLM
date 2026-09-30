import { spawn } from 'node:child_process';

export class AudioValidationError extends Error {
  constructor() { super('녹음 파일의 실제 길이는 3~60초여야 합니다. 파일을 확인하거나 다시 녹음해 주세요.'); }
}

// All media stays in memory. ffprobe may only read its stdin pipe, never URLs or files.
export async function validateAudioDuration(buffer: Buffer, executable: string, signal?: AbortSignal): Promise<number> {
  signal?.throwIfAborted();
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(executable, ['-v', 'error', '-protocol_whitelist', 'pipe',
      '-format_whitelist', 'matroska,webm,wav,mov,mp3', '-i', 'pipe:0',
      '-select_streams', 'a', '-show_entries', 'stream=index,codec_type,duration:format=duration:packet=stream_index,pts_time,dts_time,duration_time',
      '-of', 'json'], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let size = 0; let errorSize = 0; let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) { child.kill(); reject(error); }
      else resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const abort = () => finish(new Error('Audio probe cancelled.'));
    const timer = setTimeout(() => finish(new AudioValidationError()), 8000);
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', () => finish(new Error('Audio probe unavailable.')));
    child.stdin.on('error', () => { /* A rejected container can close stdin early. Exit status is checked below. */ });
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) finish(new AudioValidationError());
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      errorSize += chunk.length;
      if (errorSize > 64 * 1024) finish(new AudioValidationError());
    });
    child.on('close', code => finish(code === 0 && errorSize === 0 ? undefined : new AudioValidationError()));
    child.stdin.end(buffer);
    if (signal?.aborted) abort();
  });
  signal?.throwIfAborted();
  let parsed: { streams?: { index?: number; duration?: string }[]; format?: { duration?: string }; packets?: { stream_index?: number; pts_time?: string; dts_time?: string; duration_time?: string }[] };
  try { parsed = JSON.parse(output); } catch { throw new AudioValidationError(); }
  if (!Array.isArray(parsed.streams) || parsed.streams.length !== 1 || !Array.isArray(parsed.packets) || !parsed.packets.length) throw new AudioValidationError();
  let first = Infinity; let last = -Infinity; let total = 0;
  for (const packet of parsed.packets) {
    const start = Number(packet.pts_time ?? packet.dts_time);
    const duration = Number(packet.duration_time);
    if (!Number.isFinite(start) || !Number.isFinite(duration) || duration <= 0) throw new AudioValidationError();
    first = Math.min(first, start); last = Math.max(last, start + duration); total += duration;
  }
  const durations = [last - first, total, Number(parsed.streams[0].duration), Number(parsed.format?.duration)].filter(Number.isFinite);
  // ffprobe timestamps have microsecond precision; remove floating-point summation noise.
  const duration = Math.round(Math.max(...durations) * 1_000_000) / 1_000_000;
  // Encoder padding can extend a 60-second recording slightly; never accept >60.5 seconds.
  if (duration < 3 || duration > 60.5) throw new AudioValidationError();
  return duration;
}
