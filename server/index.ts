import { readConfig } from './config.ts';
import { createApp } from './app.ts';
import { createOpenAIServices } from './openai.ts';

const config = readConfig();
const services = createOpenAIServices(config);
const app = createApp(config, {
  async generate(...args) {
    const result = await services.generate(...args);
    console.info(JSON.stringify({ feature: 'notes', requestId: result.requestId, model: result.model, latencyMs: result.latencyMs, fallbackUsed: result.fallbackUsed }));
    return result;
  },
  transcribe: services.transcribe,
  async generateOwner(...args) { const result = await services.generateOwner(...args); logResult('owner_log', result); return result; },
  async generateBrief(...args) { const result = await services.generateBrief(...args); logResult('brief', result); return result; },
  async generateShelter(...args) { const result = await services.generateShelter(...args); logResult('shelter', result); return result; },
});
function logResult(feature: string, result: { requestId: string; model: string; latencyMs: number; fallbackUsed: boolean }) {
  console.info(JSON.stringify({ feature, requestId: result.requestId, model: result.model, latencyMs: result.latencyMs, fallbackUsed: result.fallbackUsed }));
}
const server = app.listen(config.port, config.host, () => console.info(`Hanggo server: ${config.host}:${config.port}; AI ${config.aiEnabled ? 'enabled' : 'disabled'}`));
server.requestTimeout = 90_000;
server.headersTimeout = 15_000;
server.on('error', () => { console.error('서버를 시작하지 못했습니다. 포트와 환경 설정을 확인해 주세요.'); process.exitCode = 1; });
for (const event of ['SIGINT', 'SIGTERM'] as const) process.on(event, () => {
  server.close(() => process.exit(0));
  setTimeout(() => { server.closeAllConnections(); process.exit(1); }, 10_000).unref();
});
