import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { newConsultation, type Segment } from '../src/domain/coaching.ts';
import { loadLocalEnv, readConfig } from '../server/config.ts';
import { createNoteService } from '../server/coaching/note-service.ts';
import { createLlmProvider } from '../server/providers.ts';
import { aggregateScores, scoreDelivered, type GoldenDialogue } from './note-metrics.ts';

// Usage: node scripts/eval-notes.ts [model] [dialogue,dialogue,...]
// Runs the whole note service, retry and checks included, over the synthetic golden dialogues. This PC only.
// Transcripts are the fixtures' own text, so speech errors are not part of these numbers.
const DEFAULT_MODEL = 'gemma4-12b';
loadLocalEnv();
const model = process.argv[2] || DEFAULT_MODEL;
const only = process.argv[3]?.split(',');
const folder = new URL('../fixtures/coaching-dialogues/', import.meta.url);
const files = (await readdir(folder)).filter(file => file.endsWith('.json') && (!only || only.includes(file.replace('.json', ''))));
const dialogues = await Promise.all(files.map(async file => JSON.parse(await readFile(new URL(file, folder), 'utf8')) as GoldenDialogue & { petName: string }));
const config = readConfig({ ...process.env, LLM_MODEL: model, LLM_TIMEOUT_MS: '1800000' });
const llm = createLlmProvider(config);
const service = createNoteService({ llm });
const root = path.resolve(config.home, 'cache', 'eval');
await mkdir(root, { recursive: true });
const outputPath = path.join(root, `note-eval-${model}.json`);
const runs: unknown[] = []; const scores: ReturnType<typeof scoreDelivered>[] = [];
try {
  for (const dialogue of dialogues) {
    const segments = dialogue.segments.map((segment): Segment => ({ ...segment, speaker: segment.speaker as Segment['speaker'], originalText: segment.text, state: 'complete' }));
    const started = performance.now();
    const note = await service.generate({ ...newConsultation({ id: dialogue.id, caseId: 'eval', createdAt: new Date().toISOString() }), segments }, { petName: dialogue.petName, guardianName: '가상 보호자', trainerName: '가상 훈련사' });
    const latencyMs = Math.round(performance.now() - started);
    const score = scoreDelivered(dialogue, note);
    scores.push(score); runs.push({ dialogue: dialogue.id, latencyMs, score, note });
    console.info(JSON.stringify({ dialogue: dialogue.id, latencyMs, ...score }));
    await writeFile(outputPath, JSON.stringify({ createdAt: new Date().toISOString(), model, note: 'Synthetic golden dialogues through the whole note service.', summary: aggregateScores(scores), runs }, null, 2));
  }
} finally { await llm.release(); }
console.info(JSON.stringify({ model, summary: aggregateScores(scores) }));
console.info(`Report: ${outputPath}`);
