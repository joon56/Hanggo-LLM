import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildNoteRequest, type NoteSegment } from '../server/coaching/note-prompt.ts';
import { loadLocalEnv, readConfig } from '../server/config.ts';
import { createLlmProvider } from '../server/providers.ts';
import { scoreNote, type GoldenDialogue } from './note-metrics.ts';

// Usage: node scripts/compare-llm.ts [model,model,...]
// Measures the tentative note prompt on synthetic golden dialogues. Step 3 repeats this with validation.
loadLocalEnv();
const models = (process.argv[2] ?? 'qwen35-9b,gemma4-e4b,gemma4-12b,hcx-14b,qwen38-27b').split(',');
const folder = new URL('../fixtures/coaching-dialogues/', import.meta.url);
const dialogues = await Promise.all((await readdir(folder)).filter(file => file.endsWith('.json')).map(async file => JSON.parse(await readFile(new URL(file, folder), 'utf8')) as GoldenDialogue & { segments: NoteSegment[]; petName: string }));
const root = path.resolve(readConfig().home, 'cache', 'eval');
await mkdir(root, { recursive: true });
const outputPath = path.join(root, 'llm-comparison.json');
const report: { createdAt: string; note: string; results: unknown[] } = { createdAt: new Date().toISOString(), note: 'Synthetic golden dialogues with a tentative prompt and no retry or validation.', results: [] };
const gpuMemory = () => { try { return Number(execFileSync('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], { encoding: 'utf8', windowsHide: true }).trim()); } catch { return null; } };

for (const model of models) {
  const config = readConfig({ ...process.env, LLM_MODEL: model, LLM_CONTEXT_SIZE: '16384', LLM_TIMEOUT_MS: '1800000' });
  const llm = createLlmProvider(config);
  const runs = [];
  let gpuPeak = 0;
  try {
    for (const dialogue of dialogues) {
      const started = performance.now();
      const { json, finished } = await llm.structured(buildNoteRequest(dialogue.petName, dialogue.segments));
      const latencyMs = Math.round(performance.now() - started);
      gpuPeak = Math.max(gpuPeak, gpuMemory() ?? 0);
      runs.push({ dialogue: dialogue.id, latencyMs, finished, characters: dialogue.segments.reduce((sum, segment) => sum + segment.text.length, 0), score: scoreNote(dialogue, json), note: json });
      console.info(JSON.stringify({ model, dialogue: dialogue.id, latencyMs, finished, score: runs.at(-1)!.score }));
    }
    report.results.push({ model, gpuPeakMiB: gpuPeak, runs });
  } catch (error) {
    report.results.push({ model, error: error instanceof Error ? error.message : String(error), runs });
    console.info(JSON.stringify({ model, error: error instanceof Error ? error.message : String(error) }));
  } finally {
    await llm.release();
    await writeFile(outputPath, JSON.stringify(report, null, 2));
  }
}
console.info(`Comparison report: ${outputPath}`);
