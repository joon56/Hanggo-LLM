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
// With --long it joins every dialogue into one consultation over thirty minutes to measure the time a long call takes.
const DEFAULT_MODEL = 'gemma4-12b';
loadLocalEnv();
const long = process.argv.includes('--long');
const [model = DEFAULT_MODEL, onlyArgument] = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
const only = onlyArgument?.split(',');
const folder = new URL('../fixtures/coaching-dialogues/', import.meta.url);
const files = (await readdir(folder)).filter(file => file.endsWith('.json') && (!only || only.includes(file.replace('.json', ''))));
const single = await Promise.all(files.map(async file => JSON.parse(await readFile(new URL(file, folder), 'utf8')) as GoldenDialogue & { petName: string }));
/** Topics jump, because these were separate talks. What this measures is time and whether the parts hold together. */
function joined(parts: typeof single): typeof single {
  const SPACING_MS = 3 * 60 * 1000;
  const segments = parts.flatMap((part, index) => part.segments.map(segment => ({ ...segment, id: `${index}-${segment.id}`, startMs: segment.startMs + index * SPACING_MS, endMs: segment.endMs + index * SPACING_MS })));
  return [{ ...parts[0], id: 'joined-long', petName: '초코', segments, expectedFacts: parts.flatMap(part => part.expectedFacts), expectedTasks: parts.flatMap(part => part.expectedTasks), expectedSafetyFlags: [...new Set(parts.flatMap(part => part.expectedSafetyFlags))], expectedMethodReview: parts.some(part => part.expectedMethodReview), forbiddenClaims: [], attributions: [] }];
}
const dialogues = long ? joined(single) : single;
const config = readConfig({ ...process.env, LLM_MODEL: model, LLM_TIMEOUT_MS: '1800000' });
const llm = createLlmProvider(config);
const service = createNoteService({ llm });
const root = path.resolve(config.home, 'cache', 'eval');
await mkdir(root, { recursive: true });
const outputPath = path.join(root, `note-eval-${model}${long ? '-long' : ''}.json`);
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
