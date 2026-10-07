import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { readConfig } from '../server/config.ts';
import { createLiveSpeech, type SpeechCandidate } from '../server/live-speech.ts';

// Usage: node --env-file-if-exists=.env scripts/compare-speech.ts manifest.json [output.json] [candidate,...]
// Manifest: {kind:'synthetic'|'human', samples:[{file:'relative.wav', expected:'reference transcript'}]}.
const manifestPath = resolve(process.argv[2] || '.tmp/speech-samples/manifest.json');
const outputPath = resolve(process.argv[3] || '.tmp/speech-comparison.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8').then(text => text.replace(/^\uFEFF/, '')));
if (!['synthetic', 'human'].includes(manifest.kind) || !Array.isArray(manifest.samples) || !manifest.samples.length) throw new Error('Invalid comparison manifest.');
const selected = (process.argv[4] || 'whisper-turbo,whisper-large,qwen-asr').split(',') as SpeechCandidate[];
if (selected.some(value => !['whisper-turbo', 'whisper-large', 'qwen-asr'].includes(value))) throw new Error('Invalid comparison candidate.');
const normalized = (value: string) => Array.from(value.normalize('NFKC').replace(/[\p{P}\p{Z}\s]/gu, ''));
function characterErrorRate(reference: string, actual: string) {
  const a = normalized(reference), b = normalized(actual);
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return a.length ? row[b.length] / a.length : (b.length ? 1 : 0);
}
const samples = await Promise.all(manifest.samples.map(async (sample: { file: string; expected: string }) => {
  const file = resolve(dirname(manifestPath), sample.file);
  const durationSeconds = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8', windowsHide: true }));
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || typeof sample.expected !== 'string') throw new Error('Invalid sample.');
  return { ...sample, durationSeconds, wav: await readFile(file) };
}));
const report: { createdAt: string; kind: string; results: unknown[]; limitations: string[] } = {
  createdAt: new Date().toISOString(), kind: manifest.kind, results: [],
  limitations: ['CER removes punctuation and whitespace; Korean number spelling variants still count as errors.', 'Synthetic voice results do not establish human consultation accuracy.', 'One request at a time; no text LLM running concurrently.'],
};
await mkdir(dirname(outputPath), { recursive: true });
for (const candidate of selected) {
  const config = readConfig({ ...process.env, LIVE_SPEECH_MODEL: candidate });
  const speech = createLiveSpeech(config, { unloadTextModel: async () => {
    // The comparison is standalone. Refuse to benchmark with another Ollama model in GPU memory.
    try {
      const response = await fetch(`${config.ollamaBaseUrl}/api/ps`, { signal: AbortSignal.timeout(2000) });
      const body = await response.json() as { models?: unknown[] };
      if (body.models?.length) throw new Error('Unload Ollama models before comparing speech candidates.');
    } catch (error) { if (error instanceof Error && error.message.includes('Unload')) throw error; }
  } });
  const started = performance.now();
  try {
    await speech.prepare();
    const preparationMs = Math.round(performance.now() - started);
    const gpu = execFileSync('nvidia-smi', ['--query-gpu=name,memory.used', '--format=csv,noheader,nounits'], { encoding: 'utf8', windowsHide: true }).trim();
    const runs = [];
    for (let repeat = 0; repeat < 2; repeat++) for (const sample of samples) {
      const result = await speech.transcribe(sample.wav);
      const run = { file: sample.file, repeat, durationSeconds: sample.durationSeconds, expected: sample.expected,
        ...result, realTimeFactor: result.latencyMs / (sample.durationSeconds * 1000), cer: characterErrorRate(sample.expected, result.text) };
      runs.push(run); console.info(JSON.stringify({ candidate, ...run }));
    }
    report.results.push({ candidate, preparationMs, gpuMemoryAfterPrepare: gpu, runs });
  } catch (error) { report.results.push({ candidate, error: error instanceof Error ? error.message : String(error) }); }
  finally { await speech.release(); await writeFile(outputPath, JSON.stringify(report, null, 2)); }
}
console.info(`Comparison report: ${outputPath}`);
