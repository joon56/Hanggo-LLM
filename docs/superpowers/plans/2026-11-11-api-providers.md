# 외부 API 텍스트 모델 연결과 모델 선택 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 텍스트 기능 4개를 로컬 Ollama와 외부 API(Gemini·Claude) 중 설정으로 골라 실행하고, 같은 코드 경로로 후보 모델을 82개 평가 자료에서 비교해 최종 모델을 고른다.

**Architecture:** 기존 서비스(`createNoteService` 등)의 검증·대체 경로는 그대로 두고, `extract` 함수만 API용으로 새로 만든다. 모델에는 원문 문장에 번호를 붙여 보내고 번호만 받는다. 코드가 번호를 원문 그대로의 인용으로 되돌린 뒤 기존 검증에 넘긴다. 업체 연결은 "지시문 + 고정 출력 형식 + 입력 → JSON + 토큰" 한 가지 함수 형태로 통일한다.

**Tech Stack:** TypeScript (Node 24 타입 제거 실행), Express 5, Zod 4, Vitest, React 19, `@anthropic-ai/sdk` 1.8, `@google/genai` 3.1.

설계: [docs/superpowers/specs/2026-11-11-api-providers-design.md](../specs/2026-11-11-api-providers-design.md)

## Global Constraints

- 브랜치 `feat/api-providers`. GitHub에 push하지 않는다. 작업마다 커밋하고 메시지 끝에 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`를 붙인다.
- Windows에서 명령은 `npm.cmd`로 실행한다. 서버 테스트 파일 첫 줄은 `// @vitest-environment node`다.
- 서버 코드는 `.ts` 확장자를 붙여 import하고, 타입만 가져올 때는 `import type`을 쓴다(`verbatimModuleSyntax`, `erasableSyntaxOnly`).
- 설정: `AI_PROVIDER=local|api`(기본 `local`, 내부 값 `ollama`/`api`), `API_TEXT_MODEL`(기본 `gemini-3.8-flash`), `API_SHORT_MODEL`(기본 `claude-haiku-5-5`), `API_EFFORT=low|medium|high`(기본 `low`), `API_TIMEOUT_MS`(기본 60000), `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`.
- 모델 ID는 `gemini-3.8-flash`, `claude-sonnet-5-5`, `claude-haiku-5-5`다. 업체는 접두사 `gemini-`, `claude-`로 정한다.
- 1차는 텍스트만 API로 보낸다. 음성 전사(`transcribe`, `liveSpeech`)와 영상 관찰(`vision`)은 로컬 그대로다.
- 로컬 경로(`server/ollama.ts`, 기존 프롬프트 상수)는 바꾸지 않는다. 기준선 74/82의 비교 조건을 유지하기 위해서다.
- AI 초안의 `mode`는 기존대로 `'ollama'`를 쓴다. 새 값을 만들지 않는다. 실제 모델은 `draft.generation.model`로 구분한다.
- Claude 요청에는 `temperature`를 보내지 않는다. 서버 측 대체 모델(`fallbacks`)도 쓰지 않는다. 비교 평가에서 어떤 모델이 답했는지 섞이면 안 되기 때문이다. 거절(`refusal`)은 실패로 기록한다.
- 키는 서버 `.env`에만 둔다. `VITE_` 접두사를 쓰지 않는다. 키를 로그·세션 응답·테스트 출력에 넣지 않는다.
- 로그에는 원문을 남기지 않고 모델, 토큰 수, 처리 시간만 남긴다.
- 테스트는 네트워크를 쓰지 않는다. 업체 SDK는 가짜 객체로 주입한다.
- 실제 API를 호출하는 평가(Task 7)는 비용이 든다. 실행 전에 사용자 확인을 받고, 가상 자료만 쓴다.

---

### Task 1: 설정 — 로컬/API 선택과 시작 시 검사

**Files:**
- Modify: `server/config.ts`
- Modify: `server/config.test.ts:9-13`
- Modify: `.env.example`
- Modify: `scripts/configure-local.mjs:5-7,14`

**Interfaces:**
- Produces: `type ApiEffort = 'low' | 'medium' | 'high'`, `apiVendor(model: string): 'gemini' | 'claude' | null`, `activeTextModel(config: Config): string`. `Config`에 `provider: 'ollama' | 'api'`, `apiTextModel: string`, `apiShortModel: string`, `apiEffort: ApiEffort`, `apiTimeoutMs: number`, `geminiApiKey: string`, `anthropicApiKey: string`가 추가된다.

- [ ] **Step 1: 실패 테스트 작성**

`server/config.test.ts`의 import를 바꾸고, 9~13줄의 `'cannot select a paid provider through obsolete environment settings'` 테스트를 아래로 바꾼다. 나머지 테스트는 그대로 둔다.

```ts
import { activeTextModel, readConfig } from './config.ts';
```

```ts
it('cannot select a paid provider through obsolete environment settings', () => {
  expect(() => readConfig({ AI_PROVIDER: 'openai', OPENAI_API_KEY: 'obsolete-test-value' })).toThrow('AI_PROVIDER must be local or api.');
  const config = readConfig({ OPENAI_API_KEY: 'obsolete-test-value', OPENAI_TEXT_MODEL: 'old-model' });
  expect(config).toMatchObject({ provider: 'ollama', textModel: 'qwen3.5:9b' });
  expect(config).not.toHaveProperty('apiKey');
});
it('defaults to the local provider with API settings ready but unused', () => {
  expect(readConfig({ AI_PROVIDER: 'local' })).toMatchObject({ provider: 'ollama', apiTextModel: 'gemini-3.8-flash', apiShortModel: 'claude-haiku-5-5', apiEffort: 'low', apiTimeoutMs: 60000 });
});
it('requires the key of every vendor an API model needs', () => {
  expect(() => readConfig({ AI_PROVIDER: 'api', ANTHROPIC_API_KEY: 'test-a' })).toThrow('GEMINI_API_KEY is required for gemini-3.8-flash.');
  expect(() => readConfig({ AI_PROVIDER: 'api', GEMINI_API_KEY: 'test-g' })).toThrow('ANTHROPIC_API_KEY is required for claude-haiku-5-5.');
  expect(readConfig({ AI_PROVIDER: 'api', GEMINI_API_KEY: 'test-g', ANTHROPIC_API_KEY: 'test-a' })).toMatchObject({ provider: 'api' });
  expect(readConfig({ AI_PROVIDER: 'api', API_TEXT_MODEL: 'claude-sonnet-5-5', ANTHROPIC_API_KEY: 'test-a' })).toMatchObject({ apiTextModel: 'claude-sonnet-5-5' });
});
it('rejects unknown API models and effort levels', () => {
  expect(() => readConfig({ AI_PROVIDER: 'api', API_TEXT_MODEL: 'gpt-6', GEMINI_API_KEY: 'test-g', ANTHROPIC_API_KEY: 'test-a' })).toThrow('Unsupported API model: gpt-6');
  expect(() => readConfig({ API_EFFORT: 'max' })).toThrow('API_EFFORT must be low, medium or high.');
});
it('reports the active text model for the session', () => {
  expect(activeTextModel(readConfig({}))).toBe('qwen3.5:9b');
  expect(activeTextModel(readConfig({ AI_PROVIDER: 'api', GEMINI_API_KEY: 'test-g', ANTHROPIC_API_KEY: 'test-a' }))).toBe('gemini-3.8-flash');
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm.cmd test -- server/config.test.ts`
Expected: FAIL. `activeTextModel`이 export되지 않았고 `AI_PROVIDER: 'openai'`가 예외 없이 통과한다.

- [ ] **Step 3: 구현**

`server/config.ts` 맨 위 import 아래에 추가한다.

```ts
export type ApiEffort = 'low' | 'medium' | 'high';
export const apiVendor = (model: string) => model.startsWith('gemini-') ? 'gemini' as const : model.startsWith('claude-') ? 'claude' as const : null;
```

27줄(`if (liveConsultationEnabled && !liveSpeechModel) ...`) 바로 다음에 추가한다.

```ts
  const providerSetting = env.AI_PROVIDER || 'local';
  if (providerSetting !== 'local' && providerSetting !== 'api') throw new Error('AI_PROVIDER must be local or api.');
  const provider = providerSetting === 'api' ? 'api' as const : 'ollama' as const;
  const apiEffort = env.API_EFFORT || 'low';
  if (apiEffort !== 'low' && apiEffort !== 'medium' && apiEffort !== 'high') throw new Error('API_EFFORT must be low, medium or high.');
  const apiTextModel = env.API_TEXT_MODEL || 'gemini-3.8-flash', apiShortModel = env.API_SHORT_MODEL || 'claude-haiku-5-5';
  const geminiApiKey = env.GEMINI_API_KEY || '', anthropicApiKey = env.ANTHROPIC_API_KEY || '';
  // Fail at startup, not on the first record, when an API model lacks its key.
  if (provider === 'api') for (const model of [apiTextModel, apiShortModel]) {
    const vendor = apiVendor(model);
    if (!vendor) throw new Error(`Unsupported API model: ${model}`);
    if (vendor === 'gemini' && !geminiApiKey) throw new Error(`GEMINI_API_KEY is required for ${model}.`);
    if (vendor === 'claude' && !anthropicApiKey) throw new Error(`ANTHROPIC_API_KEY is required for ${model}.`);
  }
```

반환 객체의 첫 줄을 바꾼다.

```ts
  return { production, host, password, publicOrigin, provider,
```

반환 객체의 마지막 속성(`trustProxy: ...`) 앞에 추가한다.

```ts
    apiTextModel, apiShortModel, apiEffort: apiEffort as ApiEffort, apiTimeoutMs: number('API_TIMEOUT_MS', 60000, 600000), geminiApiKey, anthropicApiKey,
```

파일 끝(`export type Config ...` 다음)에 추가한다.

```ts
export function activeTextModel(config: Config): string { return config.provider === 'api' ? config.apiTextModel : config.textModel; }
```

- [ ] **Step 4: 통과 확인**

Run: `npm.cmd test -- server/config.test.ts`
Expected: PASS.

- [ ] **Step 5: `.env.example`과 설정 스크립트 수정**

`.env.example`의 `AI_DAILY_LIMIT=200` 줄 바로 앞에 추가한다.

```dotenv
# Text model path: local (Ollama on this PC) or api (Google/Anthropic). Speech and video stay local.
# API mode sends masked text outside this PC. Use virtual data only until a consent process exists.
# Use a paid-tier Gemini key: free-tier inputs are used to improve Google products.
AI_PROVIDER=local
API_TEXT_MODEL=gemini-3.8-flash
API_SHORT_MODEL=claude-haiku-5-5
API_EFFORT=low
API_TIMEOUT_MS=60000
GEMINI_API_KEY=
ANTHROPIC_API_KEY=
```

`scripts/configure-local.mjs`의 5~7줄을 아래로 바꾼다. `AI_PROVIDER`와 새 키는 지우지 않고, 폐기된 OpenAI 설정만 지운다.

```js
// Remove retired OpenAI settings without printing values. Keep AI_PROVIDER, API keys and other settings.
source = source.replace(/^[ \t]*(?:export[ \t]+)?OPENAI_[A-Z0-9_]+[ \t]*=.*(?:\r?\n|$)/gm, '');
source = source.replace(/^#[^\r\n]*OPENAI_[^\r\n]*(?:\r?\n|$)/gm, '');
```

기존 4줄 주석(`// Remove retired provider settings ...`)은 위 주석으로 대체되므로 지운다. 마지막 줄의 안내 문구를 바꾼다.

```js
console.info('로컬 AI와 네 기능을 활성화했습니다. 이전 OpenAI 설정은 제거하고 AI_PROVIDER·API 키·로컬 모델 등 다른 설정은 유지했습니다.');
```

- [ ] **Step 6: 설정 스크립트 수동 확인**

Run (Git Bash, 저장소 루트):
```bash
R=$(pwd); mkdir -p .tmp/configure-check && printf 'AI_PROVIDER=api\nOPENAI_API_KEY=old\n# OPENAI_TEXT_MODEL note\nGEMINI_API_KEY=keep\n' > .tmp/configure-check/.env && (cd .tmp/configure-check && node "$R/scripts/configure-local.mjs") && cat .tmp/configure-check/.env; rm -rf .tmp/configure-check
```
Expected: `AI_PROVIDER=api`, `GEMINI_API_KEY=keep`, 기능 플래그 4줄이 있고 `OPENAI`가 들어간 줄이 없다.

- [ ] **Step 7: 전체 테스트와 타입 검사**

Run: `npm.cmd test -- --maxWorkers=2` 그리고 `npm.cmd run typecheck`
Expected: 모두 통과. 기존 `provider: 'ollama'` 기대값이 그대로 맞아야 한다.

- [ ] **Step 8: 커밋**

```bash
git add server/config.ts server/config.test.ts .env.example scripts/configure-local.mjs
git commit -m "feat: select local or API text provider in config" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 문장 번호 변환

**Files:**
- Create: `server/sentence-choice.ts`
- Create: `server/sentence-choice.test.ts`
- Modify: `src/domain/shelter.ts:39` (`memoSentences` export)

**Interfaces:**
- Consumes: `splitNoteSentences(source: string): string[]` (`src/domain/notes.ts`), `memoSentences(source: string): string[]` (`src/domain/shelter.ts`, 이 작업에서 export).
- Produces: `type SentenceUnit = { id: string; text: string; start: number; end: number }`, `numberSentences(source: string, split?: (text: string) => string[], prefix?: string): SentenceUnit[]`, `unitText(units: SentenceUnit[], id: string): string | null`, `quoteRange(source: string, units: SentenceUnit[], fromId: string, toId: string): string | null`.

- [ ] **Step 1: 실패 테스트 작성**

`server/sentence-choice.test.ts`:

```ts
// @vitest-environment node
import { expect, it } from 'vitest';
import { numberSentences, quoteRange, unitText } from './sentence-choice.ts';
import { memoSentences } from '../src/domain/shelter.ts';

it('numbers sentences with exact source offsets', () => {
  const source = '초코가 3.5분 짖었어요. 매트로 이동했어요!\n멈췄어요';
  const units = numberSentences(source);
  expect(units.map(unit => unit.text)).toEqual(['초코가 3.5분 짖었어요.', '매트로 이동했어요!', '멈췄어요']);
  expect(units.map(unit => unit.id)).toEqual(['S1', 'S2', 'S3']);
  for (const unit of units) expect(source.slice(unit.start, unit.end)).toBe(unit.text);
});
it('keeps repeated sentences as separate units at their own positions', () => {
  expect(numberSentences('짖었어요. 짖었어요.').map(unit => [unit.start, unit.end])).toEqual([[0, 5], [6, 11]]);
});
it('splits sentences longer than 2000 characters at a space without losing text', () => {
  const units = numberSentences(`${'가'.repeat(1500)} ${'나'.repeat(1500)}`);
  expect(units.map(unit => unit.text)).toEqual(['가'.repeat(1500), '나'.repeat(1500)]);
  expect(units[1].start).toBe(1501);
});
it('returns a contiguous source range only for ordered known IDs', () => {
  const source = '첫째. 둘째. 셋째.';
  const units = numberSentences(source);
  expect(quoteRange(source, units, 'S1', 'S2')).toBe('첫째. 둘째.');
  expect(quoteRange(source, units, 'S2', 'S1')).toBeNull();
  expect(quoteRange(source, units, 'S1', 'S9')).toBeNull();
  expect(unitText(units, 'S3')).toBe('셋째.');
  expect(unitText(units, 'S4')).toBeNull();
});
it('numbers memo sentences with the shelter splitter and a memo prefix', () => {
  expect(numberSentences('사람을 좋아함. 다른 개를 피함.', memoSentences, 'M1-S').map(unit => unit.id)).toEqual(['M1-S1', 'M1-S2']);
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm.cmd test -- server/sentence-choice.test.ts`
Expected: FAIL. `./sentence-choice.ts`를 찾을 수 없고 `memoSentences`가 export되지 않았다.

- [ ] **Step 3: 구현**

`src/domain/shelter.ts` 39줄의 `function memoSentences(source: string): string[] {`를 `export function memoSentences(source: string): string[] {`로 바꾼다.

`server/sentence-choice.ts`:

```ts
import { splitNoteSentences } from '../src/domain/notes.ts';

export type SentenceUnit = { id: string; text: string; start: number; end: number };
const MAX_UNIT = 2000;

// Models choose these IDs instead of rewriting evidence; code copies the exact source span.
export function numberSentences(source: string, split: (text: string) => string[] = splitNoteSentences, prefix = 'S'): SentenceUnit[] {
  const units: SentenceUnit[] = []; let cursor = 0;
  for (const sentence of split(source)) {
    const start = source.indexOf(sentence, cursor);
    if (start < 0) continue;
    cursor = start + sentence.length;
    for (let offset = 0; offset < sentence.length;) {
      let end = Math.min(sentence.length, offset + MAX_UNIT);
      if (end < sentence.length) { const space = sentence.lastIndexOf(' ', end); if (space > offset) end = space; }
      const piece = sentence.slice(offset, end).trim();
      if (piece) { const at = source.indexOf(piece, start + offset); units.push({ id: `${prefix}${units.length + 1}`, text: piece, start: at, end: at + piece.length }); }
      offset = end;
    }
  }
  return units;
}

export const unitText = (units: SentenceUnit[], id: string): string | null => units.find(unit => unit.id === id)?.text ?? null;

export function quoteRange(source: string, units: SentenceUnit[], fromId: string, toId: string): string | null {
  const from = units.findIndex(unit => unit.id === fromId), to = units.findIndex(unit => unit.id === toId);
  return from < 0 || to < from ? null : source.slice(units[from].start, units[to].end);
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm.cmd test -- server/sentence-choice.test.ts src/domain/shelter.test.ts`
Expected: PASS. `src/domain/shelter.test.ts`가 없으면 첫 파일만 실행한다.

- [ ] **Step 5: 커밋**

```bash
git add server/sentence-choice.ts server/sentence-choice.test.ts src/domain/shelter.ts
git commit -m "feat: number source sentences for ID-based quoting" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 기능별 번호 선택 형식과 변환

**Files:**
- Create: `server/api-mappers.ts`
- Create: `server/api-mappers.test.ts`

**Interfaces:**
- Consumes: Task 2의 `numberSentences`, `unitText`, `quoteRange`, `SentenceUnit`, `memoSentences`.
- Produces:
  - 출력 형식: `NoteChoice`, `OwnerChoice`, `ShelterChoice`, `BriefChoice` (Zod 스키마, 길이·범위 제약 없음)
  - 지시문: `API_NOTE_INSTRUCTIONS`, `API_OWNER_INSTRUCTIONS`, `API_SHELTER_INSTRUCTIONS` (string)
  - 요청 생성: `noteRequest(masked: string): { units: SentenceUnit[]; input: { sentences: { id: string; text: string }[] } }`, `ownerRequest(masked: OwnerInput): { units: SentenceUnit[]; input: Record<string, unknown> }`, `shelterRequest(masked: ShelterInput): { memos: ShelterUnits; input: { animal: ...; memos: { date: string; role: string; sentences: { id: string; text: string }[] }[] } }`, `briefRequest(draft: BriefDraft): { period; facts; omittedFacts: number; scope: string }`
  - 변환: `mapNoteChoice(units, raw): unknown`, `mapOwnerChoice(source: string, units, raw): unknown`, `mapShelterChoice(memos: ShelterUnits, raw): unknown`. 반환값은 기존 서비스의 `Extraction` / `OwnerExtraction` / `ShelterExtraction` 형태다. 형식이 틀리거나 모르는 번호가 있으면 위험 신호만 담은 객체를 돌려준다. 그러면 기존 서비스가 재시도 메시지를 붙여 다시 요청한다.
  - `type ShelterUnits = { memo: ShelterInput['memos'][number]; units: SentenceUnit[] }[]`

- [ ] **Step 1: 실패 테스트 작성**

`server/api-mappers.test.ts`:

```ts
// @vitest-environment node
import { expect, it } from 'vitest';
import { z } from 'zod';
import { API_NOTE_INSTRUCTIONS, API_OWNER_INSTRUCTIONS, API_SHELTER_INSTRUCTIONS, BriefChoice, NoteChoice, OwnerChoice, ShelterChoice, briefRequest, mapNoteChoice, mapOwnerChoice, mapShelterChoice, noteRequest, ownerRequest, shelterRequest } from './api-mappers.ts';
import type { BriefDraft } from '../src/domain/workspace-types.ts';

it('asks API models for sentence IDs instead of rewritten quotes', () => {
  for (const text of [API_NOTE_INSTRUCTIONS, API_OWNER_INSTRUCTIONS, API_SHELTER_INSTRUCTIONS]) expect(text).not.toContain('sourceQuote');
});
it('maps note sentence IDs back to exact masked text and keeps risk on invalid IDs', () => {
  const { units, input } = noteRequest('보호자는 짖는다고 말했습니다. 앉아를 관찰했습니다.');
  expect(input).toEqual({ sentences: [{ id: 'S1', text: '보호자는 짖는다고 말했습니다.' }, { id: 'S2', text: '앉아를 관찰했습니다.' }] });
  expect(mapNoteChoice(units, { items: [{ sentence: 'S2', category: 'observation' }], safetyFlags: [], methodReview: false }))
    .toEqual({ items: [{ category: 'observation', sourceQuote: '앉아를 관찰했습니다.' }], safetyFlags: [], methodReview: false });
  expect(mapNoteChoice(units, { items: [{ sentence: 'S9', category: 'task' }], safetyFlags: ['통증'], methodReview: true })).toEqual({ safetyFlags: ['통증'], methodReview: true });
  expect(mapNoteChoice(units, { broken: true, safetyFlags: ['물림'] })).toEqual({ safetyFlags: ['물림'], methodReview: undefined });
});
it('maps an owner sentence range to one contiguous quote without sending the raw text field', () => {
  const masked = { text: '초코가 초인종에 3분 짖었어요. 매트로 보냈더니 멈췄어요.', pets: [{ id: 'pet_0', name: '초코', nicknames: [] }], now: '2026-11-11T10:00:00+09:00', timeZone: 'Asia/Seoul', sourceKind: 'nl_log_text' as const };
  const { units, input } = ownerRequest(masked);
  expect(input).not.toHaveProperty('text');
  expect(input.sentences).toHaveLength(2);
  const event = { petId: 'pet_0', type: 'bark', fromSentence: 'S1', toSentence: 'S2', timeHint: null, durationMin: 3, trigger: 'doorbell', intervention: '매트로 보냈더니', outcome: 'stopped', details: { amountText: null, isTreat: null, excretionKinds: [], placeText: null } };
  const mapped = mapOwnerChoice(masked.text, units, { events: [event], safetyFlags: [], clarification: null }) as { events: Record<string, unknown>[] };
  expect(mapped.events[0].sourceQuote).toBe(masked.text);
  expect(mapped.events[0]).not.toHaveProperty('fromSentence');
  expect(mapOwnerChoice(masked.text, units, { events: [{ ...event, fromSentence: 'S2', toSentence: 'S1' }], safetyFlags: ['pain_sign'], clarification: null })).toEqual({ safetyFlags: ['pain_sign'] });
});
it('maps memo sentence IDs to opaque memo IDs and exact sentences', () => {
  const masked = { animal: { id: 'animal', name: '**', species: 'dog' as const, ageMonths: 24 }, memos: [
    { id: 'memo-0', date: '2026-11-01', role: 'staff' as const, text: '사람을 좋아함. 다른 개를 피함.' },
    { id: 'memo-1', date: '2026-11-02', role: 'volunteer' as const, text: '간식을 잘 먹음.' }] };
  const { memos, input } = shelterRequest(masked);
  expect(JSON.stringify(input)).not.toContain('memo-0');
  expect(input.memos[1].sentences).toEqual([{ id: 'M2-S1', text: '간식을 잘 먹음.' }]);
  expect(mapShelterChoice(memos, { observations: [{ sentence: 'M1-S2', category: 'dogs', valence: 'caution' }], safetyFlags: [] }))
    .toEqual({ observations: [{ memoId: 'memo-0', sourceQuote: '다른 개를 피함.', category: 'dogs', valence: 'caution' }], safetyFlags: [] });
  expect(mapShelterChoice(memos, { observations: [{ sentence: 'M3-S1', category: 'food', valence: 'positive' }], safetyFlags: [] })).toEqual({ safetyFlags: [] });
});
it('sends at most 48 brief facts with bounded text', () => {
  const draft = { period: { from: '2026-10-29', to: '2026-11-11', daysWithRecords: 3 }, facts: Array.from({ length: 50 }, (_, index) => ({ id: `f${index}`, label: 'L', value: 'x'.repeat(200), unit: '건', previousValue: null, refs: [] })) } as unknown as BriefDraft;
  const request = briefRequest(draft);
  expect(request.facts).toHaveLength(48);
  expect(request.omittedFacts).toBe(2);
  expect(String(request.facts[0].value)).toHaveLength(160);
});
it('uses wire-safe schemas without length or range constraints', () => {
  for (const schema of [NoteChoice, OwnerChoice, ShelterChoice, BriefChoice]) {
    const json = JSON.stringify(z.toJSONSchema(schema));
    for (const keyword of ['minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems']) expect(json).not.toContain(`"${keyword}"`);
  }
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm.cmd test -- server/api-mappers.test.ts`
Expected: FAIL. `./api-mappers.ts`를 찾을 수 없다.

- [ ] **Step 3: 구현**

`server/api-mappers.ts`:

```ts
import { z } from 'zod';
import { Extraction } from './service.ts';
import { NOTE_INSTRUCTIONS } from './prompts.ts';
import { OWNER_INSTRUCTIONS } from './owner-service.ts';
import { SHELTER_INSTRUCTIONS, ShelterExtraction } from './shelter-service.ts';
import { OwnerEventFields, ownerSafetyFlags } from '../src/domain/owner-log.ts';
import { memoSentences } from '../src/domain/shelter.ts';
import { numberSentences, quoteRange, unitText, type SentenceUnit } from './sentence-choice.ts';
import type { BriefDraft, OwnerInput, ShelterInput } from '../src/domain/workspace-types.ts';

// Output schemas stay free of length and range keywords that some vendors reject;
// the existing services still enforce every limit after mapping.
const nullableText = z.string().nullable(), ids = z.array(z.string());
const owner = OwnerEventFields.shape, shelter = ShelterExtraction.shape.observations.element.shape;
export const NoteChoice = z.object({ items: z.array(z.object({ sentence: z.string(), category: Extraction.shape.items.element.shape.category }).strict()), safetyFlags: Extraction.shape.safetyFlags, methodReview: z.boolean() }).strict();
export const OwnerChoice = z.object({ events: z.array(z.object({
  petId: z.string().nullable(), type: owner.type, fromSentence: z.string(), toSentence: z.string(), timeHint: nullableText, durationMin: z.number().nullable(),
  trigger: owner.trigger, intervention: nullableText, outcome: owner.outcome,
  details: z.object({ amountText: nullableText, isTreat: z.boolean().nullable(), excretionKinds: z.array(z.enum(['pee', 'poop', 'unknown'])), placeText: nullableText }).strict(),
}).strict()), safetyFlags: z.array(z.enum(ownerSafetyFlags)), clarification: nullableText }).strict();
export const ShelterChoice = z.object({ observations: z.array(z.object({ sentence: z.string(), category: shelter.category, valence: shelter.valence }).strict()), safetyFlags: ShelterExtraction.shape.safetyFlags }).strict();
export const BriefChoice = z.object({ summary: ids, changes: ids, questionsForOwner: ids }).strict();

const CHOOSE = '입력의 sentences는 원문을 나눈 문장이며 id로 가리킵니다. 문장을 다시 쓰지 말고 id만 고르세요. 코드가 해당 원문을 그대로 복사합니다.';
export const API_NOTE_INSTRUCTIONS = `${NOTE_INSTRUCTIONS.replace('sourceQuote는 입력의 정확한 연속 부분 문자열이어야 한다. 바꾸거나 덧붙이지 않는다.', '각 항목의 sentence에는 입력 문장 id 하나를 쓴다.')}
${CHOOSE} 같은 문장 id를 두 번 쓰지 마세요. 출처가 없는 짧은 메모·일상 진술·건강 증상은 follow_up입니다. observation은 훈련사의 직접 관찰이 명시된 경우입니다. 증상과 확인할 내용은 follow_up에 보존하세요. 체벌·강압 행위는 methodReview에 표시합니다. 행위만으로 원문에 없는 통증이나 건강 증상을 추측해 safetyFlags에 추가하지 마세요.`;
export const API_OWNER_INSTRUCTIONS = `${OWNER_INSTRUCTIONS.replace('각 사건 sourceQuote는 입력의 정확한 부분 문자열. timeHint, intervention, amountText, placeText도 해당 sourceQuote의 정확한 부분 문자열이며 요약하지 않는다.', '각 사건의 근거는 fromSentence부터 toSentence까지의 입력 문장 id 범위다. 한 문장이면 두 값이 같다. timeHint, intervention, amountText, placeText는 그 범위 원문의 정확한 부분 문자열이며 요약하지 않는다.')}
${CHOOSE} 발생 시점이 없으면 timeHint=null, 지속 시간이 없으면 durationMin=null입니다. now를 발생 시각으로 복사하지 마세요. 모르는 값을 0이나 무관한 원문으로 채우지 마세요. excretionKinds의 pee는 소변, poop은 대변이며 배변 외 사건에서는 []입니다. 음식 외 사건의 isTreat는 null입니다.`;
export const API_SHELTER_INSTRUCTIONS = `${SHELTER_INSTRUCTIONS.replace('보호소 메모의 관찰을 원문 그대로 sourceQuote로 추출하고 memoId, category, valence를 반환하세요.', '보호소 메모 문장 중 관찰을 골라 sentence에 문장 id를 쓰고 category, valence를 반환하세요.').replace(' 마침표나 줄바꿈으로 나눈 원문 문장 전체를 인용하세요.', '')}
${CHOOSE} 행동 관찰과 무관한 연락처는 제외하세요. category는 기록 대상 동물의 종이 아니라 관찰 주제입니다. people=사람과의 관계, dogs=다른 개와의 관계, cats=고양이와의 관계, food=음식·간식입니다.`;

const sentences = (units: SentenceUnit[]) => units.map(({ id, text }) => ({ id, text }));
const risk = (raw: unknown) => raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
export type ShelterUnits = { memo: ShelterInput['memos'][number]; units: SentenceUnit[] }[];

export function noteRequest(masked: string) { const units = numberSentences(masked); return { units, input: { sentences: sentences(units) } }; }
export function ownerRequest(masked: OwnerInput) {
  const { text, ...context } = masked; const units = numberSentences(text);
  return { units, input: { ...context, sentences: sentences(units) } };
}
export function shelterRequest(masked: ShelterInput) {
  const memos: ShelterUnits = masked.memos.map((memo, index) => ({ memo, units: numberSentences(memo.text, memoSentences, `M${index + 1}-S`) }));
  return { memos, input: { animal: { species: masked.animal.species, ageMonths: masked.animal.ageMonths }, memos: memos.map(({ memo, units }) => ({ date: memo.date, role: memo.role, sentences: sentences(units) })) } };
}
export function briefRequest(draft: BriefDraft) {
  const facts = draft.facts.slice(0, 48).map(({ id, label, value, unit, previousValue }) => ({ id, label, value: typeof value === 'string' ? value.slice(0, 160) : value, unit, previousValue }));
  return { period: draft.period, facts, omittedFacts: draft.facts.length - facts.length, scope: '날짜별 기록 집계와 제한된 맥락 발췌. 원문 전체와 전사는 보내지 않음.' };
}

export function mapNoteChoice(units: SentenceUnit[], raw: unknown): unknown {
  const parsed = NoteChoice.safeParse(raw);
  if (!parsed.success) return { safetyFlags: risk(raw).safetyFlags, methodReview: risk(raw).methodReview };
  const { safetyFlags, methodReview } = parsed.data;
  const items = parsed.data.items.map(item => ({ category: item.category, sourceQuote: unitText(units, item.sentence) }));
  return items.some(item => item.sourceQuote === null) ? { safetyFlags, methodReview } : { items, safetyFlags, methodReview };
}
export function mapOwnerChoice(source: string, units: SentenceUnit[], raw: unknown): unknown {
  const parsed = OwnerChoice.safeParse(raw);
  if (!parsed.success) return { safetyFlags: risk(raw).safetyFlags };
  const events = parsed.data.events.map(({ fromSentence, toSentence, ...event }) => ({ ...event, sourceQuote: quoteRange(source, units, fromSentence, toSentence) }));
  return events.some(event => event.sourceQuote === null) ? { safetyFlags: parsed.data.safetyFlags } : { events, safetyFlags: parsed.data.safetyFlags, clarification: parsed.data.clarification };
}
export function mapShelterChoice(memos: ShelterUnits, raw: unknown): unknown {
  const parsed = ShelterChoice.safeParse(raw);
  if (!parsed.success) return { safetyFlags: risk(raw).safetyFlags };
  const observations = parsed.data.observations.map(item => {
    const match = memos.find(({ units }) => units.some(unit => unit.id === item.sentence));
    return match ? { memoId: match.memo.id, sourceQuote: unitText(match.units, item.sentence), category: item.category, valence: item.valence } : null;
  });
  return observations.some(item => item === null) ? { safetyFlags: parsed.data.safetyFlags } : { observations, safetyFlags: parsed.data.safetyFlags };
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm.cmd test -- server/api-mappers.test.ts` 그리고 `npm.cmd run typecheck`
Expected: PASS. 첫 테스트가 실패하면 원본 프롬프트 문구가 바뀐 것이다. `.replace`의 대상 문자열을 현재 상수와 정확히 맞춘다.

- [ ] **Step 5: 커밋**

```bash
git add server/api-mappers.ts server/api-mappers.test.ts
git commit -m "feat: map API sentence choices to verified quotes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 업체 연결 (Gemini, Claude)

**Files:**
- Modify: `package.json`, `package-lock.json` (SDK 2개 추가)
- Create: `server/api-types.ts`, `server/api-types.test.ts`
- Create: `server/claude-client.ts`, `server/claude-client.test.ts`
- Create: `server/gemini-client.ts`, `server/gemini-client.test.ts`
- Create: `server/api-structured.ts`, `server/api-structured.test.ts`

**Interfaces:**
- Consumes: Task 1의 `ApiEffort`, `apiVendor`, `Config`.
- Produces:
  - `type ApiVendor = 'gemini' | 'claude'`
  - `type ApiUsage = { model: string; inputTokens: number; outputTokens: number; latencyMs: number }`
  - `type StructuredRequest = { model: string; system: string; input: unknown; schema: z.ZodType; signal?: AbortSignal }`
  - `type StructuredResult = { json: unknown; inputTokens: number; outputTokens: number }`
  - `type StructuredClient = (request: StructuredRequest) => Promise<StructuredResult>`
  - `toWireSchema(schema: z.ZodType, vendor: ApiVendor): Record<string, unknown>`
  - `createClaudeClient(apiKey: string, timeoutMs: number, effort: ApiEffort, messages?): StructuredClient`
  - `createGeminiClient(apiKey: string, timeoutMs: number, effort: ApiEffort, interactions?): StructuredClient`
  - `createStructuredClient(config: Config, clients?: Partial<Record<ApiVendor, StructuredClient>>): StructuredClient`

참고: SDK 사용법은 2026-11-11에 설치 패키지의 타입 정의에서 확인했다.
- Claude: `messages.create(body, { signal })`, `output_config: { effort, format: { type: 'json_schema', schema } }`, `stop_reason`, `usage.input_tokens`/`output_tokens`.
- Gemini: `interactions.create(params, { timeout_ms, retries, fetch_options })`, `system_instruction`, `response_format`, `generation_config.thinking_level` (`minimal|low|medium|high`), `store`, `status`, `output_text`, `usage.total_input_tokens`/`total_output_tokens`/`total_thought_tokens`.
- Gemini의 출력 비용에는 사고 토큰이 포함되므로 출력 토큰은 `total_output_tokens + total_thought_tokens`로 센다.

- [ ] **Step 1: SDK 설치**

Run: `npm.cmd install @anthropic-ai/sdk@^1.8.0 @google/genai@^3.1.0`
Expected: `package.json`의 `dependencies`에 두 패키지가 추가된다.

- [ ] **Step 2: 실패 테스트 작성**

`server/api-types.test.ts`:

```ts
// @vitest-environment node
import { expect, it } from 'vitest';
import { z } from 'zod';
import { toWireSchema } from './api-types.ts';

it('converts nullable values to type arrays for Gemini and keeps anyOf for Claude', () => {
  const schema = z.object({ kind: z.enum(['a', 'b']).nullable(), note: z.string().nullable(), list: z.array(z.string()) }).strict();
  const gemini = toWireSchema(schema, 'gemini') as any, claude = toWireSchema(schema, 'claude') as any;
  expect(gemini.properties.kind).toEqual({ type: ['string', 'null'], enum: ['a', 'b', null] });
  expect(gemini.properties.note).toEqual({ type: ['string', 'null'] });
  expect(claude.properties.kind.anyOf).toHaveLength(2);
  expect(gemini).not.toHaveProperty('$schema'); expect(claude).not.toHaveProperty('$schema');
  expect(gemini).toMatchObject({ type: 'object', additionalProperties: false, required: ['kind', 'note', 'list'] });
});
```

`server/claude-client.test.ts`:

```ts
// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createClaudeClient } from './claude-client.ts';

const schema = z.object({ value: z.string().nullable() }).strict();
const message = (extra = {}) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"value":"ok"}' }], usage: { input_tokens: 12, output_tokens: 5 }, ...extra });

it('sends a JSON schema with the configured effort and no sampling or fallback parameters', async () => {
  const create = vi.fn(async () => message());
  const client = createClaudeClient('test-key', 1000, 'low', { create } as never);
  const signal = new AbortController().signal;
  await expect(client({ model: 'claude-haiku-5-5', system: 'rules', input: { sentences: [] }, schema, signal })).resolves.toEqual({ json: { value: 'ok' }, inputTokens: 12, outputTokens: 5 });
  const [body, options] = create.mock.calls[0] as unknown as [Record<string, any>, { signal: AbortSignal }];
  expect(body).toMatchObject({ model: 'claude-haiku-5-5', system: 'rules', output_config: { effort: 'low', format: { type: 'json_schema', schema: { type: 'object', additionalProperties: false } } } });
  expect(body).not.toHaveProperty('temperature'); expect(body).not.toHaveProperty('fallbacks');
  expect(body.messages).toEqual([{ role: 'user', content: '{"sentences":[]}' }]);
  expect(options.signal).toBe(signal);
});
it.each(['refusal', 'max_tokens'])('treats %s as a failed call', async stop => {
  const client = createClaudeClient('test-key', 1000, 'low', { create: vi.fn(async () => message({ stop_reason: stop })) } as never);
  await expect(client({ model: 'claude-sonnet-5-5', system: 's', input: {}, schema })).rejects.toThrow(`Claude stopped with ${stop}.`);
});
```

`server/gemini-client.test.ts`:

```ts
// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createGeminiClient } from './gemini-client.ts';

const schema = z.object({ value: z.string().nullable() }).strict();

it('requests JSON with the configured thinking level and without storage, counting thought tokens as output', async () => {
  const create = vi.fn(async () => ({ status: 'completed', output_text: '{"value":null}', usage: { total_input_tokens: 20, total_output_tokens: 4, total_thought_tokens: 6 } }));
  const client = createGeminiClient('test-key', 1000, 'low', { create } as never);
  const signal = new AbortController().signal;
  await expect(client({ model: 'gemini-3.8-flash', system: 'rules', input: { a: 1 }, schema, signal })).resolves.toEqual({ json: { value: null }, inputTokens: 20, outputTokens: 10 });
  const [body, options] = create.mock.calls[0] as unknown as [Record<string, any>, Record<string, any>];
  expect(body).toMatchObject({ model: 'gemini-3.8-flash', system_instruction: 'rules', input: '{"a":1}', store: false, generation_config: { thinking_level: 'low' }, response_format: { type: 'text', mime_type: 'application/json' } });
  expect(body.response_format.schema.properties.value).toEqual({ type: ['string', 'null'] });
  expect(options).toMatchObject({ timeout_ms: 1000, retries: { strategy: 'attempt-count-backoff', maxRetries: 1 }, fetch_options: { signal } });
});
it('treats an unfinished interaction as a failed call', async () => {
  const client = createGeminiClient('test-key', 1000, 'low', { create: vi.fn(async () => ({ status: 'incomplete', output_text: '{}' })) } as never);
  await expect(client({ model: 'gemini-3.8-flash', system: 's', input: {}, schema })).rejects.toThrow('Gemini returned incomplete.');
});
```

`server/api-structured.test.ts`:

```ts
// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { readConfig } from './config.ts';
import { createStructuredClient } from './api-structured.ts';

it('routes by model prefix and rejects unknown vendors', async () => {
  const gemini = vi.fn(async () => ({ json: 'g', inputTokens: 1, outputTokens: 1 })), claude = vi.fn(async () => ({ json: 'c', inputTokens: 1, outputTokens: 1 }));
  const client = createStructuredClient(readConfig({}), { gemini, claude });
  const schema = z.object({}).strict();
  await expect(client({ model: 'gemini-3.8-flash', system: '', input: {}, schema })).resolves.toMatchObject({ json: 'g' });
  await expect(client({ model: 'claude-haiku-5-5', system: '', input: {}, schema })).resolves.toMatchObject({ json: 'c' });
  await expect(client({ model: 'gpt-6', system: '', input: {}, schema })).rejects.toThrow('No API client for gpt-6.');
});
```

- [ ] **Step 3: 실패 확인**

Run: `npm.cmd test -- server/api-types.test.ts server/claude-client.test.ts server/gemini-client.test.ts server/api-structured.test.ts`
Expected: FAIL. 4개 모듈을 찾을 수 없다.

- [ ] **Step 4: 구현**

`server/api-types.ts`:

```ts
import { z } from 'zod';

export type ApiVendor = 'gemini' | 'claude';
export type ApiUsage = { model: string; inputTokens: number; outputTokens: number; latencyMs: number };
export type StructuredRequest = { model: string; system: string; input: unknown; schema: z.ZodType; signal?: AbortSignal };
export type StructuredResult = { json: unknown; inputTokens: number; outputTokens: number };
export type StructuredClient = (request: StructuredRequest) => Promise<StructuredResult>;

// Claude accepts anyOf; Gemini documents nullable values as type arrays.
export function toWireSchema(schema: z.ZodType, vendor: ApiVendor): Record<string, unknown> {
  const normalize = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(normalize);
    if (!node || typeof node !== 'object') return node;
    const object = Object.fromEntries(Object.entries(node).filter(([key]) => key !== '$schema').map(([key, value]) => [key, normalize(value)])) as Record<string, unknown>;
    const options = object.anyOf;
    if (vendor !== 'gemini' || !Array.isArray(options) || options.length !== 2) return object;
    const other = options.find(option => (option as { type?: unknown }).type !== 'null') as Record<string, unknown> | undefined;
    if (!other || typeof other.type !== 'string' || !options.some(option => (option as { type?: unknown }).type === 'null')) return object;
    const { anyOf: _anyOf, ...rest } = object;
    return { ...rest, ...other, type: [other.type, 'null'], ...(Array.isArray(other.enum) ? { enum: [...other.enum, null] } : {}) };
  };
  return normalize(z.toJSONSchema(schema)) as Record<string, unknown>;
}
```

`server/claude-client.ts`:

```ts
import Anthropic from '@anthropic-ai/sdk';
import type { ApiEffort } from './config.ts';
import { toWireSchema, type StructuredClient } from './api-types.ts';

type Messages = Pick<Anthropic['messages'], 'create'>;
// No server-side model fallback: a model comparison must know which model answered.
export function createClaudeClient(apiKey: string, timeoutMs: number, effort: ApiEffort, messages: Messages = new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 1 }).messages): StructuredClient {
  return async ({ model, system, input, schema, signal }) => {
    const response = await messages.create({ model, max_tokens: 16000, system, messages: [{ role: 'user', content: JSON.stringify(input) }],
      output_config: { effort, format: { type: 'json_schema', schema: toWireSchema(schema, 'claude') } } }, { signal });
    if (response.stop_reason !== 'end_turn') throw new Error(`Claude stopped with ${response.stop_reason}.`);
    const text = response.content.find(block => block.type === 'text');
    if (!text || text.type !== 'text') throw new Error('Claude returned no text.');
    return { json: JSON.parse(text.text), inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
  };
}
```

`server/gemini-client.ts`:

```ts
import { GoogleGenAI } from '@google/genai';
import type { ApiEffort } from './config.ts';
import { toWireSchema, type StructuredClient } from './api-types.ts';

type Interactions = Pick<GoogleGenAI['interactions'], 'create'>;
export function createGeminiClient(apiKey: string, timeoutMs: number, effort: ApiEffort, interactions: Interactions = new GoogleGenAI({ apiKey }).interactions): StructuredClient {
  return async ({ model, system, input, schema, signal }) => {
    const interaction = await interactions.create({ model, system_instruction: system, input: JSON.stringify(input), store: false,
      response_format: { type: 'text', mime_type: 'application/json', schema: toWireSchema(schema, 'gemini') }, generation_config: { thinking_level: effort } },
      { timeout_ms: timeoutMs, retries: { strategy: 'attempt-count-backoff', maxRetries: 1 }, fetch_options: { signal } });
    if (interaction.status !== 'completed' || !interaction.output_text) throw new Error(`Gemini returned ${interaction.status}.`);
    const usage = interaction.usage;
    return { json: JSON.parse(interaction.output_text), inputTokens: usage?.total_input_tokens ?? 0, outputTokens: (usage?.total_output_tokens ?? 0) + (usage?.total_thought_tokens ?? 0) };
  };
}
```

`server/api-structured.ts`:

```ts
import { apiVendor, type Config } from './config.ts';
import { createClaudeClient } from './claude-client.ts';
import { createGeminiClient } from './gemini-client.ts';
import type { ApiVendor, StructuredClient } from './api-types.ts';

export function createStructuredClient(config: Config, clients: Partial<Record<ApiVendor, StructuredClient>> = {}): StructuredClient {
  const gemini = clients.gemini ?? (config.geminiApiKey ? createGeminiClient(config.geminiApiKey, config.apiTimeoutMs, config.apiEffort) : undefined);
  const claude = clients.claude ?? (config.anthropicApiKey ? createClaudeClient(config.anthropicApiKey, config.apiTimeoutMs, config.apiEffort) : undefined);
  return request => {
    const vendor = apiVendor(request.model), client = vendor === 'gemini' ? gemini : vendor === 'claude' ? claude : undefined;
    return client ? client(request) : Promise.reject(new Error(`No API client for ${request.model}.`));
  };
}
```

- [ ] **Step 5: 통과와 타입 확인**

Run: `npm.cmd test -- server/api-types.test.ts server/claude-client.test.ts server/gemini-client.test.ts server/api-structured.test.ts` 그리고 `npm.cmd run typecheck`
Expected: PASS. 타입 검사가 SDK 매개변수 이름을 거절하면 오류 메시지에 나온 설치 SDK의 실제 이름으로 맞추고, 같은 변경을 테스트 기대값에도 반영한다. 동작(형식 강제, 사고 수준, 재시도 1회, 저장 끔, 취소 신호)은 바꾸지 않는다.

- [ ] **Step 6: 커밋**

```bash
git add package.json package-lock.json server/api-types.ts server/api-types.test.ts server/claude-client.ts server/claude-client.test.ts server/gemini-client.ts server/gemini-client.test.ts server/api-structured.ts server/api-structured.test.ts
git commit -m "feat: add Gemini and Claude structured output clients" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: API 서비스 조립과 서버 연결

**Files:**
- Create: `server/api-services.ts`, `server/api-services.test.ts`
- Create: `server/provider-status.test.ts`
- Modify: `server/local-status.ts` (끝에 `getProviderStatus` 추가)
- Modify: `server/providers.ts`
- Modify: `server/app.ts:73` (세션의 `textModel`)
- Modify: `server/app.test.ts` (세션 테스트 1개 추가)

**Interfaces:**
- Consumes: Task 3의 요청 생성·변환 함수와 형식, Task 4의 `createStructuredClient`, `StructuredClient`, `ApiUsage`, Task 1의 `activeTextModel`.
- Produces:
  - `createApiServices(config: Config, options?: { client?: StructuredClient; onUsage?: (usage: ApiUsage) => void }): { generate; generateOwner; generateBrief; generateShelter }`. `createOllamaServices`와 같은 반환 형태다.
  - `getProviderStatus(config: Config): Promise<{ configured: boolean; sttReady: boolean; liveConsultation; statusMessage: string }>`

- [ ] **Step 1: 실패 테스트 작성**

`server/api-services.test.ts`:

```ts
// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { readConfig } from './config.ts';
import { createApiServices } from './api-services.ts';
import type { StructuredClient, StructuredRequest } from './api-types.ts';
import { classifyShelterQuote, memoSentences } from '../src/domain/shelter.ts';
import { BriefInputSchema } from './brief-service.ts';

const config = () => readConfig({ AI_ENABLED: 'true', AI_PROVIDER: 'api', GEMINI_API_KEY: 'test-g', ANTHROPIC_API_KEY: 'test-a' });
const fixture = async (file: string, id: string) => (JSON.parse(await readFile(new URL(`../fixtures/${file}.json`, import.meta.url), 'utf8')) as { id: string }[]).find(item => item.id === id) as any;

it('builds a note draft from chosen IDs with exact quotes, masked input and usage', async () => {
  const usage = vi.fn(); let request: StructuredRequest | undefined;
  const client: StructuredClient = async value => { request = value; return { json: { items: [{ sentence: 'S2', category: 'observation' }], safetyFlags: [], methodReview: false }, inputTokens: 30, outputTokens: 8 }; };
  const result = await createApiServices(config(), { client, onUsage: usage }).generate('연락처 010-1234-5678. 앉아를 관찰했습니다.', 'trainer_summary_text');
  expect(request?.model).toBe('gemini-3.8-flash');
  expect(JSON.stringify(request?.input)).not.toContain('010-1234-5678');
  expect(result).toMatchObject({ fallbackUsed: false, model: 'gemini-3.8-flash' });
  expect(result.draft.items).toEqual([expect.objectContaining({ category: 'observation', sourceQuote: '앉아를 관찰했습니다.', text: '앉아를 관찰했습니다.' })]);
  expect(usage).toHaveBeenCalledWith(expect.objectContaining({ model: 'gemini-3.8-flash', inputTokens: 30, outputTokens: 8 }));
});
it('retries with the validation message and falls back when IDs stay invalid', async () => {
  const systems: string[] = [];
  const client: StructuredClient = async value => { systems.push(value.system); return { json: { items: [{ sentence: 'S9', category: 'task' }], safetyFlags: [], methodReview: false }, inputTokens: 1, outputTokens: 1 }; };
  const result = await createApiServices(config(), { client }).generate('앉아를 관찰했습니다.', 'trainer_summary_text');
  expect(systems).toHaveLength(2); expect(systems[1]).toContain('검증 재시도:');
  expect(result.fallbackUsed).toBe(true);
});
it('falls back without retrying when the vendor call fails', async () => {
  const models: string[] = [];
  const client: StructuredClient = async value => { models.push(value.model); throw new Error('offline'); };
  const owner = await createApiServices(config(), { client }).generateOwner({ text: '초코 산책 30분 하고 응가함', pets: [{ id: 'p1', name: '초코', nicknames: [] }], now: '2026-09-30T14:00:00+09:00', timeZone: 'Asia/Seoul', sourceKind: 'nl_log_text' });
  expect(owner.fallbackUsed).toBe(true); expect(models).toEqual(['claude-haiku-5-5']);
});
it('accepts an owner event chosen by sentence range', async () => {
  const item = await fixture('owner-logs', 'multi-events');
  const { sourceQuote: _quote, ...event } = item.extraction.events[0];
  const client: StructuredClient = async () => ({ json: { events: [{ ...event, fromSentence: 'S1', toSentence: 'S1' }], safetyFlags: [], clarification: null }, inputTokens: 1, outputTokens: 1 });
  const result = await createApiServices(config(), { client }).generateOwner(item.input);
  expect(result.fallbackUsed).toBe(false);
  expect(result.draft.events[0].sourceQuote).toBe(item.input.text);
});
it('maps shelter sentence IDs to the original memos', async () => {
  const item = await fixture('shelter-profiles', 'one-memo');
  const observations = item.input.memos.flatMap((memo: { text: string }, memoIndex: number) => memoSentences(memo.text).map((sentence, index) => ({ sentence: `M${memoIndex + 1}-S${index + 1}`, ...classifyShelterQuote(sentence) })));
  const client: StructuredClient = async () => ({ json: { observations, safetyFlags: [] }, inputTokens: 1, outputTokens: 1 });
  const result = await createApiServices(config(), { client }).generateShelter(item.input);
  expect(result.fallbackUsed).toBe(false);
  expect(result.draft.observations.map(observation => observation.memoId)).toEqual(observations.map(() => item.input.memos[0].id));
});
it('sends only computed brief facts to the text model', async () => {
  const item = await fixture('briefs', 'increase'); let request: StructuredRequest | undefined;
  const client: StructuredClient = async value => { request = value; return { json: { summary: [], changes: [], questionsForOwner: [] }, inputTokens: 1, outputTokens: 1 }; };
  const result = await createApiServices(config(), { client }).generateBrief(BriefInputSchema.parse(item.input));
  expect(request?.model).toBe('gemini-3.8-flash');
  expect(request?.input).not.toHaveProperty('records');
  expect(result.model).toBe('gemini-3.8-flash');
});
```

`server/provider-status.test.ts`:

```ts
// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { readConfig } from './config.ts';
import { getProviderStatus } from './local-status.ts';

afterEach(() => vi.unstubAllGlobals());
it('reports API text readiness without requiring Ollama', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
  const status = await getProviderStatus(readConfig({ AI_PROVIDER: 'api', GEMINI_API_KEY: 'test-g', ANTHROPIC_API_KEY: 'test-a', WHISPER_EXECUTABLE: 'missing-whisper.exe' }));
  expect(status).toMatchObject({ configured: true, sttReady: false, statusMessage: '외부 AI 텍스트(gemini-3.8-flash) 준비됨 · 음성 모델과 FFmpeg 설치를 확인해 주세요.' });
});
it('keeps the local status unchanged for the local provider', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
  expect(await getProviderStatus(readConfig({ WHISPER_EXECUTABLE: 'missing-whisper.exe' }))).toMatchObject({ configured: false, statusMessage: 'Ollama를 실행한 뒤 다시 연결해 주세요.' });
});
```

`server/app.test.ts` 끝에 추가한다(파일에 `request`, `createApp`, `readConfig` import가 이미 있다).

```ts
it('reports the API text model in the session without exposing keys', async () => {
  const app = createApp(readConfig({ AI_ENABLED: 'true', AI_PROVIDER: 'api', GEMINI_API_KEY: 'gemini-secret-test-value', ANTHROPIC_API_KEY: 'anthropic-secret-test-value' }), {
    generate: async () => ({}), transcribe: async () => '', status: async () => ({ configured: true, sttReady: true, statusMessage: 'Ready' }) });
  const session = await request(app).get('/api/session').expect(200);
  expect(session.body).toMatchObject({ provider: 'api', textModel: 'gemini-3.8-flash' });
  expect(JSON.stringify(session.body)).not.toContain('secret-test-value');
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm.cmd test -- server/api-services.test.ts server/provider-status.test.ts server/app.test.ts`
Expected: FAIL. `./api-services.ts`가 없고, `getProviderStatus`가 없고, 세션 `textModel`이 `qwen3.5:9b`다.

- [ ] **Step 3: 구현**

`server/api-services.ts`:

```ts
import type { z } from 'zod';
import type { Config } from './config.ts';
import { createNoteService } from './service.ts';
import { createOwnerService } from './owner-service.ts';
import { BRIEF_INSTRUCTIONS, createBriefService } from './brief-service.ts';
import { createShelterService } from './shelter-service.ts';
import { createStructuredClient } from './api-structured.ts';
import type { ApiUsage, StructuredClient } from './api-types.ts';
import { API_NOTE_INSTRUCTIONS, API_OWNER_INSTRUCTIONS, API_SHELTER_INSTRUCTIONS, BriefChoice, NoteChoice, OwnerChoice, ShelterChoice, briefRequest, mapNoteChoice, mapOwnerChoice, mapShelterChoice, noteRequest, ownerRequest, shelterRequest } from './api-mappers.ts';

type Options = { client?: StructuredClient; onUsage?: (usage: ApiUsage) => void };
// Text features only; speech and video keep their local runtimes in this phase.
export function createApiServices(config: Config, { client = createStructuredClient(config), onUsage }: Options = {}) {
  async function call(model: string, system: string, input: unknown, schema: z.ZodType, repair: string, signal?: AbortSignal) {
    const started = Date.now(), deadline = AbortSignal.timeout(config.apiTimeoutMs);
    const result = await client({ model, system: repair ? `${system}\n검증 재시도: ${repair}` : system, input, schema, signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
    onUsage?.({ model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, latencyMs: Date.now() - started });
    return result.json;
  }
  const note = createNoteService({ model: config.apiTextModel, extract: async (text, repair, signal) => {
    const { units, input } = noteRequest(text);
    return mapNoteChoice(units, await call(config.apiTextModel, API_NOTE_INSTRUCTIONS, input, NoteChoice, repair, signal));
  } });
  const owner = createOwnerService({ model: config.apiShortModel, extract: async (masked, repair, signal) => {
    const { units, input } = ownerRequest(masked);
    return mapOwnerChoice(masked.text, units, await call(config.apiShortModel, API_OWNER_INSTRUCTIONS, input, OwnerChoice, repair, signal));
  } });
  const brief = createBriefService({ model: config.apiTextModel, extract: (draft, repair, signal) => call(config.apiTextModel, BRIEF_INSTRUCTIONS, briefRequest(draft), BriefChoice, repair, signal) });
  const shelter = createShelterService({ model: config.apiTextModel, extract: async (masked, repair, signal) => {
    const { memos, input } = shelterRequest(masked);
    return mapShelterChoice(memos, await call(config.apiTextModel, API_SHELTER_INSTRUCTIONS, input, ShelterChoice, repair, signal));
  } });
  return { generate: note.generate, generateOwner: owner.generate, generateBrief: brief.generate, generateShelter: shelter.generate };
}
```

`server/local-status.ts` 끝에 추가한다.

```ts
export async function getProviderStatus(config: Config) {
  const local = await getLocalStatus(config);
  if (config.provider !== 'api') return local;
  // Startup already required the API keys; speech still runs on this PC.
  const text = `외부 AI 텍스트(${config.apiTextModel}) 준비됨`;
  return { ...local, configured: true, statusMessage: local.sttReady ? `${text} · 음성은 이 PC에서 처리` : `${text} · 음성 모델과 FFmpeg 설치를 확인해 주세요.` };
}
```

`server/providers.ts` 전체를 아래로 바꾼다.

```ts
import type { Config } from './config.ts';
import { createOllamaServices } from './ollama.ts';
import { createApiServices } from './api-services.ts';
import { createLocalTranscriber } from './local-speech.ts';
import { getProviderStatus } from './local-status.ts';
import { createLiveSpeech } from './live-speech.ts';

export function createAIServices(config: Config) {
  // Usage logs carry the model, token counts and latency, never record text.
  const text = config.provider === 'api' ? createApiServices(config, { onUsage: usage => console.info(JSON.stringify({ event: 'ai_usage', ...usage })) }) : createOllamaServices(config);
  return { ...text,
    liveSpeech: createLiveSpeech(config),
    status: () => getProviderStatus(config),
    transcribe: createLocalTranscriber({ executable: config.whisperExecutable, modelPath: config.whisperModelPath, ffmpegPath: config.ffmpegPath, timeoutMs: config.sttTimeoutMs }),
  };
}
```

`server/app.ts` 73줄의 `textModel: config.textModel`을 `textModel: activeTextModel(config)`로 바꾸고, `./config.ts` import에 `activeTextModel`을 추가한다. 현재 `import type { Config } from './config.ts';` 형태라면 `import { activeTextModel, type Config } from './config.ts';`로 바꾼다.

- [ ] **Step 4: 통과 확인**

Run: `npm.cmd test -- server/api-services.test.ts server/provider-status.test.ts server/app.test.ts` 그리고 `npm.cmd run typecheck`
Expected: PASS. 보호소 테스트가 `fallbackUsed: true`로 실패하면 `one-memo` 자료의 문장 분리가 마스킹으로 달라진 경우다. 해당 자료에 개인정보 형식(전화번호, 이메일, 주소)이 있는지 확인하고, 없는 다른 자료 ID로 바꾼다.

- [ ] **Step 5: 전체 회귀**

Run: `npm.cmd test -- --maxWorkers=2`
Expected: 기존 450개와 새 테스트 모두 통과.

- [ ] **Step 6: 커밋**

```bash
git add server/api-services.ts server/api-services.test.ts server/provider-status.test.ts server/local-status.ts server/providers.ts server/app.ts server/app.test.ts
git commit -m "feat: run text features through external APIs when selected" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: API 모델 비교 평가 도구

**Files:**
- Create: `server/api-pricing.ts`, `server/api-pricing.test.ts`
- Modify: `scripts/evaluation.ts` (사례별 검사를 공용 함수로 이동)
- Modify: `scripts/eval-local.ts` (공용 함수 사용, 동작 동일)
- Create: `scripts/eval-api.ts`
- Modify: `server/eval-cli.test.ts` (CLI 테스트 2개 추가)
- Modify: `package.json` (`llm:eval:api`)

**Interfaces:**
- Consumes: Task 5의 `createApiServices`, Task 4의 `ApiUsage`, 기존 `generateConsultationNote`.
- Produces: `API_PRICES_CHECKED: string`, `estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number | null`, `featureFiles`, `smokeCases`, `evaluateFixture(file: string, fixture: any, services: TextServices): Promise<{ failures: string[]; result: unknown }>`. 결과 파일은 `test-output/api-<model>-<smoke|all|long>-<effort>.json`.

- [ ] **Step 1: 실패 테스트 작성**

`server/api-pricing.test.ts`:

```ts
// @vitest-environment node
import { expect, it } from 'vitest';
import { API_PRICES_CHECKED, estimateCostUsd } from './api-pricing.ts';

it('estimates cost from per-million-token prices and refuses unknown models', () => {
  expect(API_PRICES_CHECKED).toBe('2026-11-11');
  expect(estimateCostUsd('claude-haiku-5-5', 1_000_000, 1_000_000)).toBeCloseTo(0.6);
  expect(estimateCostUsd('gemini-3.8-flash', 2_000_000, 0)).toBeCloseTo(1.5);
  expect(estimateCostUsd('gpt-6', 1, 1)).toBeNull();
});
```

`server/eval-cli.test.ts` 끝에 추가한다.

```ts
it('explains the API evaluation without calling any model', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ['scripts/eval-api.ts', '--help'], { windowsHide: true, timeout: 10000 });
  expect(stdout).toContain('--model'); expect(stdout).toContain('비용');
});
it('refuses to start an API evaluation without a model', async () => {
  await expect(promisify(execFile)(process.execPath, ['scripts/eval-api.ts'], { windowsHide: true, timeout: 10000 })).rejects.toMatchObject({ stderr: expect.stringContaining('--model을 지정하세요.') });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm.cmd test -- server/api-pricing.test.ts server/eval-cli.test.ts`
Expected: FAIL. 가격 모듈과 `scripts/eval-api.ts`가 없다.

- [ ] **Step 3: 가격 모듈 구현**

`server/api-pricing.ts`:

```ts
// Official USD prices per million tokens, checked 2026-11-11. Gemini 3.8 Flash doubles to 1.50/7.50 from 2027-01-01.
// Haiku 5.5 uses the up-to-100K-token prompt tier; evaluation prompts stay far below it.
export const API_PRICES_CHECKED = '2026-11-11';
export const API_PRICES: Record<string, { input: number; output: number }> = {
  'gemini-3.8-flash': { input: 0.75, output: 3.75 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
};
export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const price = API_PRICES[model];
  return price ? (inputTokens * price.input + outputTokens * price.output) / 1_000_000 : null;
}
```

- [ ] **Step 4: 사례별 검사를 공용 함수로 옮김**

`scripts/evaluation.ts` 맨 위 import에 추가한다.

```ts
import type { createOllamaServices } from '../server/ollama.ts';
import { validateOwnerDraft } from '../src/domain/owner-log.ts';
import { validateShelterDraft } from '../src/domain/shelter.ts';
import { OwnerInputSchema } from '../server/owner-service.ts';
import { BriefInputSchema } from '../server/brief-service.ts';
import { ShelterInputSchema } from '../server/shelter-service.ts';
```

파일 끝에 추가한다. 본문은 `scripts/eval-local.ts` 37~66줄의 `try` 블록을 그대로 옮긴 것이다.

```ts
export type TextServices = Pick<ReturnType<typeof createOllamaServices>, 'generate' | 'generateOwner' | 'generateBrief' | 'generateShelter'>;
export const featureFiles = ['session-notes', 'owner-logs', 'briefs', 'shelter-profiles'] as const;
// Pick a fixed, visible subset; never choose cases based on a model's outputs.
export const smokeCases: Record<string, string[]> = {
  'session-notes': ['N06', 'N09', 'N11', 'N15', 'N23', 'N29'],
  'owner-logs': ['bark-delivery', 'walk', 'ambiguous-pet', 'multi-events'],
  briefs: ['empty', 'increase'],
  'shelter-profiles': ['one-memo', 'contradiction', 'all-cautions', 'sensitive-context'],
};
export async function evaluateFixture(file: string, fixture: any, services: TextServices): Promise<{ failures: string[]; result: unknown }> {
  const failures: string[] = []; let result: unknown;
  try {
    if (file === 'session-notes') {
      const f = Fixture.parse(fixture), r = await services.generate(f.text, 'trainer_summary_text'); result = r;
      failures.push(...evaluateDraft(r.draft, f.expect, r.fallbackUsed));
      if (r.draft.safetyFlags.some(flag => !f.expect.safetyFlags.includes(flag))) failures.push('기대하지 않은 안전 신호');
      if (r.draft.methodReview !== f.expect.methodReview) failures.push('방법 검토 신호 불일치');
    } else if (file === 'owner-logs') {
      const r = await services.generateOwner(OwnerInputSchema.parse(fixture.input)); result = r;
      failures.push(...validateOwnerDraft({ ...r.draft, events: r.draft.events.map(e => ({ ...e, petId: e.petId ?? r.draft.pets[0].id })) }));
      const expected = fixture.expected ?? fixture.expect ?? {};
      for (const key of ['type', 'durationMin', 'petId', 'occurredAt'] as const) if (key in expected && r.draft.events[0]?.[key] !== expected[key]) failures.push(`사건 ${key} 불일치`);
      for (const flag of expected.safetyFlags ?? []) if (!r.draft.safetyFlags.includes(flag)) failures.push(`안전 신호 누락: ${flag}`);
      if (expected.safetyFlags && r.draft.safetyFlags.some(flag => !expected.safetyFlags.includes(flag))) failures.push('기대하지 않은 안전 신호');
      if (r.fallbackUsed) failures.push('수동 대체');
    } else if (file === 'briefs') {
      const r = await services.generateBrief(BriefInputSchema.parse(fixture.input)); result = r;
      if (r.fallbackUsed) failures.push('코드 집계로 대체');
      const expected = fixture.expect ?? {};
      if ('days' in expected && r.draft.period.daysWithRecords !== expected.days) failures.push('기록 일수 불일치');
      if ('walk' in expected && r.draft.facts.find(f => f.id === 'count:walk')?.value !== expected.walk) failures.push('산책 횟수 불일치');
      if ([...r.draft.summary, ...r.draft.changes, ...r.draft.questionsForOwner].some(line => !line.refs.length || line.refs.some(id => !r.draft.facts.some(f => f.id === id)))) failures.push('잘못된 사실 근거');
    } else {
      const r = await services.generateShelter(ShelterInputSchema.parse(fixture.input)); result = r;
      failures.push(...validateShelterDraft(r.draft));
      const expected = fixture.expect ?? {};
      for (const key of ['people', 'dogs', 'cats'] as const) if (key in expected && r.draft.sociability[key] !== expected[key]) failures.push(`사회성 ${key} 불일치`);
      if ('cautions' in expected && r.draft.cautions.length !== expected.cautions) failures.push('주의 관찰 수 불일치');
      if (expected.safetyFlag && !r.draft.safetyFlags.includes(expected.safetyFlag)) failures.push('안전 신호 누락');
      if (expected.introExclude && r.draft.adopterIntro.text.includes(expected.introExclude)) failures.push('금지된 소개 추론');
      if (r.fallbackUsed) failures.push('원문 규칙으로 대체');
    }
  } catch (error) { failures.push(error instanceof Error ? error.message : '요청 실패'); }
  return { failures, result };
}
```

`scripts/eval-local.ts`를 아래로 바꾼다. 출력 형식과 파일 이름은 기존과 같다.

```ts
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
```

- [ ] **Step 5: API 평가 스크립트 구현**

`scripts/eval-api.ts`:

```ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readConfig } from '../server/config.ts';
import { createApiServices } from '../server/api-services.ts';
import { API_PRICES_CHECKED, estimateCostUsd } from '../server/api-pricing.ts';
import type { ApiUsage } from '../server/api-types.ts';
import { generateConsultationNote } from '../server/consultation-notes.ts';
import type { ConsultationSession } from '../src/domain/consultation.ts';
import { evaluateFixture, featureFiles, smokeCases } from './evaluation.ts';

const args = process.argv.slice(2); let model = ''; let all = false; let long = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--all') all = true;
  else if (args[i] === '--long') long = true;
  else if (args[i] === '--model' && args[i + 1] && !args[i + 1].startsWith('--')) model = args[++i];
  else if (args[i] === '--help') { console.info('npm run llm:eval:api -- --model <gemini-3.8-flash|claude-sonnet-5-5|claude-haiku-5-5> [--all] [--long]\n기본 16개 사례 / --all 82개 / --long 가상 60분 전사 1건. 외부 API를 호출해 비용이 듭니다. 가상 자료만 사용합니다.'); process.exit(0); }
  else throw new Error(`지원하지 않는 인자: ${args[i]}`);
}
if (!model) throw new Error('--model을 지정하세요.');
// One model serves every feature so each result is attributable to it.
const config = readConfig({ ...process.env, AI_PROVIDER: 'api', API_TEXT_MODEL: model, API_SHORT_MODEL: model });
let usage: ApiUsage[] = [];
const services = createApiServices(config, { onUsage: entry => usage.push(entry) });
const totals = () => {
  const inputTokens = usage.reduce((n, u) => n + u.inputTokens, 0), outputTokens = usage.reduce((n, u) => n + u.outputTokens, 0);
  return { calls: usage.length, inputTokens, outputTokens, costUsd: estimateCostUsd(model, inputTokens, outputTokens) };
};
type Report = { feature: string; passed?: boolean; inputTokens: number; outputTokens: number; costUsd: number | null; latencyMs: number } & Record<string, unknown>;
const reports: Report[] = [];
const output = `test-output/api-${model}-${long ? 'long' : all ? 'all' : 'smoke'}-${config.apiEffort}.json`;
const save = async () => {
  await mkdir('test-output', { recursive: true });
  await writeFile(output, JSON.stringify({ model, effort: config.apiEffort, pricesChecked: API_PRICES_CHECKED, createdAt: new Date().toISOString(), automaticChecksOnly: true, reports }, null, 2));
};
if (long) {
  const notes = JSON.parse(await readFile(new URL('../fixtures/session-notes.json', import.meta.url), 'utf8')) as { text: string }[];
  // About 19,000 characters: the measured size of a 60-minute Korean consultation transcript.
  const texts = Array.from({ length: 21 }, () => notes.map(note => note.text)).flat();
  const session = { id: 'long', metadata: { petName: '시연초코', trainerName: '시연 훈련사', sessionDate: '2026-11-11' }, createdAt: new Date().toISOString(), state: 'ready', durationMs: texts.length * 5000,
    segments: texts.map((text, sequence) => ({ id: `s${sequence}`, sequence, startMs: sequence * 5000, endMs: (sequence + 1) * 5000, text, originalText: text, state: 'complete' })), bookmarks: [], recordingChunkCount: 0, errors: [] } as unknown as ConsultationSession;
  const started = Date.now(); let error = '', fallbackUsed: boolean | null = null;
  try { fallbackUsed = (await generateConsultationNote(session, services.generate)).fallbackUsed; } catch (cause) { error = cause instanceof Error ? cause.message : '요청 실패'; }
  const latencyMs = Date.now() - started;
  reports.push({ feature: 'long-transcript', characters: texts.join('\n').length, latencyMs, fallbackUsed, error, ...totals() });
  await save();
  console.info(`${model} 긴 전사: ${(latencyMs / 1000).toFixed(1)}s ${JSON.stringify(totals())}${error ? ` 오류: ${error}` : ''}`);
} else {
  for (const file of featureFiles) {
    const fixtures = JSON.parse(await readFile(new URL(`../fixtures/${file}.json`, import.meta.url), 'utf8'));
    const cases = all ? fixtures : fixtures.filter((f: { id: string }) => smokeCases[file].includes(f.id));
    if (!all && cases.length !== smokeCases[file].length) throw new Error(`평가 자료가 누락되었습니다: ${file}`);
    for (const fixture of cases) {
      usage = []; const started = Date.now();
      const { failures, result } = await evaluateFixture(file, fixture, services);
      const latencyMs = Date.now() - started, cost = totals();
      reports.push({ feature: file, id: fixture.id, passed: !failures.length, failures, latencyMs, ...cost, result });
      console.info(`${file}/${fixture.id}: ${failures.length ? 'FAIL' : 'PASS'} ${(latencyMs / 1000).toFixed(1)}s $${(cost.costUsd ?? 0).toFixed(4)} ${failures.join(' / ')}`);
      await save();
    }
  }
  const sum = (key: 'inputTokens' | 'outputTokens') => reports.reduce((n, r) => n + r[key], 0);
  const cost = reports.reduce((n, r) => n + (r.costUsd ?? 0), 0);
  console.info(`${model}: ${reports.filter(r => r.passed).length}/${reports.length} 자동 조건 통과 · 입력 ${sum('inputTokens')} · 출력 ${sum('outputTokens')} 토큰 · 약 $${cost.toFixed(3)} (가격 ${API_PRICES_CHECKED} 기준)`);
  if (reports.some(r => !r.passed)) process.exitCode = 1;
}
```

`package.json`의 `scripts`에 `llm:eval:local` 다음 줄로 추가한다.

```json
    "llm:eval:api": "node --env-file-if-exists=.env scripts/eval-api.ts",
```

- [ ] **Step 6: 통과와 회귀 확인**

Run: `npm.cmd test -- server/api-pricing.test.ts server/eval-cli.test.ts` 그리고 `npm.cmd run typecheck`
Expected: PASS.

로컬 평가 출력이 그대로인지 확인한다. Ollama가 켜져 있으면 실행하고, 꺼져 있으면 건너뛰고 보고에 적는다.

Run: `npm.cmd run llm:eval:local -- --help`
Expected: 기존과 같은 도움말.

- [ ] **Step 7: 커밋**

```bash
git add server/api-pricing.ts server/api-pricing.test.ts scripts/evaluation.ts scripts/eval-local.ts scripts/eval-api.ts server/eval-cli.test.ts package.json
git commit -m "feat: compare API text models on the shared evaluation fixtures" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 실제 평가와 모델 확정 (사용자 참여 필수)

이 작업은 하위 에이전트에 맡기지 않는다. 키 입력, 비용 승인, 최종 선택이 사용자 몫이다.

**Files:**
- Create: `docs/llm/api-comparison.md`
- Modify(선택 결과에 따라): `server/config.ts`, `server/config.test.ts`, `.env.example`의 기본 모델

- [ ] **Step 1: 키 준비 확인**

사용자에게 Google AI Studio(유료 등급)와 Anthropic Console에서 키를 발급해 `.env`에 `GEMINI_API_KEY=`, `ANTHROPIC_API_KEY=` 값으로 직접 넣도록 요청한다. 키를 대화창에 붙여 넣지 않게 한다. 콘솔마다 월 사용 한도를 걸도록 안내한다.

Run (값을 출력하지 않고 존재만 확인):
```bash
node --env-file=.env -e "for (const k of ['GEMINI_API_KEY','ANTHROPIC_API_KEY']) console.log(k + ': ' + (process.env[k] ? 'set' : 'missing'))"
```
Expected: 두 줄 모두 `set`.

- [ ] **Step 2: 비용 승인**

사용자에게 다음을 알리고 승인을 받는다. "3개 모델 × 82개 사례, 긴 전사 3건, 필요 시 재측정 포함 약 $2 이하로 추정함. 가상 자료만 보냄." 승인 전에는 다음 단계를 실행하지 않는다.

- [ ] **Step 3: 모델별 16개 사례 시험 실행**

Run:
```bash
npm.cmd run llm:eval:api -- --model gemini-3.8-flash
npm.cmd run llm:eval:api -- --model claude-sonnet-5-5
npm.cmd run llm:eval:api -- --model claude-haiku-5-5
```
Expected: 사례별 PASS/FAIL과 비용이 출력되고 `test-output/api-<model>-smoke-low.json`이 생긴다. 모든 사례가 같은 HTTP 400(형식 거절)으로 실패하면 출력 형식이 업체에 맞지 않는 것이다. 전체 평가를 멈추고 오류 원문을 사용자에게 보고한다.

- [ ] **Step 4: 전체 82개와 긴 전사**

Run:
```bash
npm.cmd run llm:eval:api -- --model gemini-3.8-flash --all
npm.cmd run llm:eval:api -- --model claude-sonnet-5-5 --all
npm.cmd run llm:eval:api -- --model claude-haiku-5-5 --all
npm.cmd run llm:eval:api -- --model gemini-3.8-flash --long
npm.cmd run llm:eval:api -- --model claude-sonnet-5-5 --long
npm.cmd run llm:eval:api -- --model claude-haiku-5-5 --long
```
Expected: 모델마다 `N/82 자동 조건 통과`와 총비용, 긴 전사의 시간·호출 수·비용이 출력된다.

- [ ] **Step 5: 추론 강도 재측정 (필요한 모델만)**

82개 중 통과가 74개보다 적은 모델만 한 단계 올려 다시 잰다. PowerShell:
```powershell
$env:API_EFFORT = 'medium'; npm.cmd run llm:eval:api -- --model <모델 ID> --all; Remove-Item Env:API_EFFORT
```
Expected: `test-output/api-<model>-all-medium.json`이 생긴다.

- [ ] **Step 6: 결과 집계**

Run:
```bash
node -e "for (const f of process.argv.slice(1)) { const r = require('./' + f); const by = {}; for (const x of r.reports) { by[x.feature] ??= [0, 0]; by[x.feature][1]++; if (x.passed) by[x.feature][0]++; } const s = k => r.reports.reduce((n, x) => n + (x[k] ?? 0), 0); console.log(f, JSON.stringify(by), 'avg', (s('latencyMs') / r.reports.length / 1000).toFixed(1) + 's', 'in', s('inputTokens'), 'out', s('outputTokens'), '\$' + s('costUsd').toFixed(3)); }" test-output/api-*-all-*.json test-output/api-*-long-*.json
```
Expected: 파일마다 기능별 통과 수, 평균 처리 시간, 토큰, 비용 한 줄.

- [ ] **Step 7: 비교 문서 작성**

`docs/llm/api-comparison.md`를 아래 구조로 쓰고, 표의 값은 Step 6 출력에서 그대로 옮긴다. 추정이나 반올림 외의 가공을 하지 않는다.

```markdown
# 외부 API 텍스트 모델 비교 · <측정일>

## 조건

- 사례: 기존 평가 자료 82개(상담일지 30, 보호자 기록·브리핑·보호소 52). 자동 합격 조건은 로컬 평가와 같다. 가상 자료만 사용했다.
- 방식: 문장 번호 선택 → 코드가 원문 복사 → 기존 서비스 검증. 한 모델이 네 기능을 모두 처리했다.
- 가격: 2026-11-11 공식 가격표 기준(100만 토큰당 입력/출력). Gemini 3.8 Flash $0.75/$3.75(2027-01부터 $1.50/$7.50), Claude Sonnet 5.5 $2/$10, Claude Haiku 5.5 $0.10/$0.50.
- 기준선: 로컬 qwen3.5:9b 74/82(이전 측정, [로컬 검증](local-verification.md)).

## 결과 (82개)

| 모델 | 추론 강도 | 통과 | 상담일지 /30 | 보호자 | 브리핑 | 보호소 | 평균 처리 시간 | 입력 토큰 | 출력 토큰 | 비용 |
|---|---|---|---|---|---|---|---|---|---|---|

## 긴 전사 (가상 60분, 약 19,000자)

| 모델 | 호출 수 | 처리 시간 | 비용 | 대체 발생 |
|---|---|---|---|---|

## 결정

결정 규칙(설계 문서): ① 합격률 최고 ② 차이 2건 이하면 더 싼 모델 ③ 처리 시간 2배 이상 차이는 함께 보고. 기능별 선택 가능.

- 상담일지·브리핑·보호소: <모델과 근거>
- 보호자 기록: <모델과 근거>
- 사용자 확정: <날짜, 사용자 결정>

## 실패 사례와 한계

<모델별 실패 사례 ID와 실패 이유를 결과 JSON의 failures에서 옮긴다. 자동 조건은 의미 품질을 보장하지 않는다. 실제 상담 자료는 쓰지 않았다.>
```

- [ ] **Step 8: 사용자 확정과 기본값 반영**

결정 규칙을 적용한 결과와 근거를 사용자에게 보여주고 확정을 받는다. 확정된 모델이 현재 기본값(`gemini-3.8-flash`, `claude-haiku-5-5`)과 다르면 세 곳을 함께 바꾼다.
- `server/config.ts`의 `env.API_TEXT_MODEL || ...`, `env.API_SHORT_MODEL || ...`
- `.env.example`의 두 줄
- `server/config.test.ts`의 기본값 기대값

Run: `npm.cmd test -- server/config.test.ts`
Expected: PASS.

- [ ] **Step 9: 커밋**

```bash
git add docs/llm/api-comparison.md server/config.ts server/config.test.ts .env.example
git commit -m "docs: record API text model comparison and selection" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: 화면 문구, 연결 상태, 점검 도구

**Files:**
- Create: `src/ai-copy.ts`, `src/ai-copy.test.ts`, `src/components/ConnectionPanel.test.tsx`
- Modify: `src/api.ts:10`, `src/App.tsx:141,166,277-280,310`, `src/components/SourceInput.tsx:6-17,78`, `src/components/OwnerWorkspace.tsx:10,17,108,115`, `src/components/BriefWorkspace.tsx:13,16,69,109`, `src/components/ShelterWorkspace.tsx:10,16,70,75`, `src/components/NoteReview.tsx:40`, `src/components/ConsultationWorkspace.tsx:33,114`, `src/components/ConnectionPanel.tsx:20`
- Modify: `src/components/SourceInput.test.tsx` (테스트 1개 추가)
- Modify: `scripts/beta-check.ts`, `scripts/check-local.ts`, `server/beta-check.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: 세션 응답의 `provider: 'ollama' | 'api'`(Task 5까지 서버가 이미 보냄), `draft.generation?.model`, Task 1의 `activeTextModel`, Task 5의 `getProviderStatus`.
- Produces: `type AiProvider = 'ollama' | 'api'`, `isExternalModel(model?: string): boolean`, `processingPhrase(provider?: AiProvider): string`, `aiDraftLabel(model?: string): string`.

로컬 설정의 문구는 지금과 글자 하나까지 같아야 한다. 기존 테스트가 이 문구를 확인한다.

- [ ] **Step 1: 실패 테스트 작성**

`src/ai-copy.test.ts`:

```ts
import { expect, it } from 'vitest';
import { aiDraftLabel, isExternalModel, processingPhrase } from './ai-copy';

it('describes where text is processed and labels drafts by the model that made them', () => {
  expect(processingPhrase()).toBe('이 PC의 로컬 AI 서버에서 처리');
  expect(processingPhrase('api')).toBe('외부 AI(Google·Anthropic)로 전송해 처리');
  expect(isExternalModel('gemini-3.8-flash')).toBe(true); expect(isExternalModel('claude-haiku-5-5')).toBe(true); expect(isExternalModel('qwen3.5:9b')).toBe(false);
  expect(aiDraftLabel('claude-sonnet-5-5')).toBe('외부 AI 초안'); expect(aiDraftLabel(undefined)).toBe('로컬 AI 초안');
});
```

`src/components/ConnectionPanel.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import ConnectionPanel from './ConnectionPanel';

const session = { authenticated: true, requirePassword: false, aiEnabled: true, configured: true, textModel: 'gemini-3.8-flash', sttModel: 'ggml-medium-q5_0.bin (CPU)' };
test.each([['api', '외부 AI 연결됨'], ['ollama', '로컬 AI 연결됨']] as const)('shows the %s connection label', (provider, label) => {
  render(<ConnectionPanel session={{ ...session, provider }} loading={false} error="" onRetry={vi.fn()} onLogin={vi.fn()} onLogout={vi.fn()} localDemo={false} onDemo={vi.fn()} />);
  expect(screen.getByText(label)).toBeInTheDocument();
});
```

`src/components/SourceInput.test.tsx` 끝에 추가한다.

```tsx
test('asks consent for external text processing in API mode while speech stays local', () => {
  render(<SourceInput aiReady provider="api" petName="초코" text="" onText={vi.fn()} />);
  expect(screen.getByRole('checkbox', { name: '음성은 이 PC의 로컬 AI 서버에서, 입력한 내용은 외부 AI(Google·Anthropic)로 전송해 처리하는 데 동의합니다.' })).toBeInTheDocument();
});
```

`server/beta-check.test.ts` 6줄의 모의 객체를 `getProviderStatus`로 바꾸고, 파일 끝에 테스트를 추가한다.

```ts
vi.mock('../server/local-status.ts', () => ({ getProviderStatus: vi.fn(async () => ({ configured: true, sttReady: true, statusMessage: 'Ready' })) }));
```

```ts
it('accepts an API-mode server whose session reports the API text model', async () => {
  const api = readConfig({ AI_ENABLED: 'true', AI_PROVIDER: 'api', GEMINI_API_KEY: 'test-g', ANTHROPIC_API_KEY: 'test-a', FEATURE_OWNER_LOG_ENABLED: 'true', FEATURE_BRIEF_ENABLED: 'true', FEATURE_SHELTER_ENABLED: 'true' });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...session, provider: 'api', textModel: 'gemini-3.8-flash' })));
  const result = await checkBeta(api);
  expect(result[0]).toBe('모델: gemini-3.8-flash');
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm.cmd test -- src/ai-copy.test.ts src/components/ConnectionPanel.test.tsx src/components/SourceInput.test.tsx server/beta-check.test.ts`
Expected: FAIL. `./ai-copy` 모듈이 없고, `provider` 속성을 쓰지 않으며, `beta-check`가 `getLocalStatus`를 찾는다.

- [ ] **Step 3: 공용 문구 구현**

`src/ai-copy.ts`:

```ts
export type AiProvider = 'ollama' | 'api';
// Saved drafts keep the model that produced them, so labels follow the draft rather than the current setting.
export const isExternalModel = (model?: string) => /^(gemini|claude)-/.test(model ?? '');
export const processingPhrase = (provider?: AiProvider) => provider === 'api' ? '외부 AI(Google·Anthropic)로 전송해 처리' : '이 PC의 로컬 AI 서버에서 처리';
export const aiDraftLabel = (model?: string) => isExternalModel(model) ? '외부 AI 초안' : '로컬 AI 초안';
```

- [ ] **Step 4: 화면 반영**

`src/api.ts` 10줄: `provider?: 'ollama';` → `provider?: 'ollama' | 'api';`

`src/App.tsx`:
- import 추가: `import type { AiProvider } from './ai-copy';`
- 63줄 `const aiReady = ...` 다음에 추가: `const provider: AiProvider | undefined = session?.provider;`
- 141줄과 166줄의 `setError('로컬 AI 처리에 동의해 주세요.')` → `setError(provider === 'api' ? '외부 AI 처리에 동의해 주세요.' : '로컬 AI 처리에 동의해 주세요.')`
- 277~280줄의 작업 공간에 `provider={provider}`를 넘긴다:
  ```tsx
        {workspace === 'ownerLog' && <OwnerWorkspace aiReady={aiReady} sttReady={sttReady} provider={provider} />}
        {workspace === 'brief' && <BriefWorkspace aiReady={aiReady} provider={provider} />}
        {workspace === 'shelter' && <ShelterWorkspace aiReady={aiReady} serverAvailable={!publicDemo && !localDemo} provider={provider} />}
        {workspace === 'consultation' && <ConsultationWorkspace ready={!!session?.liveConsultation?.ready} model={session?.liveConsultation?.model ?? ''} provider={provider} onBusyChange={setConsultationBusy} />}
  ```
- 310줄의 `음성·텍스트를 이 PC의 로컬 AI 서버에서 처리하는 데 동의합니다.` → `{provider === 'api' ? '음성은 이 PC의 로컬 AI 서버에서, 텍스트는 외부 AI(Google·Anthropic)로 전송해 처리하는 데 동의합니다.' : '음성·텍스트를 이 PC의 로컬 AI 서버에서 처리하는 데 동의합니다.'}`

`src/components/SourceInput.tsx`:
- import 추가: `import type { AiProvider } from '../ai-copy';`
- `Props`에 `provider?: AiProvider;`를 추가하고, 함수 인자에 `provider`를 추가한다: `export default function SourceInput({ aiReady, sttReady = true, petName, text, onText, onConsentChange, onReadyChange, textAreaRef, provider }: Props) {`
- 78줄의 `입력한 내용과 음성을 이 PC의 로컬 AI 서버에서 처리하는 데 동의합니다.` → `{provider === 'api' ? '음성은 이 PC의 로컬 AI 서버에서, 입력한 내용은 외부 AI(Google·Anthropic)로 전송해 처리하는 데 동의합니다.' : '입력한 내용과 음성을 이 PC의 로컬 AI 서버에서 처리하는 데 동의합니다.'}`

`src/components/OwnerWorkspace.tsx`:
- import 추가: `import { aiDraftLabel, type AiProvider } from '../ai-copy';`
- 10줄: `type Props = { aiReady: boolean; sttReady?: boolean; provider?: AiProvider };`
- 17줄: `export default function OwnerWorkspace({ aiReady, sttReady = true, provider }: Props) {`
- 108줄의 `<SourceInput key={sourceKey} aiReady={aiReady}` → `<SourceInput key={sourceKey} provider={provider} aiReady={aiReady}`
- 115줄의 `draft.mode === 'ollama' ? '로컬 AI 초안'` → `draft.mode === 'ollama' ? aiDraftLabel(draft.generation?.model)`

`src/components/BriefWorkspace.tsx`:
- import 추가: `import { isExternalModel, processingPhrase, type AiProvider } from '../ai-copy';`
- 13줄: `type Props = { aiReady: boolean; provider?: AiProvider };`
- 16줄: `export default function BriefWorkspace({ aiReady, provider }: Props) {`
- 69줄의 `'로컬 AI가 근거 우선순위를 선택한 브리핑입니다.'` → `` `${isExternalModel(result.model) ? '외부 AI' : '로컬 AI'}가 근거 우선순위를 선택한 브리핑입니다.` ``
- 109줄의 `선택한 기록을 이 PC의 로컬 AI 서버에서 처리하는 데 동의합니다.` → `선택한 기록을 {processingPhrase(provider)}하는 데 동의합니다.`

`src/components/ShelterWorkspace.tsx`:
- import 추가: `import { aiDraftLabel, processingPhrase, type AiProvider } from '../ai-copy';`
- 10줄: `type Props = { aiReady: boolean; serverAvailable?: boolean; provider?: AiProvider };`
- 16줄: `export default function ShelterWorkspace({ aiReady, serverAvailable = false, provider }: Props) {`
- 70줄의 `메모를 이 PC의 로컬 AI 서버에서 처리하는 데 동의합니다.` → `메모를 {processingPhrase(provider)}하는 데 동의합니다.`
- 75줄의 `draft.mode === 'ollama' ? '로컬 AI 초안'` → `draft.mode === 'ollama' ? aiDraftLabel(draft.generation?.model)`

`src/components/NoteReview.tsx`:
- import 추가: `import { aiDraftLabel } from '../ai-copy';`
- 40줄의 `draft.mode === 'ollama' ? '로컬 AI 초안'` → `draft.mode === 'ollama' ? aiDraftLabel(draft.generation?.model)`

`src/components/ConsultationWorkspace.tsx`:
- import 추가: `import type { AiProvider } from '../ai-copy';`
- 33줄: `export default function ConsultationWorkspace({ ready, model, provider, onBusyChange }: { ready: boolean; model: string; provider?: AiProvider; onBusyChange?: (value: boolean) => void }) {`
- 114줄의 `상담 참여자 동의를 받았으며 녹화·음성·장면을 이 PC의 로컬 AI 서버에서 처리하는 데 동의합니다.` → `{provider === 'api' ? '상담 참여자 동의를 받았으며 녹화·음성·장면은 이 PC의 로컬 AI 서버에서, 일지 작성용 전사 텍스트는 외부 AI(Google·Anthropic)로 전송해 처리하는 데 동의합니다.' : '상담 참여자 동의를 받았으며 녹화·음성·장면을 이 PC의 로컬 AI 서버에서 처리하는 데 동의합니다.'}`

`src/components/ConnectionPanel.tsx` 20줄의 `session?.aiEnabled && session.configured ? '로컬 AI 연결됨'` → `session?.aiEnabled && session.configured ? (session.provider === 'api' ? '외부 AI 연결됨' : '로컬 AI 연결됨')`

- [ ] **Step 5: 점검 도구 반영**

`scripts/beta-check.ts`:
- import를 바꾼다:
  ```ts
  import { activeTextModel, readConfig, type Config } from '../server/config.ts';
  import { getProviderStatus } from '../server/local-status.ts';
  ```
- `const status = await getLocalStatus(config);` → `const status = await getProviderStatus(config);`
- `const lines = [`모델: ${config.textModel}`, 'Ollama·Whisper·FFmpeg 준비 완료'];` →
  ```ts
  const lines = [`모델: ${activeTextModel(config)}`, config.provider === 'api' ? '외부 AI 텍스트·이 PC의 Whisper·FFmpeg 준비 완료' : 'Ollama·Whisper·FFmpeg 준비 완료'];
  ```
- `if (body.textModel !== config.textModel)` → `if (body.textModel !== activeTextModel(config))`
- `body.provider !== 'ollama'` → `body.provider !== config.provider`

`scripts/check-local.ts` 전체를 바꾼다.

```ts
import { spawnSync } from 'node:child_process';
import { activeTextModel, readConfig } from '../server/config.ts';
import { getProviderStatus } from '../server/local-status.ts';

const config = readConfig();
const status = await getProviderStatus(config);
console.info(`텍스트 모델: ${activeTextModel(config)}\n${status.statusMessage}`);
console.info(`음성 모델 파일: ${status.sttReady ? '준비됨' : '설치 필요'}`);
let ready = status.configured && status.sttReady;
for (const [label, executable] of [['FFmpeg', config.ffmpegPath], ['ffprobe', config.ffprobePath]]) {
  const result = spawnSync(executable, ['-version'], { windowsHide: true, timeout: 5000, stdio: 'ignore' });
  const ok = result.status === 0; ready &&= ok;
  console.info(`${label}: ${ok ? '준비됨' : '실행 파일을 확인하세요'}`);
}
console.info(`실제 추출 품질: ${config.provider === 'api' ? 'npm run llm:eval:api -- --model <모델 ID> (비용 발생)' : 'npm run llm:eval:local'} / 화면: npm run dev:local`);
if (!ready) process.exitCode = 1;
```

- [ ] **Step 6: README 반영**

`README.md`의 `## 실행 범위` 절 끝(`[실행·배포 범위](docs/testing/deployment.md) · [기능별 테스트](docs/testing/workspace-testing.md)` 줄 다음)에 추가한다.

````markdown
### 외부 API 모드 (시험 중)

텍스트 기능은 `.env`의 `AI_PROVIDER=api`로 외부 API를 쓸 수 있습니다. 음성 전사와 영상 관찰은 계속 이 PC에서 처리합니다. 개인정보 일부를 가린 텍스트가 Google 또는 Anthropic으로 전송되므로, 동의 절차가 준비되기 전에는 가상 자료만 사용합니다. Gemini는 유료 등급 키를 사용합니다. 무료 등급 입력은 Google 제품 개선에 쓰입니다.

```dotenv
AI_PROVIDER=api
API_TEXT_MODEL=gemini-3.8-flash
API_SHORT_MODEL=claude-haiku-5-5
GEMINI_API_KEY=...
ANTHROPIC_API_KEY=...
```

모델 비교는 `npm.cmd run llm:eval:api -- --model <모델 ID> --all`로 실행하며 비용이 듭니다. [API 모델 비교 결과](docs/llm/api-comparison.md)
````

Task 7에서 기본 모델을 바꿨다면 위 예시의 두 모델 이름도 같게 맞춘다.

- [ ] **Step 7: 통과와 전체 회귀**

Run: `npm.cmd test -- --maxWorkers=2`, `npm.cmd run build`, `npm.cmd run test:e2e`
Expected: 단위 테스트 전체 통과, 빌드 통과(기존 500 kB 경고는 유지). 브라우저 테스트 16개 통과. 녹화 테스트가 간헐적으로 실패하면 한 번 다시 실행하고, 그래도 실패하면 결과를 그대로 보고한다(인계 가이드 3.2의 기존 문제).

- [ ] **Step 8: 커밋**

```bash
git add src/ai-copy.ts src/ai-copy.test.ts src/api.ts src/App.tsx src/components/SourceInput.tsx src/components/SourceInput.test.tsx src/components/OwnerWorkspace.tsx src/components/BriefWorkspace.tsx src/components/ShelterWorkspace.tsx src/components/NoteReview.tsx src/components/ConsultationWorkspace.tsx src/components/ConnectionPanel.tsx src/components/ConnectionPanel.test.tsx scripts/beta-check.ts scripts/check-local.ts server/beta-check.test.ts README.md
git commit -m "feat: show external AI consent and status in API mode" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
