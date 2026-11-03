import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';
import type { Consultation } from '../src/domain/coaching.ts';
import { aggregateScores, scoreDelivered, type GoldenDialogue } from '../scripts/note-metrics.ts';
import { characterErrorRate } from '../scripts/speech-metrics.ts';
import { loadLocalEnv } from '../server/config.ts';
import type { CoachingNote, Evidence, Scene } from '../src/domain/coaching-note.ts';
import { termRecall } from '../src/domain/speech-terms.ts';
import { createCaseAsTrainer, enterAsGuardian, enterAsTrainer, enterTogether, joinAsGuardian, launch, room, startServer } from './helpers/two-way.ts';
import { buildTracks, synthesize, type Line } from './helpers/voices.ts';

// Usage: node e2e/auto-demo.ts [--real] [output folder]
// Records both people's screens through one whole coaching loop on the real app, then puts the videos side by side.
// By default speech and AI answers are scripted test stand-ins, which the page says clearly. That shows the flow, not AI quality.
// --real uses this PC's real speech and text models on a synthetic voice reading the dialogue, and leaves out the time spent waiting for them.
const REAL = process.argv.includes('--real');
const OUTPUT = path.resolve(process.argv.slice(2).find(arg => !arg.startsWith('--')) ?? (REAL ? '.tmp/demo/real' : '.tmp/demo/site'));
const WORK = path.resolve('.tmp/demo/work');
const SCRIPT_FILE = path.resolve('fixtures/coaching-dialogues/doorbell-barking.json');
const DOG_CLIP = path.resolve('fixtures/demo/dog.webm');
const SAMPLE_RATE = 48000;
const LEAD_IN_MS = 26000;
const BURST_GAP_MS = 500;
const VIEWPORT = { width: 800, height: 720 };
const TONES = { guardian: 440, trainer: 880 };
type Speaker = 'guardian' | 'trainer';
type Step = { name: string; atSeconds: number };
const GAP_BEFORE_CUT_MS = 1500;
const MODEL_WAIT_MS = 30 * 60 * 1000;
const steady = (limit: number) => REAL ? MODEL_WAIT_MS : limit;

/** Tone bursts in place of voices. Windows are cut at their pauses, so each burst becomes one scripted line. */
function buildTone(speaker: Speaker, segments: { speaker: string; startMs: number; endMs: number }[], file: string) {
  const perMs = SAMPLE_RATE / 1000;
  const totalMs = LEAD_IN_MS + Math.max(...segments.map(item => item.endMs)) + 3000;
  const samples = new Int16Array(totalMs * perMs);
  for (const item of segments.filter(entry => entry.speaker === speaker)) {
    const from = (LEAD_IN_MS + item.startMs) * perMs; const to = (LEAD_IN_MS + item.endMs - BURST_GAP_MS) * perMs;
    for (let index = from; index < to; index++) samples[index] = Math.round(9000 * Math.sin(2 * Math.PI * TONES[speaker] * index / SAMPLE_RATE));
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + samples.byteLength, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24); header.writeUInt32LE(SAMPLE_RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(samples.byteLength, 40);
  writeFileSync(file, Buffer.concat([header, Buffer.from(samples.buffer)]));
}
const ffmpeg = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-nostdin', '-y', ...args], { windowsHide: true, stdio: ['ignore', 'ignore', 'inherit'] });

function prepareMedia() {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true }); mkdirSync(OUTPUT, { recursive: true });
  const segments = dialogue.segments as Line[] & GoldenDialogue['segments'];
  if (REAL) {
    const voices = path.join(WORK, 'voices');
    synthesize(segments, voices);
    tracksMs = buildTracks(segments, voices, LEAD_IN_MS).durationMs;
    for (const speaker of ['guardian', 'trainer']) copyFileSync(path.join(voices, `${speaker}.wav`), path.join(WORK, `${speaker}.wav`));
  } else {
    buildTone('guardian', segments, path.join(WORK, 'guardian.wav'));
    buildTone('trainer', segments, path.join(WORK, 'trainer.wav'));
  }
  ffmpeg(['-i', DOG_CLIP, '-vf', `scale=${REAL ? '640:360' : '480:270'},fps=15`, '-pix_fmt', 'yuv420p', path.join(WORK, 'guardian.y4m')]);
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x39453a:size=480x270:rate=15', '-t', '2', '-pix_fmt', 'yuv420p', path.join(WORK, 'trainer.y4m')]);
}

const dialogue = JSON.parse(readFileSync(SCRIPT_FILE, 'utf8')) as GoldenDialogue;
let tracksMs = 0;
const steps: Step[] = [];
const started = Date.now();
/** Waiting for the models, in the trainer's video time. Nothing moves on screen, so these spans are left out of the video. */
const cuts: [number, number][] = [];
let realResult: RealResult | undefined;
function step(name: string) { steps.push({ name, atSeconds: Math.round((Date.now() - started) / 1000) }); console.info(`${steps.at(-1)!.atSeconds}s ${name}`); }
/** Slows the scenario down enough for a person to read each screen in the video. */
const beat = (page: Page, ms = 2500) => page.waitForTimeout(ms);

async function run() {
  if (REAL) loadLocalEnv();
  prepareMedia();
  const server = await startServer(3450, REAL ? { speech: 'real', env: { COACHING_GRACE_MS: '2000' } } : { speech: 'stub', env: { STUB_SCRIPT: SCRIPT_FILE, COACHING_GRACE_MS: '2000' } });
  const trainer = await launch('trainer', { audioFile: `${path.join(WORK, 'trainer.wav')}%noloop`, videoFile: path.join(WORK, 'trainer.y4m'), recordVideoDir: path.join(WORK, 'video-trainer'), viewport: VIEWPORT });
  const trainerAt = Date.now();
  const guardian = await launch('guardian', { audioFile: `${path.join(WORK, 'guardian.wav')}%noloop`, videoFile: path.join(WORK, 'guardian.y4m'), recordVideoDir: path.join(WORK, 'video-guardian'), viewport: VIEWPORT });
  const guardianAt = Date.now();
  const t = trainer.page; const g = guardian.page;
  const cutWhile = async (wait: () => Promise<unknown>) => {
    const from = Date.now();
    await wait();
    if (REAL && Date.now() - from > 2 * GAP_BEFORE_CUT_MS) cuts.push([from - trainerAt + GAP_BEFORE_CUT_MS, Date.now() - trainerAt - GAP_BEFORE_CUT_MS]);
  };
  let id = '';
  let endedAt = 0; let organizeMs = 0;
  try {
    const invite = await createCaseAsTrainer(t, server.origin);
    step('훈련사가 상담 사례와 초대 링크를 만듭니다');
    await beat(t);
    await joinAsGuardian(g, invite);
    step('보호자가 초대 링크로 들어옵니다');
    await beat(g);
    if (REAL) id = await enterTogether(t, g, server.origin);
    else {
      await enterAsTrainer(t);
      await g.reload();
      await enterAsGuardian(g);
      id = /\/room\/([^/?]+)/.exec(t.url())![1];
    }
    await expect(room(t)).toHaveAttribute('data-call-status', 'connected', { timeout: 30_000 });
    await expect.poll(async () => Number(await room(t).getAttribute('data-inbound-video-frames')), { timeout: 30_000 }).toBeGreaterThan(5);
    step('두 브라우저가 실제 WebRTC로 연결되어 서로의 영상과 소리를 받습니다');
    await beat(t, 3000);

    const read = async () => (await t.request.get(`${server.origin}/api/coaching/consultations/${id}`)).json() as Promise<Consultation>;
    await expect(g.getByRole('button', { name: '캐치' })).toBeDisabled();
    step('동의 전에는 음성과 사진을 보내지 않습니다');
    await t.getByRole('button', { name: '기록 동의', exact: true }).click();
    await beat(t, 1500);
    await g.getByRole('button', { name: '기록 동의', exact: true }).click();
    await expect(room(t)).toHaveAttribute('data-recording', 'true');
    step('양쪽이 동의해 기록을 시작합니다');

    await expect.poll(async () => Number(await room(t).getAttribute('data-caption-count')), { timeout: steady(90_000), intervals: [500] }).toBeGreaterThanOrEqual(2);
    if (!REAL) await expect(g.getByRole('log', { name: '자막' })).toContainText('[시험 전사]', { timeout: 30_000 });
    step('각자 마이크에서 온 말이 화자 이름과 함께 자막으로 나옵니다');
    await beat(t, 6000);

    await t.getByRole('button', { name: '화면 공유' }).click();
    await expect(room(g)).toHaveAttribute('data-peer-screen', 'true', { timeout: 20_000 });
    step('훈련사가 화면을 공유합니다. 테스트에서는 캔버스가 바탕화면을 대신합니다');
    await beat(t, 5000);
    await t.getByRole('button', { name: '공유 중지' }).click();
    await beat(t, 2000);

    await g.getByRole('button', { name: '캐치' }).click();
    await expect(t.getByLabel('장면 메모')).toBeVisible();
    step('보호자가 장면을 캐치합니다. 양쪽 브라우저가 앞뒤 사진을 올립니다');
    await t.getByLabel('장면 메모').fill('간식을 먹는 동안 앞발로 잡고 있음');
    await t.getByRole('button', { name: '메모 저장' }).click();
    await expect.poll(async () => { const { moments } = await read(); return moments[0]?.frameIds.length ?? 0; }, { timeout: 30_000 }).toBeGreaterThanOrEqual(6);
    step('훈련사가 장면에 메모를 남깁니다');
    await expect.poll(async () => (await read()).segments.filter(item => item.state === 'complete').length, { timeout: steady(120_000), intervals: [1000] }).toBeGreaterThanOrEqual(10);
    // The whole dialogue, so the note has all of it to work from.
    if (REAL) await t.waitForTimeout(Math.max(0, tracksMs + 6000 - (Date.now() - trainerAt)));
    await beat(t, 3000);

    await t.getByRole('button', { name: '상담 종료' }).click();
    endedAt = Date.now();
    await t.waitForURL(/\/coaching$/);
    await g.waitForURL(/\/guardian$/);
    // Screen recording only updates on the next paint, so a reload shows the home screen straight away.
    await g.reload();
    step('상담을 끝내면 전사, 장면, 일지 순으로 정리합니다');
    await cutWhile(() => t.getByRole('button', { name: '검토하기' }).waitFor({ timeout: steady(90_000) }));
    organizeMs = Date.now() - endedAt;
    await t.getByRole('button', { name: '검토하기' }).click();
    await t.waitForURL(/\/review\//);
    await expect(t.getByRole('heading', { name: '초코 상담 검토' })).toBeVisible();
    await beat(t, 3000);

    const chip = t.getByRole('region', { name: '상담일지' }).getByRole('button', { name: /보호자 \d\d:\d\d/ }).first();
    await chip.click();
    await expect(t.getByRole('region', { name: '전사와 장면' }).locator('[data-selected="true"]')).toHaveCount(1);
    step('일지 문장을 누르면 근거 발화가 강조됩니다');
    await beat(t, 3000);
    await expect(g.getByRole('article', { name: '확정된 상담일지' })).toHaveCount(0);
    step('확정 전에는 보호자에게 아무것도 보이지 않습니다');

    // In the real run the note stays as the models wrote it, so what the page shows is theirs.
    if (!REAL) {
      await t.getByLabel('담당').first().fill('보호자');
      await t.getByLabel('횟수').first().fill('하루 두 번');
    }
    const observation = t.getByRole('checkbox', { name: '확인한 관찰만 일지에 넣기' }).first();
    if (!REAL || await observation.count()) {
      await observation.scrollIntoViewIfNeeded();
      await observation.click();
      await expect(observation).toBeChecked();
    }
    await beat(t, 2000);
    await t.getByRole('button', { name: '확정하고 보호자에게 전달' }).click();
    await expect(t.getByText('확정해 보호자에게 전달했습니다.')).toBeVisible();
    step(REAL ? '훈련사가 근거를 확인하고 확정합니다' : '훈련사가 내용을 고치고 확정합니다');
    await beat(t, 2500);

    await g.reload();
    const delivered = g.getByRole('article', { name: '확정된 상담일지' });
    await expect(delivered).toBeVisible();
    step('보호자가 확정된 일지와 과제를 받습니다');
    if (REAL) realResult = await collectReal(server.origin, g, id, await read(), organizeMs);
    await beat(g, 3000);
    const memo = g.getByRole('textbox', { name: /메모$/ }).first();
    await memo.scrollIntoViewIfNeeded();
    await memo.fill('소리를 줄이니 매트로 갔어요');
    await g.getByRole('button', { name: '했어요', exact: true }).first().click();
    await expect(delivered.getByRole('list', { name: /수행 기록$/ }).first()).toContainText('완료');
    step('보호자가 과제를 해 본 결과를 기록합니다');
    await beat(g, 2500);
    const log = g.getByLabel('일상 기록 내용');
    await log.scrollIntoViewIfNeeded();
    await log.fill('오늘 택배가 왔을 때 초인종에 한 번 짖고 멈췄어요');
    await g.getByRole('button', { name: '내용 확인' }).click();
    const when = g.getByLabel('언제였나요');
    await cutWhile(() => when.waitFor({ timeout: steady(60_000) }));
    await when.fill((await when.getAttribute('max'))!);
    await g.getByRole('button', { name: '저장' }).click();
    await expect(g.getByText(/저장했습니다/)).toBeVisible();
    step('보호자가 일상 기록을 남깁니다');
    await beat(g, 2500);

    await t.goto(`${server.origin}/coaching`);
    await t.getByRole('button', { name: '초코 상담 시작' }).click();
    await t.waitForURL(/\/room\//);
    const brief = t.getByRole('region', { name: '상담 전 브리핑' });
    await expect(brief).toContainText('이전 상담 과제와 수행 기록');
    await expect(brief).toContainText('완료 1회');
    await brief.scrollIntoViewIfNeeded();
    step('다음 상담을 시작하면 지난 과제와 보호자 기록이 브리핑에 나옵니다');
    const line = brief.locator('li').filter({ hasText: '이전 상담 과제와 수행 기록' }).first();
    await line.getByRole('button', { name: /근거 \d+건/ }).click();
    await expect(line).toContainText('소리를 줄이니 매트로 갔어요');
    await beat(t, 5000);
  } finally {
    const trainerVideo = await t.video()?.path(); const guardianVideo = await g.video()?.path();
    await t.context().close(); await g.context().close();
    await trainer.browser.close(); await guardian.browser.close();
    await server.stop();
    if (trainerVideo && guardianVideo && existsSync(trainerVideo) && existsSync(guardianVideo)) {
      // Both clocks start when each browser opened, so the later one is padded to line up.
      const lateBy = ((guardianAt - trainerAt) / 1000).toFixed(2);
      // The voices start when the microphones open, which is known from when the first line was heard.
      const voiceDelay = realResult ? Math.max(0, Math.round(realResult.firstLineAt - LEAD_IN_MS - trainerAt)) : 0;
      const voices = REAL ? ['-i', path.join(WORK, 'guardian.wav'), '-i', path.join(WORK, 'trainer.wav')] : [];
      const mix = REAL ? `;[2:a][3:a]amix=inputs=2:normalize=0,adelay=${voiceDelay}:all=1[voices]` : '';
      const kept = cuts.map(([from, to]) => `not(between(t,${from / 1000},${to / 1000}))`).join('*');
      const cut = kept ? `,fps=25,select='${kept}',setpts=N/25/TB` : '';
      ffmpeg(['-i', trainerVideo, '-i', guardianVideo, ...voices, '-filter_complex', `[1:v]tpad=start_duration=${lateBy}:color=black[late];[0:v][late]hstack=inputs=2${cut},format=yuv420p[out]${mix}`, '-map', '[out]', ...(REAL ? ['-map', '[voices]', '-c:a', 'aac', '-b:a', '64k'] : []), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', REAL ? '32' : '30', '-movflags', '+faststart', path.join(OUTPUT, 'two-way.mp4')]);
      ffmpeg(['-sseof', '-1', '-i', path.join(OUTPUT, 'two-way.mp4'), '-frames:v', '1', '-q:v', '4', path.join(OUTPUT, 'poster.jpg')]);
    }
  }
}

const clock = (ms: number) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

async function collectReal(origin: string, guardianPage: Page, id: string, finished: Consultation, organizeMs: number) {
  const { note, scenes } = await (await guardianPage.request.get(`${origin}/api/coaching/consultations/${id}/delivery`)).json() as { note: Delivered; scenes: Scene[] };
  const heard = finished.segments.filter(item => item.state === 'complete' && !item.echoSuspect).sort((left, right) => left.startMs - right.startMs);
  const said = (speaker: string) => dialogue.segments.filter(line => line.speaker === speaker).map(line => line.text).join(' ');
  const wrote = (speaker: string) => heard.filter(item => item.speaker === speaker).map(item => item.text).join(' ');
  const firstOnTrack = heard[0];
  return {
    note, scenes, transcript: heard.map(item => ({ speaker: item.speaker, startMs: item.startMs, text: item.text })),
    firstLineAt: (finished.recordingStartedAt ?? 0) + (firstOnTrack?.startMs ?? 0),
    metrics: {
      speechModel: firstOnTrack?.model ?? '미상', textModel: process.env.LLM_MODEL ?? 'gemma4-12b', audioSeconds: Math.round((tracksMs - LEAD_IN_MS) / 1000), organizeSeconds: Math.round(organizeMs / 1000),
      segments: finished.segments.length, failedSegments: finished.segments.filter(item => item.state === 'failed').length,
      cer: { guardian: characterErrorRate(said('guardian'), wrote('guardian')), trainer: characterErrorRate(said('trainer'), wrote('trainer')) },
      terms: termRecall(`${said('guardian')} ${said('trainer')}`, `${wrote('guardian')} ${wrote('trainer')}`),
      score: aggregateScores([scoreDelivered(dialogue, finished.note!)]),
      warnings: finished.note!.warnings,
    },
  };
}
type Delivered = Pick<CoachingNote, 'summary' | 'concerns' | 'behaviors' | 'guardianReports' | 'trainerObservations' | 'aiObservations' | 'guidance' | 'tasks' | 'followUps' | 'safetyFlags'>;
type RealResult = Awaited<ReturnType<typeof collectReal>>;

const escape = (text: string) => text.replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]!);
const NAME = { guardian: '보호자', trainer: '훈련사' } as const;
function evidenceOf(items: Evidence[]) {
  const shown = items.filter(item => item.kind === 'segment').map(item => `${NAME[item.speaker ?? 'guardian']} ${clock(item.startMs)} "${escape(item.quote)}"`);
  const scene = items.some(item => item.kind === 'scene') ? ['장면 사진'] : [];
  return [...shown, ...scene].join(' · ');
}
function section(title: string, items: { text: string; evidence: Evidence[] }[]) {
  if (!items.length) return '';
  return `<h3>${title}</h3><ul>${items.map(item => `<li>${escape(item.text)}<small>${evidenceOf(item.evidence)}</small></li>`).join('')}</ul>`;
}
function realReport({ note, transcript, metrics }: RealResult) {
  const percent = (value: number | null) => value === null ? '해당 없음' : `${(value * 100).toFixed(1)}%`;
  const tasks = note.tasks.map(task => ({ text: [task.text, task.who && `담당: ${task.who}`, task.frequency && `횟수: ${task.frequency}`, task.until && `기한: ${task.until}`, task.successCriteria && `확인: ${task.successCriteria}`].filter(Boolean).join(' / '), evidence: task.evidence }));
  const behaviors = note.behaviors.flatMap(entry => [...entry.context, ...entry.behavior, ...entry.response]);
  return `<section><h2>이번 실행의 측정값</h2><ul>
<li>음성 모델 ${escape(metrics.speechModel)}, 일지 모델 ${escape(metrics.textModel)}. RTX 3070 한 대에서 번갈아 실행</li>
<li>대본 음성 ${metrics.audioSeconds}초. 끝난 뒤 정리까지 ${metrics.organizeSeconds}초. 이 대기 시간은 영상에서 뺐습니다</li>
<li>전사 문자 오류율: 보호자 ${percent(metrics.cer.guardian)}, 훈련사 ${percent(metrics.cer.trainer)}. 행동 용어 ${metrics.terms.found}/${metrics.terms.total}</li>
<li>대본의 사실 재현율 ${percent(metrics.score.factRecall)}, 과제 재현율 ${percent(metrics.score.taskRecall)}. 근거 없는 숫자 ${metrics.score.unsupportedNumbers}건, 지어낸 과제 ${metrics.score.inventedTasks}건</li>
</ul></section>
<section class="note"><h2>모델이 쓰고 보호자가 받은 일지</h2><p>훈련사가 한 글자도 고치지 않은 그대로입니다. 작은 글씨는 각 문장의 근거입니다.</p>
${section('핵심 요약', note.summary)}${section('행동 기록', behaviors)}${section('보호자가 말한 내용', note.guardianReports)}${section('훈련사 관찰', note.trainerObservations)}${section('영상 관찰', note.aiObservations)}${section('안내', note.guidance)}${section('과제', tasks)}${section('다음에 볼 것', note.followUps)}
</section>
<details><summary>받아쓴 전문 ${transcript.length}구간</summary><ol class="lines">${transcript.map(item => `<li><b>${NAME[item.speaker]}</b> <span class="time">${clock(item.startMs)}</span> ${escape(item.text)}</li>`).join('')}</ol></details>`;
}

function page(result: { passed: boolean; error?: string }) {
  const runUrl = process.env.GITHUB_SERVER_URL && `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${REAL ? '행고 실제 모델 시연' : '행고 쌍방향 코칭 자동 시연'}</title>
<style>
:root { color-scheme: light; --ink: #1c211c; --muted: #5b625a; --line: #d9dcd2; --paper: #f7f7f2; }
body { margin: 0; background: var(--paper); color: var(--ink); font: 16px/1.6 system-ui, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 56px; display: grid; gap: 20px; }
h1 { font-size: 26px; margin: 0; } h2 { font-size: 18px; margin: 0 0 8px; }
video { width: 100%; background: #111; border-radius: 10px; }
.notice { background: #fbf4e4; border-radius: 10px; padding: 12px 14px; color: #5a471a; }
.labels { display: grid; grid-template-columns: 1fr 1fr; text-align: center; color: var(--muted); font-size: 14px; }
ol { margin: 0; padding-left: 22px; } li { margin: 2px 0; } .time { color: var(--muted); font-size: 13px; margin-left: 6px; }
footer { color: var(--muted); font-size: 13px; } a { color: inherit; }
h3 { font-size: 15px; margin: 14px 0 4px; } .note ul { margin: 0; padding-left: 20px; } .note li { margin: 6px 0; } small { display: block; color: var(--muted); font-size: 12px; line-height: 1.5; }
.lines { padding-left: 24px; font-size: 14px; } details { background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; } summary { cursor: pointer; font-weight: 600; }
</style></head><body><main>
${REAL ? `<h1>행고 실제 모델 시연</h1>
<p>GPU가 있는 PC에서 실제 앱과 실제 음성·일지 모델을 돌려, 서로 다른 브라우저 두 개가 훈련사와 보호자로 상담 한 번을 끝까지 진행한 기록입니다. 자막과 일지는 모델이 직접 만들었습니다.</p>
<p class="notice"><strong>사람의 실제 상담이 아닙니다.</strong> 목소리는 Windows 합성 음성이 가상 대본을 읽은 것이고, 카메라는 저장된 반려견 영상입니다. 같은 PC 안의 브라우저 두 개이므로 실제 네트워크와 실제 마이크 시험도 아닙니다. 사람이 쓸 때의 품질은 별도로 확인해야 합니다.</p>` : `<h1>행고 쌍방향 코칭 자동 시연</h1>
<p>GitHub Actions가 코드를 올릴 때마다 실제 앱을 띄우고, 서로 다른 브라우저 두 개를 훈련사와 보호자로 움직여 상담 한 번을 끝까지 진행한 기록입니다.</p>
<p class="notice"><strong>합성 입력입니다.</strong> 카메라는 저장된 영상, 마이크는 시험 신호, 자막과 일지 문장은 정해 둔 대본을 쓰는 시험용 AI 응답입니다. 흐름이 끝까지 동작하는지를 보여 주며, AI 품질의 증거가 아닙니다. 실제 사람과 실제 네트워크로 한 시연도 아닙니다.</p>`}
<div><div class="labels"><span>훈련사 화면</span><span>보호자 화면</span></div><video controls preload="metadata" poster="poster.jpg" src="two-way.mp4"></video></div>
<section><h2>이번 실행에서 확인한 것 ${result.passed ? `(${steps.length}단계 통과)` : '(실패)'}</h2><ol>${steps.map(item => `<li>${escape(item.name)}<span class="time">${item.atSeconds}초</span></li>`).join('')}</ol>${result.error ? `<p class="notice">${escape(result.error)}</p>` : ''}</section>
${realResult ? realReport(realResult) : ''}
<footer><p>반려견 영상: <a href="https://commons.wikimedia.org/wiki/File:German_shepherd_eating_dog_treat.webm">German shepherd eating dog treat</a>, Shadster, <a href="https://creativecommons.org/licenses/by-sa/4.0">CC BY-SA 4.0</a>. 크기를 줄이고 소리를 뺐습니다. 이 시연 영상에서 그 영상이 쓰인 부분도 같은 라이선스를 따릅니다.</p>
<p>${runUrl ? `<a href="${runUrl}">이 실행의 기록</a> · ` : ''}${REAL ? '<a href="../">자동 시연</a> · <a href="../../">공개 체험판</a>' : '<a href="real/">실제 모델 시연</a> · <a href="../">공개 체험판</a>'} · <a href="https://github.com/joon56/Hanggo-LLM">저장소</a></p></footer>
</main></body></html>`;
}

const failure = await run().then(() => undefined, (error: unknown) => error instanceof Error ? error : new Error(String(error)));
const result = { passed: !failure, steps, ...(realResult ? { metrics: realResult.metrics } : {}), ...(failure ? { error: failure.message.slice(0, 500) } : {}) };
mkdirSync(OUTPUT, { recursive: true });
writeFileSync(path.join(OUTPUT, 'result.json'), JSON.stringify(result, null, 2));
writeFileSync(path.join(OUTPUT, 'index.html'), page(result));
console.info(failure ? `실패: ${failure.message}` : `완료: ${OUTPUT}`);
process.exit(failure ? 1 : 0);
