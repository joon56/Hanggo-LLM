# 쌍방향 코칭 0~1단계 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 이 PC의 D 드라이브에서 최고 무료 모델을 측정·선정하고, 보호자와 훈련사가 각자 브라우저에서 역할별로 접속해 실제 WebRTC로 통화하는 기반을 만든다.

**Architecture:** AI 호출을 제공자 인터페이스 뒤로 옮겨 Ollama 의존을 없앤다. 사례·상담·권한은 순수 함수로 두고 Express와 `ws`는 어댑터로 둔다. 통화는 P2P WebRTC이며 서버는 신호와 상태만 중계한다.

**Tech Stack:** TypeScript, React 19, Express 5, `ws`, Zod, Vitest, Playwright(Chrome), llama.cpp `llama-server`, whisper.cpp, transcribe.cpp.

설계 기준: [2026-11-03-two-way-coaching-design.md](../specs/2026-11-03-two-way-coaching-design.md). 2~7단계 계획은 앞 단계 측정 결과를 반영해 별도 문서로 쓴다.

## Global Constraints

- 결제 수단을 쓰지 않는다. 카드 요구가 나오면 멈추고 보고한다.
- 모델·실행기·데이터는 `HANGGO_HOME`(이 PC는 `D:\hanggo`) 아래에 둔다. 저장소는 옮기지 않는다.
- `.env`와 `D:\hanggo\secrets.env`의 값을 읽어 출력하거나 커밋하지 않는다. 검사 스크립트는 통과·실패만 출력한다.
- 모든 다운로드는 URL, 크기, SHA-256을 고정한다.
- 시연·테스트 자료는 가상 이름을 쓴다. 합성 입력 결과를 실제 검증으로 쓰지 않는다.
- 사용자 문구는 개발가이드 §3.6을 따른다. 코드 스타일은 주변 코드를 따른다.
- Node 24, Windows Chrome 기준. 단위 테스트는 `npm.cmd test -- --maxWorkers=2`.
- `feat/two-way-coaching` 브랜치에서 작업한다. Conventional Commits. 커밋 끝에 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`를 붙인다. `.vscode/`는 커밋하지 않는다.

---

## 0단계: 모델과 기반

### Task 1: 브랜치와 CI 준비

**Files:**
- Modify: `.github/workflows/ci.yml:3-7`

**Interfaces:**
- Produces: `feat/**` push에도 `verify`와 `container`가 돈다. `pages`는 기존 조건대로 `main`만 배포한다.

- [ ] **Step 1:** `main`의 Actions 결과를 확인한다. 실패하면 원인을 고쳐 `main`을 통과 상태로 만든다. 알려진 후보는 기본 병렬 실행 때 보호자 테스트 2건의 5초 제한 초과다.
- [ ] **Step 2:** `git switch -c feat/two-way-coaching`
- [ ] **Step 3:** 트리거를 바꾼다.

```yaml
on:
  push:
    branches: [main, 'feat/**']
  pull_request:
  workflow_dispatch:
```

- [ ] **Step 4:** 설계·계획 문서와 함께 커밋하고 push한다. Actions에서 브랜치 실행이 시작되는지 API로 확인한다.

```bash
git add .github/workflows/ci.yml docs/superpowers/specs/2026-11-03-two-way-coaching-design.md docs/superpowers/plans/2026-11-03-two-way-coaching-steps-0-1.md
git commit -m "docs: define two-way coaching goal and first steps"
git push -u origin feat/two-way-coaching
```

### Task 2: `HANGGO_HOME`과 실행 구성 검사

**Files:**
- Modify: `server/config.ts`, `server/config.test.ts`, `server/index.ts`, `.env.example`

**Interfaces:**
- Produces: `readConfig()`에 `home: string`, `profile: 'local' | 'tunnel' | 'cloud'`, `aiProvider: 'local' | 'stub'`, `llmModel: string`, `speechModel: string`를 추가한다. `consultationDirectory`, 실행기, 모델 경로의 기본값은 `path.join(home, ...)`이다. `home` 기본값은 `.hanggo`.
- Produces: `loadLocalSecrets(env)`는 `${HANGGO_HOME}/secrets.env`가 있으면 `process.loadEnvFile`로 읽는다. 없으면 아무것도 하지 않는다.

- [ ] **Step 1: 실패하는 테스트를 쓴다.**

```ts
it('requires a long password outside local profile', () => {
  expect(() => readConfig({ HANGGO_PROFILE: 'tunnel' })).toThrow(/APP_ACCESS_PASSWORD/);
  expect(() => readConfig({ HANGGO_PROFILE: 'tunnel', APP_ACCESS_PASSWORD: 'short' })).toThrow(/APP_ACCESS_PASSWORD/);
  expect(readConfig({ HANGGO_PROFILE: 'tunnel', APP_ACCESS_PASSWORD: 'long-test-password-1234' }).profile).toBe('tunnel');
});
it('derives runtime and data paths from HANGGO_HOME', () => {
  const config = readConfig({ HANGGO_HOME: path.join('D:', 'hanggo') });
  expect(config.consultationDirectory).toBe(path.join('D:', 'hanggo', 'data', 'consultations'));
  expect(config.llamaServer).toBe(path.join('D:', 'hanggo', 'runtime', 'llama-cpp', 'llama-server.exe'));
});
it('rejects an unknown profile', () => { expect(() => readConfig({ HANGGO_PROFILE: 'public' })).toThrow(/HANGGO_PROFILE/); });
```

- [ ] **Step 2:** `npm.cmd test -- server/config.test.ts`로 실패를 확인한다.
- [ ] **Step 3:** `server/config.ts:15`의 검사를 `profile !== 'local' || production || 비루프백 host`일 때 비밀번호 16자 이상으로 바꾼다. 경로 기본값을 `home` 기준으로 옮긴다. `server/index.ts` 맨 앞에서 `loadLocalSecrets(process.env)`를 호출한다.
- [ ] **Step 4:** 테스트 통과를 확인한다. 이 PC의 `.env` 끝에 `HANGGO_HOME=D:\hanggo`를 값을 읽지 않고 추가한다.
- [ ] **Step 5:** 커밋한다. `feat: add HANGGO_HOME and profile-based access checks`

### Task 3: 모델 매니페스트와 설치

**Files:**
- Create: `scripts/models.manifest.json`, `scripts/setup-models.ps1`, `server/models-manifest.test.ts`
- Delete: `scripts/setup-local-speech.ps1`, `scripts/setup-speech-candidates.ps1`, `scripts/setup-local.ps1`
- Modify: `scripts/setup.ps1`

**Interfaces:**
- Produces: 매니페스트 항목 `{ id, kind: 'runtime' | 'stt' | 'llm' | 'mmproj', group: 'core' | 'compare' | 'ci', url, size, sha256, dest, extract?: 'zip' | 'targz' }`. `dest`는 `HANGGO_HOME` 기준 상대 경로다.

매니페스트에 넣을 항목:

| id | 파일 | 크기(바이트) | group |
|---|---|---:|---|
| `llama-cpp` | llama.cpp `b12069` `llama-b12069-bin-win-cuda-12.4-x64.zip` + `cudart-llama-bin-win-cuda-12.4-x64.zip` | 286851724, 391443627 | core |
| `transcribe-cpp` | `transcribe-native-0.4.1-windows-x86_64-cuda.tar.gz` | 202587464 | core |
| `whisper-cpp` | whisper.cpp `b5454` `whisper-bin-win-cuda-12.4.0-x64.zip` | 684913404 | core |
| `cloudflared` | `2026.10.7` `cloudflared-windows-amd64.exe` | 55390512 | core |
| `stt-cohere-q8` | `cohere-transcribe-03-2026-Q8_0.gguf` | 2410655232 | core |
| `stt-whisper-turbo` | `ggml-large-v3-turbo.bin` | 1624555275 | core |
| `stt-qwen-asr` | `Qwen3-ASR-1.7B-Q8_0.gguf`, mmproj | 2165034944, 355709344 | compare |
| `llm-qwen38-27b` | `Qwen3.8-27B-Q4_K_M.gguf`, `mmproj-Qwen3.8-27B-bf16.gguf` | 17442399968, 931145952 | core |
| `llm-hcx-14b` | `HyperCLOVAX-SEED-Think-14B-Q4_K_M.gguf` | 8916242240 | compare |
| `llm-gemma4-12b` | `gemma-4-12b-it-qat-q4_0.gguf`, mmproj | 6975879296, 175115616 | compare |
| `llm-gemma4-e4b` | `gemma-4-E4B_q4_0-it.gguf`, mmproj | 5154941280, 991552256 | compare |
| `llm-qwen35-9b` | `Qwen3.5-9B-Q4_K_M.gguf`, `mmproj-BF16.gguf` | 5680522464, 921705024 | core |
| `stt-cohere-q4-ci` | `cohere-transcribe-03-2026-Q4_K_M.gguf` | 1558162944 | ci |
| `llm-qwen35-4b-ci` | `Qwen3.5-4B-Q4_K_M.gguf` | 2740937888 | ci |

- [ ] **Step 1: 실패하는 테스트를 쓴다.** `id` 중복 없음, `https://`만 허용, `size > 0`, `sha256`이 64자리 16진수, `dest`에 `..` 없음, 모든 항목의 URL에 고정 리비전 또는 태그가 들어 있음.
- [ ] **Step 2:** Hugging Face API와 GitHub Release에서 수집한 값으로 매니페스트를 작성해 테스트를 통과시킨다.
- [ ] **Step 3:** `setup-models.ps1 -Groups core,compare`를 쓴다. `curl.exe --continue-at -`로 이어 받고 크기·SHA-256을 확인한 뒤 옮긴다. 이미 검증된 파일은 건너뛴다. 받기 전에 대상 드라이브 여유 공간을 검사한다.
- [ ] **Step 4:** 백그라운드로 실행한다. 완료 후 `D:\hanggo\cache\install-report.json`에 항목별 결과가 남는지 확인한다.
- [ ] **Step 5:** 커밋한다. `feat: install pinned runtimes and models under HANGGO_HOME`

### Task 4: LLM 제공자

**Files:**
- Create: `server/ai/llm/types.ts`, `server/ai/llm/llama-server.ts`, `server/ai/llm/llama-server.test.ts`, `server/ai/llm/stub.ts`
- Move: `server/ollama.ts`에서 `server/ai/services.ts`로, `server/ollama.test.ts`에서 `server/ai/services.test.ts`로
- Modify: `server/providers.ts`, `server/consultation-vision.ts`, `server/local-status.ts`, `scripts/check-local.ts`, `scripts/beta-check.ts`, `scripts/configure-local.mjs`, `scripts/eval-local.ts`
- Delete: `server/local-model.ts`

**Interfaces:**
- Produces: 설계 문서 §4의 `LlmProvider`.
- Produces: `createLlamaServer(options: { executable: string; model: string; mmproj?: string; contextSize: number; spawn?: typeof spawn; fetch?: typeof fetch }): LlmProvider`.
- Produces: `createAiServices(config, llm: LlmProvider)`는 기존 `generate`, `generateOwner`, `generateBrief`, `generateShelter`를 그대로 반환한다.

- [ ] **Step 1: 실패하는 테스트를 쓴다.** 가짜 `spawn`과 `fetch`로 검증한다.
  - 실행 인자에 `--host 127.0.0.1`, 임의 `--api-key`, `--no-webui`, `--reasoning off`, `-c`가 있고 `--mmproj`는 지정했을 때만 있다.
  - 요청이 `/v1/chat/completions`로 가고 `temperature: 0`, `seed: 42`, `response_format.type === 'json_schema'`를 포함한다.
  - `images`는 `image_url` data URI로 변환되고 mmproj가 없으면 `supportsVision`이 `false`이며 호출을 거부한다.
  - 응답 2MB 초과, `finish_reason !== 'stop'`, 비정상 상태 코드, 스키마 불일치, 중단 신호를 각각 오류로 처리한다.
  - `release()`가 프로세스를 끝낸다. 시작 실패 시 다음 호출에서 다시 시작한다.
- [ ] **Step 2:** 실패를 확인한다.
- [ ] **Step 3:** 구현한다. 첫 `structured` 호출 때 지연 시작하고 `/health`가 준비될 때까지 기다린다. 기존 `structured()`의 안전 신호 보존 동작(불완전 응답에서 `safetyFlags`, `methodReview` 유지)은 `services.ts`에 남긴다.
- [ ] **Step 4:** `server/consultation-vision.ts`의 `analyze`를 `llm.structured`로 바꾼다. `local-status.ts`의 Ollama 조회를 실행 파일·모델 파일 존재 확인으로 바꾼다.
- [ ] **Step 5:** `npm.cmd test -- --maxWorkers=2`와 `npm.cmd run typecheck`를 통과시킨다. 실모델로 `llm:eval:local -- --case N01`을 실행해 1건이 동작하는지 확인한다.
- [ ] **Step 6:** 커밋한다. `refactor: run LLM features through a local provider interface`

### Task 5: 전사 제공자

**Files:**
- Create: `server/ai/speech/types.ts`, `server/ai/speech/whisper-server.ts`, `server/ai/speech/cohere-transcribe.ts`, `server/ai/speech/stub.ts`, 각 테스트
- Modify: `server/providers.ts`, `server/consultation-router.ts`, `server/app.ts`, `server/config.ts`, `scripts/compare-speech.ts`
- Delete: `server/live-speech.ts`, `server/local-speech.ts`와 해당 테스트(내용은 새 테스트로 옮김)

**Interfaces:**
- Produces: 설계 문서 §4의 `SpeechProvider`.
- Produces: `transcribeUpload(provider, buffer, filename, signal)`는 FFmpeg로 16kHz mono WAV를 만든 뒤 제공자를 호출한다. 짧은 녹음 경로가 GPU 제공자를 쓰게 되어 CPU medium 경로가 사라진다.

- [ ] **Step 1:** transcribe.cpp 압축을 풀어 실행 파일과 옵션을 확인한다. 상주 실행 수단(서버, 표준 입력, 바인딩)을 조사해 결과를 작업 메모로 남긴다. 상주가 불가능하면 요청당 모델 로드 시간을 측정한다.
- [ ] **Step 2: 실패하는 테스트를 쓴다.** 명령 구성에 `-l ko`가 있다. 환각 토큰과 빈 응답을 처리한다. 15초 초과 입력을 거부한다. 응답 8,000자 초과를 거부한다. `release()` 후 다시 `prepare()`할 수 있다.
- [ ] **Step 3:** `live-speech.ts`의 Whisper 경로를 그대로 옮기고 Cohere 어댑터를 구현한다. `SPEECH_MODEL` 값은 `cohere`, `whisper-turbo`, `qwen-asr`이다. `AI_PROVIDER=stub`이면 전사와 LLM 모두 고정 응답 구현을 쓴다.
- [ ] **Step 4:** 전체 테스트와 타입 검사를 통과시킨다.
- [ ] **Step 5:** 커밋한다. `refactor: run transcription through speech providers`

### Task 6: 취약점 정리

**Files:**
- Modify: `package.json`, `package-lock.json`, `server/app.ts`

- [ ] **Step 1:** `npm.cmd audit fix`를 실행한다. `--force`는 쓰지 않는다.
- [ ] **Step 2:** `npm.cmd audit --omit=dev`로 production high 0건을 확인한다. 남으면 해당 패키지를 패치 버전으로 올린다.
- [ ] **Step 3:** `server/app.ts`에 `Permissions-Policy: camera=(self), microphone=(self), display-capture=(self)`를 추가하고 테스트한다.
- [ ] **Step 4:** 전체 테스트, 빌드, E2E를 통과시킨다.
- [ ] **Step 5:** 커밋한다. `fix: resolve high severity dependencies before public exposure`

### Task 7: 모델 비교와 선정

**Files:**
- Create: `scripts/fetch-speech-eval.ts`, `scripts/compare-llm.ts`, `fixtures/coaching-dialogues/*.json`(3건), `docs/llm/model-selection-2026-11.md`
- Modify: `scripts/compare-speech.ts`, `server/config.ts`, `.env.example`

**Interfaces:**
- Produces: `speech-comparison.json`, `llm-comparison.json`을 `D:\hanggo\cache\eval`에 저장한다.
- Produces: 골든 대화 형식 `{ id, title, synthetic: true, segments: [{ speaker, startMs, endMs, text }], expectedFacts: string[], expectedTasks: string[], unknown: string[], forbiddenClaims: string[] }`.

- [ ] **Step 1:** 데이터 준비. `kresnik/zeroth_korean` 시험 구간 200개를 dataset-viewer API로 받아 16kHz WAV로 변환한다. Heami 음성으로 반려동물 이름·숫자·부정 표현 문장 30개를 합성한다.
- [ ] **Step 2:** `compare-speech.ts`를 확장한다. 제공자별 CER, 이름·숫자·부정 표현 재현율, 처리 시간/구간 길이, GPU 메모리를 기록한다. 무음 환각도 측정한다.
- [ ] **Step 3:** 전사 비교를 실행하고 설계 문서 §13 기준으로 선정한다.
- [ ] **Step 4:** 골든 대화 3건을 쓴다. 부정 표현, 체벌 언급, 과제 미합의를 포함한다.
- [ ] **Step 5:** `compare-llm.ts`를 쓴다. 후보마다 `llama-server`를 띄워 기존 82개 자료 평가와 골든 대화 구조화 추출을 실행한다. 사실 재현율, 근거 없는 숫자, 토큰/초, 첫 응답 시간, GPU·RAM 사용량을 기록한다. 잠정 프롬프트임을 결과에 표시한다.
- [ ] **Step 6:** 선정 문서를 쓴다. 합성·공개 자료 기준임을 구분하고 3단계에서 골든 대화 10건으로 재검증한다고 적는다. `SPEECH_MODEL`, `LLM_MODEL` 기본값을 반영한다. 탈락 모델은 사용자 지시 전에는 지우지 않는다.
- [ ] **Step 7:** 전체 검증 후 커밋하고 `main`에 합쳐 push한다. `docs: select local models by measured Korean results`

---

## 1단계: 쌍방향 통화

### Task 8: 사례·상담 도메인과 권한

**Files:**
- Create: `src/domain/coaching.ts`, `src/domain/coaching.test.ts`, `src/domain/permissions.ts`, `src/domain/permissions.test.ts`

**Interfaces:**
- Produces: 설계 문서 §5 타입 중 `Speaker`, `CoachingCase`, `Consultation`.
- Produces: `transition(consultation, event)`는 다음 상태를 반환하고 잘못된 전이면 예외를 던진다. `event`는 `start | end | processed | approve | interrupt`.
- Produces: `setConsent(consultation, role, value)`는 양쪽 동의일 때만 `recording: true`로 만들고, 철회 시 `recordingGaps`를 연다.
- Produces: `can(actor, action, resource)`는 설계 문서 §7 표를 그대로 표현한다. `actor`는 `{ role: 'trainer' } | { role: 'guardian'; caseId: string }`.

- [ ] **Step 1: 실패하는 테스트를 쓴다.** §7 표의 모든 행을 표 기반 테스트로 옮긴다. 다른 사례의 보호자는 전부 거부다. `scheduled`에서 `approve` 같은 잘못된 전이는 거부다. 한쪽 동의로는 기록이 시작되지 않고, 철회하면 멈춘다.
- [ ] **Step 2:** 실패를 확인한다.
- [ ] **Step 3:** 구현한다. 입출력은 불변으로 다룬다.
- [ ] **Step 4:** 통과를 확인한다.
- [ ] **Step 5:** 커밋한다. `feat: add coaching case model and role permissions`

### Task 9: 사례 저장소

**Files:**
- Create: `server/coaching/store.ts`, `server/coaching/store.test.ts`

**Interfaces:**
- Consumes: Task 8 타입.
- Produces: `interface CoachingStore { createCase(input): Promise<{ case: CoachingCase; inviteToken: string }>; reissueInvite(caseId): Promise<string>; redeemInvite(token): Promise<CoachingCase>; getCase(id); listCases(); createConsultation(caseId); getConsultation(id); updateConsultation(id, mutate) }`.
- Produces: `createFileStore(directory): CoachingStore`.

- [ ] **Step 1: 실패하는 테스트를 쓴다.** 임시 폴더로 검증한다. 토큰 원문이 파일에 저장되지 않는다. 만료·재사용·재발급 전 토큰을 거부한다. 동시 수정이 직렬화된다. 재시작 후 다시 읽을 수 있다. 경로 조작 ID를 거부한다. `live` 상담이 재시작 시 `interrupted`가 된다.
- [ ] **Step 2:** 실패를 확인한다.
- [ ] **Step 3:** 기존 `ConsultationStore`의 임시 파일 후 교체 방식과 `lock` 직렬화를 재사용해 구현한다.
- [ ] **Step 4:** 통과를 확인한다.
- [ ] **Step 5:** 커밋한다. `feat: persist coaching cases with hashed invites`

### Task 10: REST API와 ICE

**Files:**
- Create: `server/coaching/router.ts`, `server/coaching/router.test.ts`, `server/turn.ts`, `server/turn.test.ts`
- Modify: `server/app.ts`, `server/config.ts`

**Interfaces:**
- Consumes: Task 8, 9.
- Produces: 설계 문서 §6의 사례·초대·입장·상담 시작·동의·ICE·종료 경로. 2단계 이후 경로는 이번에 만들지 않는다.
- Produces: `iceServers(env): RTCIceServer[]`. `TURN_URLS`가 쉼표 구분 목록이고 세 값이 모두 있어야 TURN을 포함한다. 항상 `stun:stun.cloudflare.com:3478`를 포함한다.
- Produces: 참가자 세션 쿠키. 값은 서버 메모리의 `{ role, caseId?, expiresAt }`와 연결된다.

- [ ] **Step 1: 실패하는 테스트를 쓴다.** supertest로 검증한다.
  - 비로그인으로 사례 생성은 401이다.
  - `POST /join` 성공 후 해당 사례만 보이고 다른 사례는 403이다.
  - 보호자의 상담 시작·종료·초대 재발급은 403이다.
  - `GET /ice`는 비참가자에게 403이고, TURN 값이 없으면 STUN만 반환하며 `relayAvailable: false`를 준다.
  - 잘못된 Origin의 변경 요청은 403이다. `/join`은 분당 10회로 제한된다.
  - 응답 어디에도 `inviteHash`가 없다.
- [ ] **Step 2:** 실패를 확인한다.
- [ ] **Step 3:** 구현하고 `createApp`에 연결한다.
- [ ] **Step 4:** 통과를 확인한다.
- [ ] **Step 5:** 커밋한다. `feat: add role-scoped coaching API and ICE configuration`

### Task 11: WebSocket 신호 서버

**Files:**
- Create: `server/coaching/signal.ts`, `server/coaching/signal.test.ts`
- Modify: `server/index.ts`, `package.json`

**Interfaces:**
- Consumes: Task 10 세션 조회.
- Produces: `attachSignal(server, deps)`. 설계 문서 §6의 메시지를 처리한다.

```ts
type ClientMessage = { type: 'ping'; at: number } | { type: 'offer' | 'answer'; sdp: string } | { type: 'candidate'; candidate: unknown };
type ServerMessage = { type: 'hello'; role: Speaker; serverNow: number; peerOnline: boolean } | { type: 'pong'; at: number; serverNow: number } | { type: 'offer' | 'answer'; sdp: string } | { type: 'candidate'; candidate: unknown } | { type: 'state'; consent: Record<Speaker, boolean>; recording: boolean; state: Consultation['state']; peerOnline: boolean } | { type: 'error'; code: string };
```

- [ ] **Step 1: 실패하는 테스트를 쓴다.** 실제 HTTP 서버와 `ws` 클라이언트로 검증한다.
  - 쿠키 없음, 잘못된 Origin, 다른 사례 보호자는 업그레이드를 거부한다.
  - 메시지는 상대에게만 중계된다.
  - 64KB 초과와 초당 50개 초과 메시지는 연결을 끊는다.
  - 같은 역할의 재접속은 이전 연결을 닫는다. 세 번째 역할은 존재하지 않는다.
  - 동의 변경이 양쪽 `state`로 전달된다.
- [ ] **Step 2:** 실패를 확인한다.
- [ ] **Step 3:** `ws` 패키지를 추가하고 구현한다. Express 서버의 `upgrade`에 붙인다.
- [ ] **Step 4:** 통과를 확인한다.
- [ ] **Step 5:** 커밋한다. `feat: relay WebRTC signaling between case participants`

### Task 12: 통화 훅과 장치 처리

**Files:**
- Create: `src/call/signal-client.ts`, `src/call/devices.ts`, `src/call/devices.test.ts`, `src/call/useCall.ts`, `src/call/useCall.test.ts`

**Interfaces:**
- Produces: `openDevices(preference): Promise<{ stream: MediaStream; missing: ('camera' | 'microphone')[] }>`. 영상+음성, 음성만, 영상만, 수신만 순서로 대체한다.
- Produces: `useCall({ consultationId, role })`가 `{ status, localStream, remoteStream, remoteScreen, stats, toggleMic, toggleCamera, switchCamera, startScreenShare, stopScreenShare, leave, error }`를 반환한다.
- Produces: `stats`는 `{ inboundVideoFrames, inboundAudioBytes, roundTripMs, relayed }`.

- [ ] **Step 1: 실패하는 테스트를 쓴다.** 가짜 `RTCPeerConnection`과 `mediaDevices`로 검증한다.
  - 카메라 실패 시 음성으로 입장하고 `missing`에 `camera`가 들어간다.
  - 장치가 전혀 없어도 수신용 transceiver로 입장한다.
  - 동시 offer에서 impolite 쪽은 무시하고 polite 쪽은 rollback한다.
  - 화면 공유 트랙은 카메라 트랙을 대체하지 않는다. 공유 종료 이벤트가 정리된다.
  - `disconnected` 5초 후 `restartIce`를 호출한다.
  - `leave()`가 모든 트랙과 연결을 닫는다.
- [ ] **Step 2:** 실패를 확인한다.
- [ ] **Step 3:** 구현한다. `getDisplayMedia`는 `{ video: true, audio: true, systemAudio: 'include', monitorTypeSurfaces: 'include', surfaceSwitching: 'include' }`로 호출한다. `displaySurface` 제한은 두지 않는다.
- [ ] **Step 4:** 통과를 확인한다.
- [ ] **Step 5:** 커밋한다. `feat: add WebRTC call hook with device fallback`

### Task 13: 역할 화면

**Files:**
- Create: `src/roles/TrainerHome.tsx`, `src/roles/GuardianJoin.tsx`, `src/roles/CallRoom.tsx`, `src/roles/CallControls.tsx`, `src/roles/call.css`, 각 테스트
- Modify: `src/App.tsx`, `src/main.tsx`, `server/app.ts`

**Interfaces:**
- Consumes: Task 10 API, Task 12 `useCall`.
- Produces: 경로 `/`(기존 앱과 훈련사 사례 화면), `/join/:token`, `/room/:id`. Express는 이 경로에 `index.html`을 돌려준다. 라우터 패키지는 추가하지 않는다.
- Produces: 연결 상태 표시 요소에 `data-inbound-video-frames`, `data-inbound-audio-bytes`, `data-relayed`, `data-call-status` 속성을 둔다. E2E가 읽는다.

- [ ] **Step 1: 실패하는 테스트를 쓴다.** Testing Library로 검증한다.
  - 훈련사가 사례를 만들면 초대 링크가 표시된다.
  - 보호자 입장 화면이 동의 체크, 장치 선택, 인앱 브라우저 안내를 보여 준다.
  - `missing` 안내가 원인별로 다르다. TURN이 없으면 경고가 보인다.
  - 공유 버튼은 `getDisplayMedia`가 없으면 숨겨진다.
  - 공유가 있으면 공유 화면이 가장 크다.
  - 음소거, 카메라 끄기, 나가기 버튼에 접근 가능한 이름이 있다.
- [ ] **Step 2:** 실패를 확인한다.
- [ ] **Step 3:** 구현한다. 폭 390px에서 가로 넘침이 없어야 한다. 문구는 가이드 §3.6을 따른다.
- [ ] **Step 4:** 통과를 확인하고 브라우저로 데스크톱·모바일 폭 화면을 직접 확인한다.
- [ ] **Step 5:** 커밋한다. `feat: add trainer and guardian call screens`

### Task 14: 두 브라우저 E2E

**Files:**
- Create: `e2e/two-way.spec.ts`, `e2e/helpers/two-way.ts`, `e2e/media/README.md`, `scripts/make-e2e-media.ts`
- Modify: `playwright.config.ts`, `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: Task 13의 `data-*` 표시, Task 10 API.
- Produces: 실제 서버를 `AI_PROVIDER=stub`, 임시 `HANGGO_HOME`, 별도 포트로 띄우는 헬퍼. 역할별 Chrome 인스턴스를 서로 다른 fake 장치 파일로 실행한다.

- [ ] **Step 1:** `make-e2e-media.ts`로 FFmpeg `testsrc2`와 `sine`을 이용해 역할별 Y4M·WAV를 `.tmp/e2e-media`에 생성한다. 저장소에는 넣지 않고 실행 때 만든다.
- [ ] **Step 2: E2E를 쓴다.** 다음 시나리오를 각각 검증한다.
  - 초대부터 입장까지 진행하고 양쪽 `data-inbound-video-frames`와 `data-inbound-audio-bytes`가 증가한다.
  - 음소거 후 상대 수신 오디오 에너지가 떨어지고 해제 후 돌아온다.
  - 화면 공유 시작 후 상대에 두 번째 영상이 나타나고 종료 후 사라진다. fake UI 인자로 자동 선택한다.
  - 카메라 없는 쪽(`--use-fake-device` 없이 장치 권한 거부)도 입장해 상대 영상을 받는다.
  - 새로고침 후 다시 연결된다.
  - 세 번째 브라우저, 다른 사례 쿠키, 만료 초대가 거부된다.
- [ ] **Step 3:** 실패를 확인하며 고친다. 재시도 설정으로 숨기지 않는다. 불안정하면 원인을 분석한다.
- [ ] **Step 4:** 로컬 5회 연속 통과를 확인한다. `verify`와 CI에 포함한다.
- [ ] **Step 5:** 커밋 후 push해 Actions 통과를 확인한다. `test: verify real two-browser WebRTC calls`

### Task 15: 터널 실행과 중계 검증

**Files:**
- Create: `scripts/demo-tunnel.mjs`, `scripts/check-turn.ts`, `docs/llm/two-way-step-1.md`, `docs/testing/two-way-coaching.md`
- Modify: `package.json`, `README.md`

**Interfaces:**
- Produces: `npm.cmd run demo:tunnel`. 비밀번호 없으면 실행을 거부한다. cloudflared를 먼저 띄워 주소를 얻고 빌드된 앱을 `HANGGO_PROFILE=tunnel`, `NODE_ENV=production`, `PUBLIC_ORIGIN=<주소>`로 시작한다. 4시간 후 자동 종료한다.
- Produces: `npm.cmd run check:turn`. `iceTransportPolicy: 'relay'`로 데이터 채널 왕복을 시험하고 통과·실패와 왕복 시간만 출력한다. 값은 출력하지 않는다.

- [ ] **Step 1:** `check:turn`을 쓰고, 자격 증명이 있으면 실행한다. 없으면 미검증으로 기록한다.
- [ ] **Step 2:** `demo-tunnel.mjs`를 쓴다. 터널 주소에서 WebSocket 신호가 동작하는지 두 브라우저로 시험한다. 실패하면 설계 문서 §22대로 폴링으로 바꾼다.
- [ ] **Step 3:** relay 강제 E2E를 `TURN_URLS`가 있을 때만 실행되게 추가한다.
- [ ] **Step 4:** 검증 문서와 사람 시연 대본을 쓴다. 자동 결과와 사람 결과 칸을 분리한다.
- [ ] **Step 5:** 전체 검증 후 커밋하고 `main`에 합쳐 push한다. Actions와 Pages 결과를 확인한다. `feat: run two-way calls through a tunnel`

---

## 1단계 이후

0~1단계 결과를 반영해 2단계 계획을 별도 문서로 이어서 쓴다. 전사 런타임과 일지 모델이 정해진 뒤라야 2·3단계의 처리 시간과 분할 기준을 확정할 수 있다.
