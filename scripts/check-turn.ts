import { chromium } from '@playwright/test';
import { loadLocalEnv } from '../server/config.ts';
import { readTurn } from '../server/turn.ts';

// Proves a real relayed round trip with the configured TURN server. Never prints the credentials.
loadLocalEnv();
const turn = readTurn(process.env);
if (!turn) { console.info('TURN 설정 없음. secrets.env의 TURN_URLS, TURN_USERNAME, TURN_CREDENTIAL을 확인해 주세요.'); process.exit(2); }

async function relayRoundTrip(server: RTCIceServer) {
  const config: RTCConfiguration = { iceServers: [server], iceTransportPolicy: 'relay' };
  const a = new RTCPeerConnection(config); const b = new RTCPeerConnection(config);
  a.onicecandidate = event => { if (event.candidate) void b.addIceCandidate(event.candidate); };
  b.onicecandidate = event => { if (event.candidate) void a.addIceCandidate(event.candidate); };
  const channel = a.createDataChannel('probe');
  const started = performance.now();
  const received = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 20_000);
    b.ondatachannel = event => { event.channel.onmessage = () => { clearTimeout(timer); resolve(); }; };
  });
  channel.onopen = () => channel.send('ping');
  await a.setLocalDescription(await a.createOffer());
  await b.setRemoteDescription(a.localDescription!);
  await b.setLocalDescription(await b.createAnswer());
  await a.setRemoteDescription(b.localDescription!);
  await received;
  const stats = await a.getStats();
  let relayed = false; let roundTripMs: number | null = null;
  stats.forEach((report: Record<string, unknown>) => {
    if (report.type !== 'candidate-pair' || !report.nominated || report.state !== 'succeeded') return;
    relayed = (stats.get(String(report.localCandidateId)) as { candidateType?: string } | undefined)?.candidateType === 'relay';
    if (typeof report.currentRoundTripTime === 'number') roundTripMs = Math.round(report.currentRoundTripTime * 1000);
  });
  a.close(); b.close();
  return { relayed, roundTripMs, connectMs: Math.round(performance.now() - started) };
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  const result = await page.evaluate(relayRoundTrip, { urls: turn.urls, username: turn.username, credential: turn.credential });
  console.info(result.relayed ? `통과: 중계 연결 ${result.connectMs}ms, 왕복 ${result.roundTripMs ?? '?'}ms` : '실패: 중계 경로가 아닙니다.');
  if (!result.relayed) process.exitCode = 1;
} catch {
  console.info('실패: 중계 서버로 연결하지 못했습니다. 주소와 계정, 포트 3478 차단 여부를 확인해 주세요.');
  process.exitCode = 1;
} finally { await browser.close(); }
