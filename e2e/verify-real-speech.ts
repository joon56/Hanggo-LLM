import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';
import { aggregateScores, scoreDelivered, type GoldenDialogue } from '../scripts/note-metrics.ts';
import { characterErrorRate } from '../scripts/speech-metrics.ts';
import { loadLocalEnv, readConfig } from '../server/config.ts';
import type { Consultation, Segment, Speaker } from '../src/domain/coaching.ts';
import { termRecall } from '../src/domain/speech-terms.ts';
import { createCaseAsTrainer, enterTogether, ensureMedia, joinAsGuardian, launch, room, startServer } from './helpers/two-way.ts';
import { buildTracks, synthesize, type Line } from './helpers/voices.ts';

// Usage: node e2e/verify-real-speech.ts [--note] [--human <clips>] [dialogue,...]
// Plays speech through two fake microphones into the real server and the real speech model.
// Default voices are Windows Heami reading golden dialogues, so this PC only, and not real conversation.
// --human uses read speech from zeroth_korean (scripts/fetch-speech-eval.ts), alternating speakers. Real voices, unrelated topics.
// --note also runs the real LLM on the result, with a real dog video as the guardian's camera.
const WORK = path.resolve('.tmp/real-speech');
const LEAD_IN_MS = 30000;
const TAIL_MS = 20000;
const ORGANIZE_TIMEOUT_MS = 90 * 60 * 1000;
type Dialogue = Omit<Partial<GoldenDialogue>, 'segments'> & { id: string; petName: string; segments: Line[] };

const bigrams = (text: string) => { const clean = text.replace(/[^\p{L}\p{N}]/gu, ''); return Array.from({ length: Math.max(0, clean.length - 1) }, (_, index) => clean.slice(index, index + 2)); };
const overlap = (text: string, reference: Set<string>) => { const pairs = bigrams(text); return pairs.length ? pairs.filter(pair => reference.has(pair)).length / pairs.length : 0; };
const stats = (values: number[]) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted.length ? { count: sorted.length, median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.ceil(sorted.length * 0.95) - 1], max: sorted.at(-1)! } : { count: 0 };
};
const watchLatency = (page: Page) => page.evaluate(() => {
  const target = document.querySelector('[data-call-status]')!;
  const seen: number[] = []; (window as unknown as { captionDelays: number[] }).captionDelays = seen;
  new MutationObserver(() => { const value = target.getAttribute('data-caption-latency-ms'); if (value) seen.push(Number(value)); }).observe(target, { attributes: true, attributeFilter: ['data-caption-count'] });
});
const readLatency = (page: Page) => page.evaluate(() => (window as unknown as { captionDelays: number[] }).captionDelays);

function dogVideo() {
  const file = path.join(WORK, 'dog.y4m');
  if (!existsSync(file)) execFileSync('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-i', 'fixtures/demo/dog.webm', '-vf', 'scale=640:360,fps=15', '-pix_fmt', 'yuv420p', file], { windowsHide: true });
  return file;
}

async function verify(dialogue: Dialogue, withNote: boolean) {
  const folder = path.join(WORK, dialogue.id);
  mkdirSync(folder, { recursive: true });
  if (dialogue.segments.some(line => !line.file)) synthesize(dialogue.segments, folder);
  const { files, durationMs } = buildTracks(dialogue.segments, folder, LEAD_IN_MS);
  const server = await startServer(3390, { speech: 'real' });
  const uploadsBeforeConsent = { count: 0 };
  // %noloop plays the dialogue once. It starts when the microphone opens, so the lead-in covers joining the call.
  const trainer = await launch('trainer', { audioFile: `${files.trainer}%noloop`, holdMicrophone: true });
  const guardian = await launch('guardian', { audioFile: `${files.guardian}%noloop`, holdMicrophone: true, ...(withNote ? { videoFile: dogVideo() } : {}) });
  try {
    const started = Date.now();
    const invite = await createCaseAsTrainer(trainer.page, server.origin, dialogue.petName);
    await joinAsGuardian(guardian.page, invite);
    const id = await enterTogether(trainer.page, guardian.page, dialogue.petName);
    const read = async () => (await trainer.page.request.get(`${server.origin}/api/coaching/consultations/${id}`)).json() as Promise<Consultation>;
    let consented = false;
    for (const { page } of [trainer, guardian]) page.on('request', request => { if (request.method() === 'PUT' && /\/(audio|frames)\//.test(request.url()) && !consented) uploadsBeforeConsent.count += 1; });
    await trainer.page.waitForTimeout(3000);
    consented = true;
    for (const { page } of [trainer, guardian]) await page.getByRole('button', { name: '기록 동의', exact: true }).click();
    await expect(room(trainer.page)).toHaveAttribute('data-recording', 'true');
    const joinedAfterMs = Date.now() - started;
    if (joinedAfterMs > LEAD_IN_MS - 3000) throw new Error(`Joining took ${joinedAfterMs}ms, longer than the lead-in. Raise LEAD_IN_MS.`);
    await watchLatency(trainer.page); await watchLatency(guardian.page);
    const prepareStarted = Date.now();
    await expect(room(trainer.page)).toHaveAttribute('data-speech-status', 'ready', { timeout: 600_000 });
    const preparationMs = Date.now() - prepareStarted;
    // Catch once the conversation has been running, so the scenes before the press exist.
    await trainer.page.waitForTimeout(Math.max(0, LEAD_IN_MS + 20000 - (Date.now() - started)));
    await guardian.page.getByRole('button', { name: '캐치' }).click();
    await trainer.page.waitForTimeout(Math.max(0, durationMs + TAIL_MS - (Date.now() - started)));
    const delays = { trainer: await readLatency(trainer.page), guardian: await readLatency(guardian.page) };
    await trainer.page.getByRole('button', { name: '상담 종료' }).click();
    const endedAt = Date.now();
    await expect.poll(async () => (await read()).state, { timeout: ORGANIZE_TIMEOUT_MS, intervals: [2000] }).toBe('review');
    const organizeMs = Date.now() - endedAt;
    const finished = await read();

    const reference = (speaker: Speaker) => dialogue.segments.filter(line => line.speaker === speaker).map(line => line.text).join(' ');
    const heard = (speaker: Speaker) => finished.segments.filter(item => item.speaker === speaker && item.state === 'complete' && !item.echoSuspect).map(item => item.text).join(' ');
    const references = { guardian: new Set(bigrams(reference('guardian'))), trainer: new Set(bigrams(reference('trainer'))) };
    const judged = finished.segments.filter(item => item.state === 'complete');
    const mislabeled = judged.filter(item => overlap(item.text, references[item.speaker]) < overlap(item.text, references[item.speaker === 'guardian' ? 'trainer' : 'guardian']));
    const windowMs = (item: Segment) => item.endMs - item.startMs;
    const [moment] = finished.moments;
    const momentFrames = finished.frames.filter(frame => moment?.frameIds.includes(frame.id));
    const labelled = dialogue.expectedFacts && finished.note;
    return {
      dialogue: dialogue.id, audioSeconds: Math.round((durationMs - LEAD_IN_MS) / 1000), preparationMs, uploadsBeforeConsent: uploadsBeforeConsent.count, organizeSeconds: Math.round(organizeMs / 1000),
      segments: { total: finished.segments.length, complete: judged.length, failed: finished.segments.filter(item => item.state === 'failed').length, echoSuspect: finished.segments.filter(item => item.echoSuspect).length },
      speakerLabels: { judged: judged.length, mislabeled: mislabeled.length, examples: mislabeled.slice(0, 3).map(item => ({ speaker: item.speaker, text: item.text })) },
      cer: { guardian: characterErrorRate(reference('guardian'), heard('guardian')), trainer: characterErrorRate(reference('trainer'), heard('trainer')) },
      terms: termRecall(`${reference('guardian')} ${reference('trainer')}`, `${heard('guardian')} ${heard('trainer')}`),
      termsBeforeCorrection: termRecall(`${reference('guardian')} ${reference('trainer')}`, finished.segments.map(item => item.originalText).join(' ')),
      windowMs: stats(judged.map(windowMs)), transcriptionMs: stats(judged.map(item => item.latencyMs ?? 0)),
      captionDelayMs: { trainerScreen: stats(delays.trainer), guardianScreen: stats(delays.guardian) },
      catch: moment && { frames: momentFrames.length, bySpeaker: { guardian: momentFrames.filter(frame => frame.speaker === 'guardian').length, trainer: momentFrames.filter(frame => frame.speaker === 'trainer').length },
        earliestBeforeMs: moment.atMs - Math.min(...momentFrames.map(frame => frame.atMs)), latestAfterMs: Math.max(...momentFrames.map(frame => frame.atMs)) - moment.atMs, largestBytes: Math.max(...momentFrames.map(frame => frame.bytes)) },
      ...(withNote ? {
        noteScore: labelled ? scoreDelivered(dialogue as unknown as GoldenDialogue, finished.note!) : null,
        noteSections: finished.note && { summary: finished.note.summary.length, guardianReports: finished.note.guardianReports.length, guidance: finished.note.guidance.length, tasks: finished.note.tasks.length, fallbackUsed: !!finished.note.fallbackUsed, warnings: finished.note.warnings.length },
        scenes: finished.scenes.map(scene => ({ atMs: scene.atMs, photos: scene.frameIds.length, state: scene.state, observations: scene.observations.map(item => item.text) })),
        errors: finished.errors,
      } : {}),
      transcripts: { guardian: heard('guardian'), trainer: heard('trainer') },
      ...(withNote ? { note: finished.note } : {}),
    };
  } finally {
    await trainer.browser.close(); await guardian.browser.close();
    await server.stop();
  }
}

// The speaker goes on talking off script for ten seconds after the labelled sentence. The model wrote that down correctly, and it read as a mistake.
const CLIPS_LONGER_THAN_THEIR_LABEL = new Set(['105_003_0478.wav']);

function humanDialogue(clips: number): Dialogue {
  const root = path.resolve(readConfig().home, 'cache', 'eval', 'zeroth');
  const { samples } = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8').replace(/^﻿/, '')) as { samples: { file: string; expected: string }[] };
  return { id: `human-${clips}`, petName: '초코', segments: samples.filter(sample => !CLIPS_LONGER_THAN_THEIR_LABEL.has(sample.file)).slice(0, clips).map((sample, index) => ({ id: `h${index}`, speaker: index % 2 ? 'guardian' : 'trainer', text: sample.expected, file: path.join(root, sample.file) })) };
}

loadLocalEnv();
ensureMedia();
const args = process.argv.slice(2);
const withNote = args.includes('--note');
const humanAt = args.indexOf('--human');
const humanClips = humanAt >= 0 ? Number(args[humanAt + 1]) : 0;
const names = args.filter((arg, index) => !arg.startsWith('--') && index !== humanAt + 1 || (humanAt < 0 && !arg.startsWith('--'))).join(',').split(',').filter(Boolean);
const dialogues: Dialogue[] = humanClips ? [humanDialogue(humanClips)] : (names.length ? names : ['doorbell-barking', 'walk-reactivity-no-task', 'sudden-growl-safety']).map(name => JSON.parse(readFileSync(`fixtures/coaching-dialogues/${name}.json`, 'utf8')) as Dialogue);
const report = { createdAt: new Date().toISOString(), voice: humanClips ? 'zeroth_korean read speech (real people, unrelated topics)' : 'Microsoft Heami (synthetic)', llm: withNote ? process.env.LLM_MODEL ?? 'default' : null, results: [] as Awaited<ReturnType<typeof verify>>[] };
mkdirSync(WORK, { recursive: true });
const reportFile = path.join(WORK, `report${withNote ? '-note' : ''}${humanClips ? '-human' : ''}.json`);
for (const dialogue of dialogues) {
  const result = await verify(dialogue, withNote);
  report.results.push(result);
  writeFileSync(reportFile, JSON.stringify(report, null, 2));
  const { transcripts: _transcripts, note: _note, ...summary } = result;
  console.info(JSON.stringify(summary));
}
const scores = report.results.flatMap(item => item.noteScore ? [item.noteScore] : []);
if (scores.length) console.info(JSON.stringify({ noteSummary: aggregateScores(scores) }));
console.info(`Report: ${reportFile}`);
