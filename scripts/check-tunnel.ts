import { loadLocalEnv } from '../server/config.ts';
import { createCaseAsTrainer, enterAsGuardian, enterAsTrainer, ensureMedia, expectFlowing, joinAsGuardian, launch, room } from '../e2e/helpers/two-way.ts';

// Runs a full call through a public tunnel address with two local browsers. Usage: npm.cmd run check:tunnel -- https://example.trycloudflare.com
loadLocalEnv();
const origin = process.argv[2];
if (!origin?.startsWith('https://')) throw new Error('Pass the https tunnel address.');
ensureMedia();
const trainer = await launch('trainer'); const guardian = await launch('guardian');
try {
  const invite = await createCaseAsTrainer(trainer.page, origin, '터널시험', process.env.APP_ACCESS_PASSWORD);
  if (!invite.startsWith(origin)) throw new Error('Invite does not use the tunnel address.');
  await joinAsGuardian(guardian.page, invite);
  await enterAsTrainer(trainer.page, '터널시험');
  await guardian.page.reload();
  await enterAsGuardian(guardian.page);
  await Promise.all([expectFlowing(trainer.page), expectFlowing(guardian.page)]);
  const attribute = (name: string) => room(trainer.page).getAttribute(name);
  console.info(JSON.stringify({ result: 'pass', status: await attribute('data-call-status'), relayed: await attribute('data-relayed'), inboundVideoFrames: await attribute('data-inbound-video-frames'), inboundAudioBytes: await attribute('data-inbound-audio-bytes') }));
} finally { await trainer.browser.close(); await guardian.browser.close(); }
