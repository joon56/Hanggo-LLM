# 상담노트 OpenAI 연동 구현 계획

> **For agentic workers:** Use subagent-driven-development for bounded implementation and independent review. User approved the proposed design and implementation on 2026-09-30. No further design approval is needed.

**Goal:** 현재 상담노트의 음성 받아쓰기, 텍스트 정리, 검토·승인·보관을 실제 OpenAI API와 연결하고 직접 테스트 및 단일 운영자 배포에 필요한 도구를 제공한다.

**Architecture:** React → 동일 출처 Node.js API → OpenAI. 음성 STT와 구조화 추출을 분리한다. 원문에서 정확히 인용한 구절만 초안으로 사용하며 최종 판단은 사람이 한다. 승인 기록은 기존 브라우저 저장을 유지한다.

**Tech Stack:** Node.js 24, Express, OpenAI SDK, Zod, React, TypeScript, Vite, Vitest, Playwright.

## Global Constraints

- 범위: 현재 상담노트. 보호자 기록 A, 상담 전 브리핑 B-1, 보호소 프로필 C 및 실제 레슨 카탈로그 연결은 제외한다.
- API 키는 서버 환경변수에만 둔다. AI 기능 기본 꺼짐. 호출 전 음성·텍스트 외부 처리 동의를 받는다.
- 텍스트 최대 8,000자, 음성 3~60초 및 최대 10MB. 파일은 메모리에서 처리하고 디스크에 저장하지 않는다.
- 서버는 원문, 응답 본문, 비밀번호, 키를 로그에 쓰지 않는다. 요청 ID·모델·시간·결과만 기록한다.
- 원문 인용·숫자·분류·안전 신호 검증. 위험 신호 OR 결합. 재생성 최대 1회. 실패는 수동 검토 초안으로 명시한다.
- 원문·메타데이터 변경, 새 기록, 녹음 교체 시 비동기 응답을 무효화한다. 승인 전 저장하지 않는다.
- 공개 배포는 단일 운영자 비밀번호와 HTTPS 출처를 필수로 한다. 서버 저장·계정별 권한·다중 사용자 운영은 이번 범위가 아니다.
- 실제 API 키가 없으면 모의 HTTP 응답 기반 통합 검증과 실제 API 평가 명령을 구분한다. 무결함 또는 실사용 품질을 보장하지 않는다.

## Task 1 서버와 도메인

Files: `server/config.ts`, `server/app.ts`, `server/index.ts`, `server/openai.ts`, `server/service.ts`, `server/*.test.ts`, `src/domain/notes.ts`, `src/domain/storage.ts`.

- [x] 잘못된 인용·위험 과제·재시도·공급사 오류·인증·업로드 제한을 테스트로 먼저 정의하고 실패를 확인한다.
- [x] `POST /api/notes` accepts `{text, sourceKind, consent:true}` and returns `{draft, fallbackUsed, requestId, latencyMs, model, warnings}`.
- [x] `POST /api/transcribe` accepts multipart `audio`, `duration`, `petName`, `consent=true`; returns `{text, requestId, latencyMs, model}`.
- [x] `GET /api/session` returns `{authenticated, requirePassword, aiEnabled, configured, textModel, sttModel}`. `POST /api/session` logs in with `{password}`; DELETE logs out. Cookies: HttpOnly, SameSite=Strict, Secure in production.
- [x] `Draft.mode` and `ApprovedNote.mode`: `demo | openai | manual`. Old version 1 records remain readable. Optional `generation` stores request ID, model, prompt version, latency and fallback flag.
- [x] Request limiting, fixed origin checks, secure headers, bounded input, memory-only upload, structured errors, static production serving, startup configuration validation.
- [x] `npm.cmd test` and `npm.cmd run typecheck` pass.

## Task 2 UI integration

Files: `src/api.ts`, `src/components/ConnectionPanel.tsx`, `src/App.tsx`, `src/components/NoteReview.tsx`, `src/hooks/useRecorder.ts`, related tests, `src/styles.css`.

- [x] Test asynchronous note generation, edited input while pending, STT errors and original preservation, consent and password login.
- [x] Expose recorder Blob for upload; retain 3~60 second bounds and cleanup.
- [x] Add online/offline status, external-processing consent, STT button, transcript confirmation, async progress/cancel, clear fallback indication and processing metadata.
- [x] Preserve original source on failed requests and ignore stale responses. Revoke audio and abort requests on reset/unmount.
- [x] Label actual AI, manual fallback and legacy demo records accurately. Existing data and approval checks remain supported.
- [x] Unit tests and browser integration tests pass.

## Task 3 test materials and distribution

Files: `fixtures/session-notes.json`, `scripts/eval.ts`, `scripts/dev.mjs`, `scripts/*.ps1`, `.env.example`, `Dockerfile`, `.dockerignore`, `README.md`, `docs/testing/*`.

- [x] 30 Korean cases with stable IDs, source text, category/risk expectations and key terms for speech checks.
- [x] Human guide covers quiet room, noise, fast speech, 3/60 second limits, permission denial, API failure, edit, approval, reload, JSON export and deletion.
- [x] UTF-8 CSV result sheet records STT vs extraction errors, unedited saves, latency and environment. Evaluation script supports dry run and explicit live mode, text cases and optional user-recorded audio directory; fails nonzero on unmet conditions.
- [x] PowerShell setup/dev/verify scripts preserve `.env`, propagate failures, and use workspace-local caches. Production Node server and Docker support single-operator deployment behind HTTPS.

## Task 4 verification and review

- [x] Run unit/integration tests, typecheck, production build, Playwright tests and fixture dry run.
- [x] Review API key leakage, production config, auth, origin, rate limits, stale responses, safety validation and backwards compatibility independently.
- [x] Fix important findings and re-run relevant checks. Document exact results and remaining live API / human microphone verification.

## Progress

2026-09-30: Design approved. Workspace has no Git metadata; no commits or worktrees will be created. Implementation started.

2026-09-30: Implementation complete. Final npm.cmd run verify exit 0: 73 unit/integration tests, 6 browser tests, build/typecheck and 30 fixtures passed. Runtime dependency audit: 0 vulnerabilities. Independent review findings resolved. Live OpenAI, physical microphone and Docker/public deployment remain unverified; see docs/llm/openai-verification.md.
