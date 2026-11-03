import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { loadLocalEnv, readConfig } from '../server/config.ts';
import { createSpeechProvider } from '../server/ai/speech/index.ts';
import { characterErrorRate, summarizeRuns, termRecall } from './speech-metrics.ts';

// Usage: node --env-file-if-exists=.env scripts/compare-speech.ts manifest.json [output.json] [candidate,...]
// Manifest: {kind:'synthetic'|'human', samples:[{file:'relative.wav', expected:'reference transcript'}]}.
const manifestPath = resolve(process.argv[2] || '.tmp/speech-samples/manifest.json');
const outputPath = resolve(process.argv[3] || '.tmp/speech-comparison.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8').then(text => text.replace(/^\uFEFF/, '')));
if (!['synthetic', 'human'].includes(manifest.kind) || !Array.isArray(manifest.samples) || !manifest.samples.length) throw new Error('Invalid comparison manifest.');
const selected = (process.argv[4] || 'qwen-asr,whisper-turbo').split(',');
if (selected.some(value => !['whisper-turbo', 'qwen-asr'].includes(value))) throw new Error('Invalid comparison candidate.');
loadLocalEnv();
const samples = await Promise.all(manifest.samples.map(async (sample: { file: string; expected: string; terms?: string[][] }) => {
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
  const config = readConfig({ ...process.env, SPEECH_MODEL: candidate });
  const speech = createSpeechProvider(config);
  const started = performance.now();
  try {
    await speech.prepare();
    const preparationMs = Math.round(performance.now() - started);
    const gpu = execFileSync('nvidia-smi', ['--query-gpu=name,memory.used', '--format=csv,noheader,nounits'], { encoding: 'utf8', windowsHide: true }).trim();
    const runs = [];
    for (const sample of samples) {
      const result = await speech.transcribe(sample.wav);
      const run = { file: sample.file, durationSeconds: sample.durationSeconds, expected: sample.expected,
        ...result, realTimeFactor: result.latencyMs / (sample.durationSeconds * 1000), cer: characterErrorRate(sample.expected, result.text), ...termRecall(sample.terms ?? [], result.text) };
      runs.push(run);
    }
    // Text on silence or noise means the model invented words. The capture gate exists because of this.
    const nonSpeech = [];
    for (const [name, filter] of [['silence', 'anullsrc=r=16000:cl=mono'], ['noise', 'anoisesrc=r=16000:c=pink:a=0.02']]) {
      const wav = execFileSync('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', filter, '-t', '5', '-ac', '1', '-c:a', 'pcm_s16le', '-bitexact', '-f', 'wav', 'pipe:1'], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
      const dataAt = wav.indexOf('data');
      wav.writeUInt32LE(wav.length - 8, 4); wav.writeUInt32LE(wav.length - dataAt - 8, dataAt + 4);
      const text = await speech.transcribe(wav).then(result => result.text).catch(error => `error: ${error instanceof Error ? error.message : String(error)}`);
      await speech.prepare();
      nonSpeech.push({ name, text });
    }
    const summary = summarizeRuns(runs);
    report.results.push({ candidate, preparationMs, gpuMemoryAfterPrepare: gpu, summary, nonSpeech, runs });
    console.info(JSON.stringify({ candidate, preparationMs, gpuMemoryAfterPrepare: gpu, summary, nonSpeech }));
  } catch (error) { report.results.push({ candidate, error: error instanceof Error ? error.message : String(error) }); }
  finally { await speech.release(); await writeFile(outputPath, JSON.stringify(report, null, 2)); }
}
console.info(`Comparison report: ${outputPath}`);
