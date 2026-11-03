import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import type { Consultation } from '../src/domain/coaching.ts';
import { createCaseAsTrainer, enterAsGuardian, enterAsTrainer, ensureMedia, joinAsGuardian, launch, room, startServer } from './helpers/two-way.ts';

// Usage: node e2e/soak.ts [minutes]
// Keeps one recording call open for a long time on the real app with stub AI, then checks what a long consultation leaves behind:
// no lost windows, times that still match the clock, browser memory, and whether the review screen copes with the transcript's size.
const OUTPUT = path.resolve('.tmp/soak.json');
const minutes = Number(process.argv[2] ?? 60);
const SAMPLE_MS = 60_000;
const BURST_CYCLE_MS = 5000;

ensureMedia();
const server = await startServer(3560, { speech: 'stub', env: { COACHING_GRACE_MS: '3000' } });
const trainer = await launch('trainer'); const guardian = await launch('guardian');
const t = trainer.page; const g = guardian.page;
const heap = (page: typeof t) => page.evaluate(() => Math.round(((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 1e6));
const samples: Record<string, unknown>[] = [];
let failure = '';
const report: Record<string, unknown> = { createdAt: new Date().toISOString(), minutes, note: 'Stub speech and LLM. This measures the path and its limits, not AI time or quality.' };
try {
  const invite = await createCaseAsTrainer(t, server.origin);
  await joinAsGuardian(g, invite);
  await enterAsTrainer(t);
  await g.reload();
  await enterAsGuardian(g);
  for (const page of [t, g]) await page.getByRole('button', { name: '기록 동의', exact: true }).click();
  await expect(room(t)).toHaveAttribute('data-recording', 'true');
  const id = /\/room\/([^/?]+)/.exec(t.url())![1];
  const read = async () => (await t.request.get(`${server.origin}/api/coaching/consultations/${id}`)).json() as Promise<Consultation>;
  const started = Date.now();
  while (Date.now() - started < minutes * 60_000) {
    await t.waitForTimeout(SAMPLE_MS);
    const { segments, frames, recordingStartedAt } = await read();
    const row = { minute: Math.round((Date.now() - started) / 60_000), status: await room(t).getAttribute('data-call-status'), segments: segments.length, frames: frames.length,
      queued: segments.filter(item => item.state === 'queued').length, failed: segments.filter(item => item.state === 'failed').length,
      frameGrowth: await room(g).getAttribute('data-inbound-video-frames'), heapTrainerMb: await heap(t), heapGuardianMb: await heap(g),
      captionDelayMs: await room(t).getAttribute('data-caption-latency-ms'), newestEndVsClockMs: Date.now() - (recordingStartedAt! + Math.max(0, ...segments.map(item => item.endMs))),
      warned: await t.getByText(/일부 기록을 보내지 못했습니다/).count() + await g.getByText(/일부 기록을 보내지 못했습니다/).count() };
    samples.push(row);
    console.info(JSON.stringify(row));
    report.samples = samples;
    writeFileSync(OUTPUT, JSON.stringify(report, null, 2));
  }
  const elapsedMs = Date.now() - started;
  await g.getByRole('button', { name: '캐치' }).click();
  await t.waitForTimeout(4000);
  await t.getByRole('button', { name: '상담 종료' }).click();
  await t.waitForURL(/\/coaching$/);
  await expect.poll(async () => (await read()).state, { timeout: 300_000, intervals: [1000] }).toBe('review');
  const finished = await read();
  const bytes = Buffer.byteLength(JSON.stringify(finished));
  const opened = Date.now();
  await t.goto(`${server.origin}/review/${id}`);
  await t.getByRole('heading', { name: '초코 상담 검토' }).waitFor({ timeout: 120_000 });
  const reviewOpenMs = Date.now() - opened;
  const typed = Date.now();
  await t.getByRole('textbox', { name: '핵심 요약 문장' }).first().fill('긴 상담 뒤에도 고칠 수 있는 문장');
  const reviewEditMs = Date.now() - typed;
  // Each person speaks one burst in every cycle, so this is how many windows the call should have produced.
  const expected = Math.floor(elapsedMs / BURST_CYCLE_MS) * 2;
  Object.assign(report, { elapsedMs, expectedSegmentsRoughly: expected, segments: finished.segments.length, failed: finished.segments.filter(item => item.state === 'failed').length, frames: finished.frames.length, consultationKb: Math.round(bytes / 1024), reviewOpenMs, reviewEditMs, noteWarnings: finished.note?.warnings.length, errors: finished.errors });
} catch (error) {
  failure = error instanceof Error ? error.message.slice(0, 800) : String(error);
  report.failure = failure;
} finally {
  report.samples = samples;
  mkdirSync(path.dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, JSON.stringify(report, null, 2));
  await trainer.browser.close(); await guardian.browser.close();
  await server.stop();
}
const { samples: _samples, ...summary } = report;
console.info(JSON.stringify(summary));
process.exit(failure ? 1 : 0);
