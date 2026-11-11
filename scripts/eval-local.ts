import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readConfig } from '../server/config.ts';
import { createOllamaServices } from '../server/ollama.ts';
import { evaluateFixture, featureFiles, smokeCases } from './evaluation.ts';

const args = process.argv.slice(2); let model: string | undefined; let all = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--all') all = true;
  else if (args[i] === '--model' && args[i + 1] && !args[i + 1].startsWith('--')) model = args[++i];
  else if (args[i] === '--help') { console.info('npm run llm:eval:local -- [--model qwen3.5:9b] [--all]\n기본 16개 사례 / --all 82개. 실제 로컬 모델 호출, 외부 API 사용 없음.'); process.exit(0); }
  else throw new Error(`지원하지 않는 인자: ${args[i]}`);
}
const config = readConfig({ ...process.env, ...(model ? { OLLAMA_MODEL: model } : {}) });
const services = createOllamaServices(config);
const reports: Record<string, unknown>[] = [];
for (const file of featureFiles) {
  const fixtures = JSON.parse(await readFile(new URL(`../fixtures/${file}.json`, import.meta.url), 'utf8'));
  const cases = all ? fixtures : fixtures.filter((f: { id: string }) => smokeCases[file].includes(f.id));
  if (!all && cases.length !== smokeCases[file].length) throw new Error(`평가 자료가 누락되었습니다: ${file}`);
  for (const fixture of cases) {
    const started = Date.now();
    const { failures, result } = await evaluateFixture(file, fixture, services);
    const latencyMs = Date.now() - started;
    reports.push({ feature: file, id: fixture.id, passed: !failures.length, failures, latencyMs, result });
    console.info(`${file}/${fixture.id}: ${failures.length ? 'FAIL' : 'PASS'} ${(latencyMs / 1000).toFixed(1)}s ${failures.join(' / ')}`);
    // Persist after every case so interrupted long evaluations remain reviewable.
    await mkdir('test-output', { recursive: true });
    await writeFile(`test-output/local-${config.textModel.replace(/[^a-zA-Z0-9._-]/g, '_')}-${all ? 'all' : 'smoke'}.json`, JSON.stringify({ model: config.textModel, contextSize: config.ollamaContextSize, createdAt: new Date().toISOString(), automaticChecksOnly: true, reports }, null, 2));
  }
}
console.info(`${config.textModel}: ${reports.filter(r => r.passed).length}/${reports.length} 자동 조건 통과. 원문 누락·의미는 별도 검토가 필요합니다.`);
if (reports.some(r => !r.passed)) process.exitCode = 1;
