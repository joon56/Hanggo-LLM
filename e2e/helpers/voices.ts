import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Speaker } from '../../src/domain/coaching.ts';

const GAP_MS = 500;
const SAMPLE_RATE = 48000;
export type Line = { id: string; speaker: Speaker; text: string; file?: string };

/** Windows Heami reads each line, so this works on this PC only. Lines already read are kept between runs. */
export function synthesize(lines: Line[], folder: string) {
  mkdirSync(folder, { recursive: true });
  const missing = lines.filter(line => !existsSync(path.join(folder, `${line.id}.wav`)));
  if (!missing.length) return;
  const job = path.join(folder, 'job.json');
  writeFileSync(job, JSON.stringify(missing.map(line => ({ file: path.join(folder, `${line.id}.wav`), text: line.text }))));
  const script = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.SelectVoice('Microsoft Heami Desktop')
foreach ($item in (Get-Content -Raw -Encoding UTF8 '${job.replaceAll("'", "''")}' | ConvertFrom-Json)) {
  $synth.SetOutputToWaveFile($item.file)
  $synth.Speak($item.text)
  $synth.SetOutputToNull()
}`;
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: 'inherit' });
}

function pcmOf(file: string) {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-nostdin', '-i', file, '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', 'pipe:1'], { windowsHide: true, maxBuffer: 1 << 30 });
  return new Int16Array(raw.buffer, raw.byteOffset, raw.length / 2);
}

/** One track per microphone. Each person's lines sit where they fall in the conversation, with silence while the other speaks. */
export function buildTracks(segments: Line[], folder: string, leadInMs: number) {
  const perMs = SAMPLE_RATE / 1000;
  const lines = segments.map(line => ({ ...line, pcm: pcmOf(line.file ?? path.join(folder, `${line.id}.wav`)) }));
  const length = leadInMs * perMs + lines.reduce((sum, line) => sum + line.pcm.length + GAP_MS * perMs, 0);
  const tracks: Record<Speaker, Int16Array> = { guardian: new Int16Array(length), trainer: new Int16Array(length) };
  let at = leadInMs * perMs;
  for (const line of lines) { tracks[line.speaker].set(line.pcm, at); at += line.pcm.length + GAP_MS * perMs; }
  const files = {} as Record<Speaker, string>;
  for (const speaker of ['guardian', 'trainer'] as const) {
    const raw = path.join(folder, `${speaker}.s16le`); const wav = path.join(folder, `${speaker}.wav`);
    writeFileSync(raw, Buffer.from(tracks[speaker].buffer));
    execFileSync('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1', '-i', raw, wav], { windowsHide: true });
    files[speaker] = wav;
  }
  return { files, durationMs: length / perMs };
}
