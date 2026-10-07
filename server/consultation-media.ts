import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { RequestHandler } from 'express';
import type { ConsultationStore } from './consultation-store.ts';

type MediaFile = { filename: string; size: number };
const pending = new Map<string, Promise<string>>();

export function parseByteRange(value: string | undefined, size: number) {
  if (!value) return { start: 0, end: size - 1 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) throw new Error('Invalid range.');
  const a = match[1] ? Number(match[1]) : undefined;
  const b = match[2] ? Number(match[2]) : undefined;
  if ((a !== undefined && !Number.isSafeInteger(a)) || (b !== undefined && !Number.isSafeInteger(b))) throw new Error('Invalid range.');
  const start = a ?? Math.max(0, size - b!);
  const end = a === undefined ? size - 1 : Math.min(b ?? size - 1, size - 1);
  if (start >= size || start > end || start < 0) throw new Error('Unsatisfiable range.');
  return { start, end };
}

export async function ensureSeekableRecording(files: MediaFile[], ffmpeg: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if (!files.length) throw new Error('저장된 녹화가 없습니다.');
  const directory = dirname(resolve(files[0].filename));
  if (files.some(file => dirname(resolve(file.filename)) !== directory)) throw new Error('잘못된 녹화 경로입니다.');
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('잘못된 녹화 폴더입니다.');
  const target = join(directory, `recording-${files.length}-${files.reduce((n, file) => n + file.size, 0)}.webm`);
  try { const info = await lstat(target); if (!info.isSymbolicLink() && info.isFile() && info.size > 0) return target; throw new Error('잘못된 녹화 파일입니다.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (pending.has(target)) {
    const shared = pending.get(target)!;
    if (!signal) return shared;
    signal.throwIfAborted();
    // Joining a playback-owned conversion must not transfer ownership. This
    // caller can stop waiting while the independent conversion keeps running.
    return new Promise<string>((done, reject) => {
      const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
      signal.addEventListener('abort', abort, { once: true });
      shared.then(value => { signal.removeEventListener('abort', abort); done(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    });
  }
  const task = (async () => {
    const temporary = join(directory, `recording-${randomUUID()}.tmp`);
    const child = spawn(ffmpeg, ['-v', 'error', '-nostdin', '-y', '-protocol_whitelist', 'pipe', '-format_whitelist', 'matroska,webm',
      '-i', 'pipe:0', '-map', '0:v?', '-map', '0:a?', '-c', 'copy', '-f', 'webm', temporary], { shell: false, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    const abort = () => child.kill(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    let logBytes = 0; let timedOut = false;
    child.stderr.on('data', (chunk: Buffer) => { logBytes += chunk.length; if (logBytes > 64 * 1024) child.kill(); });
    const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 120_000);
    const exited = new Promise<void>((done, reject) => {
      child.once('error', reject);
      child.once('close', code => code === 0 && !timedOut ? done() : reject(new Error('녹화 파일 정리를 완료하지 못했습니다. 원본 청크는 보관됩니다.')));
    });
    async function* source() { for (const file of files) {
      const info = await lstat(file.filename);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== file.size) throw new Error('녹화 청크가 변경되었습니다.');
      for await (const bytes of createReadStream(file.filename)) yield bytes;
    } }
    const written = pipeline(Readable.from(source()), child.stdin);
    try {
      await Promise.all([written, exited]);
      const info = await lstat(temporary); if (!info.size) throw new Error('녹화가 비어 있습니다.');
      signal?.throwIfAborted(); await rename(temporary, target); return target;
    } catch (error) { child.kill(); await Promise.allSettled([written, exited]); throw error; }
    finally { signal?.removeEventListener('abort', abort); clearTimeout(timeout); await rm(temporary, { force: true }); }
  })();
  pending.set(target, task);
  try { return await task; } finally { pending.delete(target); }
}

export function recordingHandler(store: ConsultationStore, ffmpeg: string): RequestHandler {
  return async (req, res, next) => {
    try {
      const session = await store.get(String(req.params.id));
      if (['preparing', 'recording', 'processing'].includes(session.state)) { res.status(409).json({ error: '녹화 종료 후 재생할 수 있습니다.', code: 'STATE' }); return; }
      const files = await store.recordingFiles(session.id);
      if (!files.length) { res.status(404).json({ error: '저장된 녹화가 없습니다.', code: 'NOT_FOUND' }); return; }
      const filename = await ensureSeekableRecording(files, ffmpeg);
      if (res.destroyed) return;
      const size = (await lstat(filename)).size;
      let range;
      try { range = parseByteRange(req.headers.range, size); }
      catch { res.status(416).set('Content-Range', `bytes */${size}`).end(); return; }
      res.set({ 'Content-Type': 'video/webm', 'Accept-Ranges': 'bytes', 'Content-Length': String(range.end - range.start + 1),
        'Content-Disposition': 'inline; filename="consultation.webm"' });
      if (req.headers.range) res.status(206).set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
      if (req.method === 'HEAD') { res.end(); return; }
      await pipeline(createReadStream(filename, range), res);
    } catch (error) { if (!res.destroyed) next(error); }
  };
}
