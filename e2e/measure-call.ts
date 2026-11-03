import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import { loadLocalEnv } from '../server/config.ts';
import { readTurn } from '../server/turn.ts';
import { createCaseAsTrainer, enterAsGuardian, enterAsTrainer, ensureMedia, joinAsGuardian, launch, room, startServer } from './helpers/two-way.ts';

// Usage: node e2e/measure-call.ts [attempts]
// Measures connection time, recovery after a network drop, and forced relay with two real browsers on one PC.
// Direct numbers say little about real networks. The relay numbers do travel through the real TURN server.
const OUTPUT = path.resolve('.tmp/call-metrics.json');
const DROP_MS = 3000;
const attempts = Number(process.argv[2] ?? 5);

async function one(port: number, options: { relay: boolean; drop: boolean }) {
  const server = await startServer(port, { turn: options.relay });
  const trainer = await launch('trainer'); const guardian = await launch('guardian');
  try {
    const invite = await createCaseAsTrainer(trainer.page, server.origin);
    await joinAsGuardian(guardian.page, invite);
    await enterAsTrainer(trainer.page);
    if (options.relay) { await trainer.page.goto(`${trainer.page.url()}?forceRelay=1`); await trainer.page.getByRole('button', { name: '입장' }).click(); }
    await guardian.page.reload();
    if (options.relay) { await guardian.page.getByRole('button', { name: '상담 입장', exact: true }).click(); await guardian.page.waitForURL(/\/room\//); await guardian.page.goto(`${guardian.page.url()}?forceRelay=1`); await guardian.page.getByRole('button', { name: '입장' }).click(); }
    else await enterAsGuardian(guardian.page);
    const started = Date.now();
    await expect(room(trainer.page)).toHaveAttribute('data-call-status', 'connected', { timeout: 60_000 });
    await expect.poll(async () => Number(await room(guardian.page).getAttribute('data-inbound-video-frames')), { timeout: 60_000, intervals: [100] }).toBeGreaterThan(0);
    const connectMs = Date.now() - started;
    const relayed = await room(trainer.page).getAttribute('data-relayed');
    const roundTrip = await room(trainer.page).locator('.call-chip', { hasText: '지연' }).textContent().catch(() => null);
    let recoverMs: number | null = null;
    if (options.drop) {
      await guardian.page.context().setOffline(true);
      await guardian.page.waitForTimeout(DROP_MS);
      await guardian.page.context().setOffline(false);
      const back = Date.now();
      const before = Number(await room(guardian.page).getAttribute('data-inbound-video-frames'));
      await expect.poll(async () => Number(await room(guardian.page).getAttribute('data-inbound-video-frames')), { timeout: 60_000, intervals: [200] }).toBeGreaterThan(before + 5);
      recoverMs = Date.now() - back;
    }
    return { ok: true, connectMs, relayed: relayed === 'true', roundTrip, recoverMs };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message.slice(0, 200) : String(error) };
  } finally {
    await trainer.browser.close(); await guardian.browser.close();
    await server.stop();
  }
}

loadLocalEnv();
ensureMedia();
const results: Record<string, unknown>[] = [];
let port = 3470;
for (let index = 0; index < attempts; index++) results.push({ kind: 'direct', ...await one(port++, { relay: false, drop: true }) });
if (readTurn(process.env)) for (let index = 0; index < Math.min(attempts, 3); index++) results.push({ kind: 'relay', ...await one(port++, { relay: true, drop: false }) });
const summarize = (kind: string) => {
  const rows = results.filter(row => row.kind === kind) as { ok: boolean; connectMs?: number; recoverMs?: number | null; relayed?: boolean }[];
  const good = rows.filter(row => row.ok);
  const median = (values: number[]) => values.length ? [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)] : null;
  return { attempts: rows.length, connected: good.length, connectMedianMs: median(good.map(row => row.connectMs!)), recoverMedianMs: median(good.flatMap(row => row.recoverMs ?? [])), relayed: good.filter(row => row.relayed).length };
};
const report = { createdAt: new Date().toISOString(), direct: summarize('direct'), relay: summarize('relay'), results };
mkdirSync(path.dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, JSON.stringify(report, null, 2));
console.info(JSON.stringify({ direct: report.direct, relay: report.relay }));
