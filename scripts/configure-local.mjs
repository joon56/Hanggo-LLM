import { existsSync, readFileSync, writeFileSync } from 'node:fs';

// Preserve secrets and unrelated settings; never print the .env contents.
const file = '.env';
let source = readFileSync(existsSync(file) ? file : '.env.example', 'utf8');
const settings = { AI_PROVIDER: 'ollama', AI_ENABLED: 'true', FEATURE_OWNER_LOG_ENABLED: 'true', FEATURE_BRIEF_ENABLED: 'true', FEATURE_SHELTER_ENABLED: 'true' };
for (const [key, value] of Object.entries(settings)) {
  const pattern = new RegExp(`^${key}=.*$`, 'gm');
  source = pattern.test(source) ? source.replace(pattern, `${key}=${value}`) : `${source.trimEnd()}\n${key}=${value}\n`;
}
writeFileSync(file, source, { mode: 0o600 });
console.info('로컬 AI와 네 기능을 .env에서 활성화했습니다. 기존 키와 모델 설정은 보존했습니다.');
