# 쌍방향 코칭 2단계 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 통화 중 참가자별 음성을 화자 라벨과 함께 전사해 자막으로 보여 주고, 캐치 버튼으로 전후 장면을 저장하며, 이전 녹화 방식 코드를 없앤다.

**Architecture:** 각 브라우저가 자기 마이크만 침묵 기준으로 잘라 서버에 올린다. 서버는 한 줄 큐로 전사하고 WebSocket으로 자막을 양쪽에 보낸다. 장면은 브라우저 링 버퍼에서 만들고, 영상 녹화 파일은 만들지 않는다.

**Tech Stack:** 1단계와 같음. 전사 Qwen3-ASR, CI는 고정 응답 전사기.

설계 기준: [설계 문서](../specs/2026-11-03-two-way-coaching-design.md) §5, §9, §12.

## Global Constraints

- 양쪽 동의 전에는 음성·장면을 만들거나 올리지 않는다. 서버도 `recording`이 아니면 거부한다.
- 원본 음성은 디스크에 저장하지 않는다. 전사 후 버린다. 재전사가 필요 없고 개인정보 부담이 줄어든다.
- 음성 구간은 3~8초를 우선하고 15초를 넘기지 않는다. 음성이 없는 구간은 올리지 않는다.
- 장면은 JPEG 256KB 이하다. 보호자 카메라만 30초마다 올리고, 그 외는 캐치 때만 올린다.
- AI가 실패해도 통화는 끊지 않는다. 실패 구간은 표시한다.
- 합성 입력 결과를 실제 검증으로 쓰지 않는다.
- `feat/two-way-coaching`에서 작업하고 통과 시 `main`에 합쳐 push한다. 끝에 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 1: 도메인과 저장소

**Files:** `src/domain/coaching.ts`, `src/domain/coaching.test.ts`, `server/coaching/store.ts`, `server/coaching/store.test.ts`

**Interfaces:**
- Produces: `Segment`, `Moment`, `FrameRef` 타입(설계 §5). `Consultation`에 `segments`, `moments`, `frames` 추가.
- Produces: `findEchoSource(segments, candidate): Segment | undefined`. 다른 화자의 3초 이내 구간과 글자 2-gram Dice 0.7 이상이고 6자 이상이면 메아리로 본다.
- Produces: `store.putFrame(consultationId, frameId, bytes)`, `store.readFrame(consultationId, frameId)`.

- [ ] 실패 테스트: 메아리 판정(같은 화자 제외, 시간 차, 짧은 문장 제외), 프레임 저장·경로 조작 거부, 이전 형식 파일 읽기.
- [ ] 구현 후 통과 확인, 커밋.

### Task 2: 침묵 기준 분할과 업로드 큐

**Files:** `src/call/speech-windows.ts`, `src/call/speech-windows.test.ts`, `src/call/upload-queue.ts`, `src/call/upload-queue.test.ts`

**Interfaces:**
- Produces: `class SpeechWindows { constructor(sampleRate, emit); push(samples); flush(); }`. `emit({ bytes: Blob, startMs, endMs })`. 시각은 스트림 시작 기준이다.
- Produces: `OrderedUploadQueue`(기존 코드 이동).

- [ ] 실패 테스트: 침묵에서 자름, 3초 전에는 안 자름, 8초 넘으면 마지막 침묵에서 자름, 15초 강제, 무음만 있으면 내보내지 않음, 16kHz 변환, 시각 연속성.
- [ ] 구현 후 통과 확인, 커밋.

### Task 3: 서버 전사와 장면 경로

**Files:** `server/coaching/wav.ts`, `server/coaching/transcription.ts`, `server/coaching/router.ts`, `server/coaching/signal.ts`, `server/ai/speech/stub.ts`, 각 테스트, `server/app.ts`, `server/providers.ts`

**Interfaces:**
- Produces: `PUT /consultations/:id/audio/:startMs?endMs`(화자와 시작 시각이 구간 식별자라 새로고침 후에도 충돌하지 않음), `PUT /consultations/:id/frames/:frameId?atMs&source&moment`, `POST /consultations/:id/moments`, `PATCH /consultations/:id/moments/:momentId`, `GET /consultations/:id/frames/:frameId`.
- Produces: 신호 메시지 `caption`, `moment`, `speech`. `state`에 `recordingStartedAt` 추가.
- Produces: `createTranscription({ store, speech, notify })`의 `enqueue`, `drain`, `start`, `stop`. 기록 시작 때 모델 준비, 종료 후 큐를 비우고 해제한다.

- [ ] 실패 테스트: 기록 전 업로드 거부, 화자는 세션에서 결정, 같은 구간 재전송 무시, 잘못된 WAV·JPEG 거부, 전사 실패 표시 후 다음 구간 진행, 메아리 표시, 큐 순서, 종료 후 `review` 전환과 모델 해제, 다른 사례 접근 거부, 보호자의 프레임 직접 조회 거부.
- [ ] 구현 후 통과 확인, 커밋.

### Task 4: 브라우저 기록과 화면

**Files:** `src/call/speech-uplink.ts`, `src/call/frame-buffer.ts`, 각 테스트, `src/call/call-session.ts`, `src/roles/CallRoom.tsx`, `src/roles/CallStage.tsx`, `src/roles/call.css`, `src/coaching-api.ts`

**Interfaces:**
- Produces: `FrameBuffer`(1초 간격 링 버퍼, 10초 보관), `SpeechUplink`(`recording`을 따라 시작·중지).
- Produces: 시계 차이 계산 `estimateOffset(samples)`. 왕복이 가장 짧은 측정을 쓴다.
- Produces: 화면의 자막, 캐치 버튼, 훈련사 메모, 전사 상태 표시. `data-caption-count`로 E2E가 읽는다.

- [ ] 실패 테스트: 시계 계산, 링 버퍼 보관·범위 조회, 캐치 범위 5초 전~2초 후 최대 8장, 동의 철회 시 중지, 자막 화자 표시.
- [ ] 구현 후 통과 확인, 커밋.

### Task 5: E2E와 실모델 확인

**Files:** `e2e/two-way-record.spec.ts`, `e2e/helpers/two-way.ts`, `scripts/verify-two-way-real.ts`

- [ ] 고정 응답 전사기로 전체 흐름을 검증한다: 동의 전 업로드 0건, 동의 후 자막, 화자 라벨 일치, 캐치 사진이 버튼 5초 전을 포함, 철회 시 자막 중단, 종료 후 `review`.
- [ ] 이 PC에서 Qwen3-ASR과 합성 한국어 음성으로 실모델을 확인하고 자막 지연과 CER을 기록한다.

### Task 6: 이전 상담 코드 제거

**Files:** 삭제 `server/consultation-*`, `server/brief-consultation*`, `src/consultation-api*`, `src/domain/consultation*`, `src/components/Consultation*`, `src/hooks/useConsultationRecorder*`, `src/App.consultation.test.tsx`, `src/consultation.css`, `e2e/consultation.spec.ts`, `scripts/verify-live-consultation.ts`. 수정 `src/App.tsx`, `src/components/BriefWorkspace.tsx`, `server/app.ts`, `server/config.ts`, `server/providers.ts`.

- [ ] 브리핑의 서버 상담 선택을 뗀다. 4단계에서 새 사례 저장소로 다시 잇는다.
- [ ] 전체 검증 후 검증 문서를 쓰고 `main`에 합쳐 push한다.
