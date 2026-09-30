// @vitest-environment node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import { validateAudioDuration } from './audio.ts';

const exec = promisify(execFile);
async function recording(format: string, seconds = 4) {
  const encoding = format === 'webm' ? ['-c:a', 'libopus'] : format === 'mp4' ? ['-c:a', 'aac', '-movflags', 'frag_keyframe+empty_moov'] : ['-c:a', 'libmp3lame'];
  const { stdout } = await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', String(seconds), ...encoding, '-f', format, 'pipe:1'], {
    encoding: 'buffer', windowsHide: true, timeout: 8000, maxBuffer: 2 * 1024 * 1024,
  });
  return stdout;
}

it.each(['webm', 'mp4', 'mp3'])('measures pipe-only %s recordings, including WebM without a duration header', async format => {
  const duration = await validateAudioDuration(await recording(format), 'ffprobe');
  expect(duration).toBeGreaterThanOrEqual(3.9);
  expect(duration).toBeLessThan(4.5);
});

it.each(['webm', 'mp4'])('rejects long %s based on its packets instead of client metadata', async format => {
  await expect(validateAudioDuration(await recording(format, 61), 'ffprobe')).rejects.toThrow();
});

it('accepts a full sixty-second MP4 including encoder padding', async () => {
  const duration = await validateAudioDuration(await recording('mp4', 60), 'ffprobe');
  expect(duration).toBeGreaterThanOrEqual(60);
  expect(duration).toBeLessThanOrEqual(60.5);
});

it('does not write probe errors or media data to logs', async () => {
  const log = vi.spyOn(console, 'log'); const error = vi.spyOn(console, 'error');
  await expect(validateAudioDuration(Buffer.from('private invalid audio'), 'ffprobe')).rejects.toThrow();
  expect(log).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
});

it('rejects cancelled probes before starting a subprocess', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(validateAudioDuration(Buffer.alloc(0), 'ffprobe', controller.signal)).rejects.toThrow();
});
