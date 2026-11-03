# 쌍방향 코칭 3단계 구현 계획

**Goal:** 상담이 끝나면 전사와 장면으로 근거 달린 일지 초안을 만들고, 훈련사가 검토·수정·확정하면 보호자에게 전달한다.

**Architecture:** LLM은 근거 ID를 고른 문장만 낸다. 인용과 시각은 코드가 원문에서 채우고 코드가 다시 검증한다. 안전 신호와 체벌 표시는 규칙과 LLM의 OR이다. 보호자 응답은 서버에서 투영하며 초안은 보내지 않는다.

**Tech Stack:** 2단계와 같음. LLM은 Gemma 4 12B, CI는 고정 응답 LLM.

설계 기준: [설계 문서](../specs/2026-11-03-two-way-coaching-design.md) §5, §7, §10.

## Global Constraints

- 금지 표현, 근거 없는 숫자·이름·과제는 일지에 남지 않는다. 재생성 1회 후에도 남으면 그 항목을 버리고 경고를 남긴다.
- 전체 실패 시 빈 양식과 전체 전사를 보여 준다. 조용히 사라지는 내용이 없도록 `uncitedSegmentIds`를 표시한다.
- 메아리 의심 구간은 근거로 쓰지 않는다.
- 훈련사가 검토한 장면 관찰만 확정본에 들어간다. 체벌 언급은 보호자 전달본에서 뺀다.
- 보호자는 초안, 전사 수정본, 장면 전체를 볼 수 없다. 확정본이 인용한 장면만 볼 수 있다.
- 통화 중에는 전사 모델만 GPU에 올린다. 종료 후 전사 모델을 내리고 장면 분석, 일지 생성 순으로 LLM을 쓴다.
- 합성 입력 결과를 실제 검증으로 쓰지 않는다.

---

### Task 1: 일지 도메인과 검증

**Files:** `src/domain/coaching-note.ts`, `src/domain/coaching-note.test.ts`

- 타입: `Evidence`, `Claim`, `BehaviorEntry`, `CoachingTask`, `CoachingNote`, `Scene`.
- `flagsFromTranscript`: 규칙 안전 신호. `methodReview` 규칙.
- `assembleNote(raw, context)`: LLM 출력의 근거 ID를 원문 인용으로 바꾼다. 위반 문장을 모은다.
- 검사: 근거 존재, 숫자, 이름, 화자 규칙, 금지 표현, 과제 필드 null 처리, 미인용 구간.

### Task 2: 일지 생성 서비스

**Files:** `server/coaching/note-prompt.ts`, `server/coaching/note-service.ts`, 테스트, `server/ai/llm/stub.ts`

- 짧은 근거 별칭(`s01`, `m01`)으로 프롬프트를 만든다. 15분 단위로 나누어 추출하고 통합한다.
- 위반 사유를 붙여 1회 재생성한다. 전체 실패는 `fallbackUsed`.

### Task 3: 장면 관찰

**Files:** `server/coaching/scene-service.ts`, 테스트

- 캐치 장면과 간격 표본을 최대 3장씩 묶어 분석한다. "보이는 것만" 규칙 유지.

### Task 4: 후처리 흐름과 API

**Files:** `server/coaching/post-process.ts`, `server/coaching/router.ts`, 테스트

- 종료 후 전사 정리, 모델 교체, 장면, 일지, `review` 순서. 실패해도 `review`로 간다.
- `PATCH segments`, `PATCH scenes`, `POST note`, `PUT note`, `POST approve`, `GET delivery`, 인용 장면 조회.

### Task 5: 검토 화면과 보호자 전달 화면

**Files:** `src/roles/ReviewRoom.tsx`, `src/roles/GuardianDelivery.tsx`, `src/roles/TrainerHome.tsx`, `src/roles/GuardianHome.tsx`, `src/main.tsx`, `src/coaching-api.ts`

- 전사 왼쪽, 일지 오른쪽. 항목을 누르면 근거 발화와 사진이 강조된다.

### Task 6: 골든 평가와 E2E

**Files:** `fixtures/coaching-dialogues/*`, `scripts/note-metrics.ts`, `scripts/eval-notes.ts`, `e2e/two-way-note.spec.ts`

- 고정 응답 LLM으로 전체 흐름. 이 PC에서 Gemma 4 12B로 재현율과 근거 없는 주장 수를 측정해 `docs/llm/two-way-step-3.md`에 기록한다.
