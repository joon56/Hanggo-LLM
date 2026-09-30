import { existsSync, readFileSync, writeFileSync } from 'node:fs';

// Remove retired provider settings without printing values. Keep unrelated settings.
const file = '.env';
let source = readFileSync(existsSync(file) ? file : '.env.example', 'utf8');
source = source.replace(/^[ \t]*(?:export[ \t]+)?(?:OPENAI_[A-Z0-9_]+|AI_PROVIDER)[ \t]*=.*(?:\r?\n|$)/gm, '');
source = source.replace(/^#[^\r\n]*(?:OPENAI_|AI_PROVIDER)[^\r\n]*(?:\r?\n|$)/gm, '');
const settings = { AI_ENABLED: 'true', FEATURE_OWNER_LOG_ENABLED: 'true', FEATURE_BRIEF_ENABLED: 'true', FEATURE_SHELTER_ENABLED: 'true' };
for (const [key, value] of Object.entries(settings)) {
  const pattern = new RegExp(`^${key}=.*$`, 'gm');
  source = pattern.test(source) ? source.replace(pattern, `${key}=${value}`) : `${source.trimEnd()}\n${key}=${value}\n`;
}
writeFileSync(file, source, { mode: 0o600 });
console.info('로컬 AI와 네 기능을 활성화했습니다. 이전 API 공급사 설정은 제거하고 로컬 모델·기타 설정은 유지했습니다.');
