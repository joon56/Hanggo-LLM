// @vitest-environment node
import { expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseByteRange, ensureSeekableRecording } from './consultation-media.ts';

it('parses bounded, open-ended and suffix media ranges', () => {
  expect(parseByteRange('bytes=3-6', 10)).toEqual({ start: 3, end: 6 });
  expect(parseByteRange('bytes=3-', 10)).toEqual({ start: 3, end: 9 });
  expect(parseByteRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
  expect(parseByteRange(undefined, 10)).toEqual({ start: 0, end: 9 });
});
it.each(['bytes=10-', 'bytes=5-3', 'bytes=-0', 'bytes=0-1,3-4', 'something', 'bytes=999999999999999999999-'])('rejects unsatisfiable range %s', value => {
  expect(() => parseByteRange(value, 10)).toThrow();
});
it('keeps source chunks on remux failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hanggo-remux-'));
  try {
    const file = join(directory, 'media-0.webm'); await writeFile(file, 'source');
    await expect(ensureSeekableRecording([{ filename: file, size: 6 }], 'missing-hanggo-ffmpeg')).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe('source');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
it('remuxes split WebM to a seekable file with duration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hanggo-remux-'));
  try {
    const original = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=160x90:r=5', '-t', '1', '-c:v', 'libvpx', '-f', 'webm', 'pipe:1'], { windowsHide: true });
    const split = Math.floor(original.length / 2);
    const parts = [original.subarray(0, split), original.subarray(split)];
    const files = await Promise.all(parts.map(async (part, index) => { const filename = join(directory, `media-${index}.webm`); await writeFile(filename, part); return { filename, size: part.length }; }));
    const output = await ensureSeekableRecording(files, 'ffmpeg');
    const duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', output], { encoding: 'utf8', windowsHide: true }));
    expect(duration).toBeGreaterThanOrEqual(1);
    expect(await ensureSeekableRecording(files, 'ffmpeg')).toBe(output);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
