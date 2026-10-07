import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, rm, lstat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Metadata } from '../src/domain/notes.ts';
import { validateConsultationNote } from '../src/domain/consultation.ts';
import type { ConsultationSession, TranscriptSegment } from '../src/domain/consultation.ts';

export class ConsultationError extends Error {
  readonly code: string; readonly status: number;
  constructor(code: string, message: string, status = 400) { super(message); this.code = code; this.status = status; }
}
type Chunk = { hash: string; size: number };
type Stored = ConsultationSession & { chunks: { media: Chunk[]; audio: Chunk[] } };
export const MAX_SESSION_MS = 3600000;
export const MAX_AUDIO_CHUNKS = 720;
export const MAX_MEDIA_CHUNKS = 3600;
export const MAX_SESSION_BYTES = 2 * 1024 ** 3;
const time = z.number().int().min(0).max(MAX_SESSION_MS);
const storedSchema = z.object({
  id: z.uuid(), metadata: z.object({ petName: z.string().min(1).max(200), trainerName: z.string().min(1).max(200), sessionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  createdAt: z.string().refine(value => Number.isFinite(Date.parse(value))), state: z.enum(['preparing', 'recording', 'processing', 'ready', 'incomplete', 'interrupted']), durationMs: time,
  segments: z.array(z.object({ id: z.string().min(1).max(100), sequence: z.number().int().min(0).max(MAX_AUDIO_CHUNKS - 1), startMs: time, endMs: time, text: z.string().max(16000), originalText: z.string().max(16000), state: z.enum(['queued', 'processing', 'complete', 'failed']), model: z.string().max(500).optional(), latencyMs: z.number().finite().min(0).optional() }).refine(segment => segment.endMs > segment.startMs)).max(MAX_AUDIO_CHUNKS),
  bookmarks: z.array(z.object({ id: z.string().min(1).max(100), atMs: time, text: z.string().min(1).max(2000) })).max(1000), recordingChunkCount: z.number().int().min(0).max(MAX_MEDIA_CHUNKS),
  errors: z.array(z.object({ code: z.string().min(1).max(100), message: z.string().max(1000), sequence: z.number().int().min(0).max(MAX_AUDIO_CHUNKS - 1).optional() })).max(2000), note: z.unknown().optional(),
  chunks: z.object({ audio: z.array(z.object({ hash: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().int().min(1).max(1024 ** 2) })).max(MAX_AUDIO_CHUNKS), media: z.array(z.object({ hash: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().int().min(1).max(16 * 1024 ** 2) })).max(MAX_MEDIA_CHUNKS) }),
});

export class ConsultationStore {
  readonly directory: string;
  private sessions = new Map<string, Stored>();
  private initialization?: Promise<void>;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(directory: string) { this.directory = path.resolve(directory); }
  private location(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new ConsultationError('INPUT', 'Invalid session ID.');
    return path.join(this.directory, id);
  }
  private snapshot(stored: Stored): ConsultationSession { const { chunks: _chunks, ...session } = stored; return structuredClone(session); }
  private async save(stored: Stored) {
    const directory = this.location(stored.id); const temporary = path.join(directory, `${randomUUID()}.tmp`);
    if ((await lstat(directory)).isSymbolicLink()) throw new ConsultationError('STORAGE', 'Unsafe session directory.', 500);
    await writeFile(temporary, JSON.stringify(stored), { flag: 'wx' });
    try { await rename(temporary, path.join(directory, 'session.json')); } finally { await rm(temporary, { force: true }); }
  }
  private async initialize() {
    this.initialization ??= (async () => {
      await mkdir(this.directory, { recursive: true });
      for (const entry of await readdir(this.directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/.test(entry.name)) continue;
        let stored: Stored;
        try {
          stored = JSON.parse(await readFile(path.join(this.location(entry.name), 'session.json'), 'utf8')) as Stored;
          if (!storedSchema.safeParse(stored).success || stored.id !== entry.name || (stored.note && validateConsultationNote(stored.note, stored).length)) continue;
        } catch { continue; }
        if (['preparing', 'recording', 'processing'].includes(stored.state)) {
          stored.state = 'interrupted';
          stored.segments.forEach(segment => { if (segment.state === 'queued' || segment.state === 'processing') segment.state = 'failed'; });
          stored.errors.push({ code: 'INTERRUPTED', message: 'Capture or processing stopped before completion.' });
          await this.save(stored);
        }
        this.sessions.set(stored.id, stored);
      }
    })();
    await this.initialization;
  }
  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => { await this.initialize(); return operation(); });
    this.tail = result.catch(() => {}); return result;
  }
  private find(id: string) { this.location(id); const stored = this.sessions.get(id); if (!stored) throw new ConsultationError('NOT_FOUND', 'Session not found.', 404); return stored; }
  async create(metadata: Metadata): Promise<ConsultationSession> {
    return this.locked(async () => {
      if (this.sessions.size >= 100) throw new ConsultationError('STORAGE_LIMIT', 'Delete an existing session before creating another.', 429);
      const stored: Stored = { id: randomUUID(), metadata: structuredClone(metadata), createdAt: new Date().toISOString(), state: 'recording', durationMs: 0, segments: [], bookmarks: [], recordingChunkCount: 0, errors: [], chunks: { audio: [], media: [] } };
      await mkdir(this.location(stored.id)); await this.save(stored); this.sessions.set(stored.id, stored); return this.snapshot(stored);
    });
  }
  async get(id: string): Promise<ConsultationSession> { return this.locked(async () => this.snapshot(this.find(id))); }
  async list(): Promise<ConsultationSession[]> { return this.locked(async () => [...this.sessions.values()].map(stored => this.snapshot(stored)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))); }
  async update(id: string, change: (session: ConsultationSession) => void): Promise<ConsultationSession> {
    return this.locked(async () => {
      const stored = structuredClone(this.find(id)); change(stored);
      if (stored.id !== id || !Number.isInteger(stored.durationMs) || stored.durationMs < 0 || stored.durationMs > MAX_SESSION_MS) throw new ConsultationError('INPUT', 'Invalid session duration.');
      await this.save(stored); this.sessions.set(id, stored); return this.snapshot(stored);
    });
  }
  async putChunk(id: string, kind: 'audio' | 'media', sequence: number, bytes: Buffer, segment?: TranscriptSegment): Promise<boolean> {
    return this.locked(async () => {
      const stored = structuredClone(this.find(id)); const chunks = stored.chunks[kind];
      if (!Number.isInteger(sequence) || sequence < 0 || sequence > chunks.length || sequence >= (kind === 'media' ? MAX_MEDIA_CHUNKS : MAX_AUDIO_CHUNKS)) throw new ConsultationError('SEQUENCE', 'Chunk sequence is out of order.');
      const hash = createHash('sha256').update(bytes).digest('hex');
      const register = () => { if (!segment || stored.segments.some(current => current.sequence === sequence)) return false; stored.segments.push(structuredClone(segment)); stored.durationMs = Math.max(stored.durationMs, segment.endMs); delete stored.note; return true; };
      if (sequence < chunks.length) { if (chunks[sequence].hash !== hash) throw new ConsultationError('CONFLICT', 'Chunk retry has different content.', 409); if (!register()) return false; await this.save(stored); this.sessions.set(id, stored); return true; }
      const maximum = kind === 'media' ? 16 * 1024 ** 2 : 1024 ** 2;
      if (!bytes.length || bytes.length > maximum || [...stored.chunks.media, ...stored.chunks.audio].reduce((size, chunk) => size + chunk.size, 0) + bytes.length > MAX_SESSION_BYTES) throw new ConsultationError('TOO_LARGE', 'Session storage budget exceeded.', 413);
      const directory = this.location(id); if ((await lstat(directory)).isSymbolicLink()) throw new ConsultationError('STORAGE', 'Unsafe session directory.', 500);
      const destination = path.join(directory, `${kind}-${sequence}.${kind === 'media' ? 'webm' : 'wav'}`);
      const temporary = `${destination}.${randomUUID()}.tmp`;
      await writeFile(temporary, bytes, { flag: 'wx' }); await rename(temporary, destination);
      chunks.push({ hash, size: bytes.length }); stored.recordingChunkCount = stored.chunks.media.length;
      register();
      await this.save(stored); this.sessions.set(id, stored); return true;
    });
  }
  async recordingFiles(id: string): Promise<{ filename: string; size: number }[]> { return this.locked(async () => this.find(id).chunks.media.map((chunk, sequence) => ({ filename: path.join(this.location(id), `media-${sequence}.webm`), size: chunk.size }))); }
  async recording(id: string): Promise<Buffer> { const files = await this.recordingFiles(id); return Buffer.concat(await Promise.all(files.map(file => readFile(file.filename)))); }
  async audio(id: string, sequence: number): Promise<Buffer> { return this.locked(async () => { const stored = this.find(id); if (!stored.chunks.audio[sequence]) throw new ConsultationError('NOT_FOUND', 'Audio chunk not found.', 404); return readFile(path.join(this.location(id), `audio-${sequence}.wav`)); }); }
  async delete(id: string): Promise<void> { await this.locked(async () => { this.find(id); const directory = this.location(id); if ((await lstat(directory)).isSymbolicLink()) throw new ConsultationError('STORAGE', 'Unsafe session directory.', 500); await rm(directory, { recursive: true }); this.sessions.delete(id); }); }
}
