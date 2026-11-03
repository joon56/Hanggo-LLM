# 보호자·훈련사 쌍방향 화상 코칭과 근거 기반 상담일지 설계

상태: 목표 승인 2026-11-03. 구현 전 설계 문서다.

이 문서는 [보류했던 원격 상담 제안](2026-10-07-remote-consultation-design.md)을 대체한다. 인계 가이드 §3의 작업 순서와 §3.1 답변 대기 질문도 대체한다. 제품 원칙은 `행고_LLM_개발가이드.md` §1.6, §3을 그대로 따른다. 단 §3.2·§3.3의 근거 연결 원칙을 지키는 범위에서 "정확한 인용만 허용"하는 현재 일지 규칙은 폐기한다.

## 1. 목표

보호자와 훈련사가 각자 기기, 서로 다른 네트워크에서 링크로 접속해 Zoom·Meet처럼 화상 코칭을 한다. 끝나면 화자·시각·장면 근거가 붙은 구체적 상담일지와 과제가 생성된다. 훈련사가 확정하면 보호자에게 전달되고, 보호자 수행 기록은 다음 상담 브리핑으로 돌아온다. 이 순환 전체를 GitHub Actions가 두 역할 브라우저로 자동 시연·검증한다. 마지막 단계에서는 이 PC가 꺼져 있어도 동작한다.

완료 정의는 §18의 0~7단계 통과다. 이후는 §19의 점수판 기준으로 계속 개선한다.

## 2. 사용자 결정 (2026-11-03)

- 공유: 본인 카메라 실시간 접근과 바탕화면 전체 공유. 통화 안에서 제공한다.
- 녹화본 재생은 뺀다. 녹화 저장·재생·다운로드를 전부 제거한다.
- 모델: Ollama가 아니어도 된다. 구할 수 있는 최고 무료 모델을 쓴다.
- 저장: 모델·데이터처럼 용량 큰 것은 D 드라이브에 둔다. 저장소는 현재 위치에 둔다.
- 비용: 결제 수단을 쓰지 않는다. 서비스가 카드를 요구하면 멈추고 보고한다.
- 계정: Hugging Face 계정은 쓰지 않는다. 후보 GGUF는 게이트가 없고, Cohere 파일은 익명 다운로드 응답을 확인했다(2026-11-03).
- TURN: Cloudflare TURN은 대시보드가 결제 정보를 요구해 제외한다(2026-11-03 사용자 확인). Open Relay 공개 인증은 이 PC에서 중계 후보 0개로 동작하지 않았다. ExpressTURN 무료 플랜을 1순위로 쓰고, 코드는 서비스에 묶지 않는다.
- GitHub: `joon56/Hanggo-LLM`에 push와 Actions 배포를 진행한다(2026-11-03 사용자 지시). `main`은 CI 통과 상태로 유지한다.

## 3. 사용자 흐름

### 훈련사

1. 비밀번호로 로그인한다. 상담 사례(반려동물·보호자·훈련사)를 만들고 보호자 초대 링크를 복사한다.
2. 상담을 시작한다. 통화 전에 훈련사 전용 브리핑을 읽는다. 보호자에게 노출하지 않는다(개발가이드 §3.7).
3. 통화한다. 자막을 보고, 캐치 버튼으로 장면과 메모를 남긴다.
4. 상담을 종료한다. 남은 전사, 장면 분석, 일지 초안이 순서대로 진행된다.
5. 전사·장면 관찰·일지를 근거와 함께 검토·수정하고 확정한다.
6. 다음 상담에서 지난 과제와 수행 기록이 브리핑 근거로 나타난다.

### 보호자

1. 링크를 연다. 인앱 브라우저면 Chrome·Safari로 열도록 안내한다.
2. 카메라·마이크를 고르고 입장한다. 휴대폰은 후면 카메라로 전환할 수 있다. 장치가 없어도 입장할 수 있다.
3. 통화한다. 자막을 보고, 캐치 버튼을 쓸 수 있다.
4. 종료 후 훈련사가 확정한 일지와 과제를 본다. 초안은 볼 수 없다.
5. 과제 수행을 체크하고 텍스트·음성으로 기록한다.

### 동의

양쪽이 각자 "AI 전사와 장면 저장"에 동의해야 기록이 시작된다. 통화는 동의 없이도 가능하다. 기록 중이면 양쪽 화면에 상태를 표시한다. 어느 쪽이든 철회하면 기록을 멈추고 통화는 유지한다. 중단 구간은 일지에 표시한다.

### 상담 상태

`scheduled` 다음 `live`, `processing`, `review`, `approved` 순서로 진행한다. 비정상 종료는 `interrupted`로 남기고 저장된 구간을 보존한다. 재연결은 같은 상담의 `live` 안에서 처리한다. 기록 여부는 상태와 별도로 `recording` 값으로 관리한다.

## 4. 구성 단위

서버 로직은 런타임과 분리한다. 상태 전이·권한·검증은 순수 함수로 두어 7단계의 Cloudflare 이식에서 재사용한다.

| 단위 | 책임 | 의존 |
|---|---|---|
| `src/domain/coaching.ts` | 사례·상담·기록 타입과 상태 전이 | 없음 |
| `src/domain/permissions.ts` | §7 권한 판단 | 없음 |
| `src/domain/coaching-note.ts` | 일지 스키마와 근거 검증 | `notes.ts`의 금지 표현·안전 규칙 |
| `src/call/useCall.ts` | WebRTC 협상, 재연결, 트랙 관리 | 신호 연결 |
| `src/call/devices.ts` | 장치 선택과 단계적 대체 | 브라우저 API |
| `src/call/useSpeechUplink.ts` | 마이크 분할·업로드 | 기존 `AudioWindows`, `OrderedUploadQueue`, 오디오 워클릿 |
| `src/call/frameBuffer.ts` | 장면 링 버퍼와 업로드 | 없음 |
| `src/roles/*` | 훈련사·보호자 화면 | 위 모듈 |
| `server/coaching/store.ts` | 저장소 인터페이스와 파일 구현 | 파일 시스템 |
| `server/coaching/router.ts` | REST API | 저장소, 권한 |
| `server/coaching/signal.ts` | WebSocket 신호·상태 중계 | `ws` 패키지, 권한 |
| `server/coaching/note-service.ts` | 일지 생성과 재시도 | LLM 제공자, 일지 검증 |
| `server/coaching/scene-service.ts` | 장면 관찰 생성 | LLM 제공자 |
| `server/ai/speech/*` | 전사 제공자 | 실행기 또는 원격 API |
| `server/ai/llm/*` | LLM 제공자 | `llama-server` 또는 원격 API |
| `server/ai/gpu-scheduler.ts` | GPU 사용 순서 | 제공자 |
| `server/turn.ts` | 환경 변수에서 ICE 서버 구성 | 없음 |
| `scripts/setup-models.ps1` | D 드라이브 설치와 해시 검증 | curl |
| `scripts/demo-tunnel.mjs` | 빌드, 터널, 서버 실행 | cloudflared |
| `scripts/score.ts` | 점수판 측정 | 제공자, 골든 자료 |

제공자 인터페이스:

```ts
type SpeechProvider = {
  name: string;
  prepare(): Promise<void>;
  transcribe(wav: Buffer, signal?: AbortSignal): Promise<{ text: string; latencyMs: number }>;
  release(): Promise<void>;
};
type LlmProvider = {
  name: string;
  supportsVision: boolean;
  structured<T>(request: { schema: z.ZodType<T>; system: string; user: unknown; images?: Buffer[]; signal?: AbortSignal }): Promise<T>;
  release(): Promise<void>;
};
```

구현체는 `whisper-server`, Cohere Transcribe, `llama-server`, CI용 `stub`, 7단계의 Workers AI다. 제공자 교체는 환경 변수로 한다.

## 5. 데이터 모델

```ts
type Speaker = 'guardian' | 'trainer';
type CoachingCase = { id: string; petName: string; guardianName: string; trainerName: string; createdAt: string; inviteHash: string; inviteExpiresAt: string };
type Consultation = { id: string; caseId: string; state: 'scheduled' | 'live' | 'processing' | 'review' | 'approved' | 'interrupted'; recording: boolean; consent: Record<Speaker, boolean>; startedAt?: string; durationMs: number; segments: Segment[]; moments: Moment[]; frames: FrameRef[]; scenes: Scene[]; note?: CoachingNote; recordingGaps: { startMs: number; endMs: number }[]; errors: { code: string; message: string }[] };
type Segment = { id: string; speaker: Speaker; sequence: number; startMs: number; endMs: number; text: string; originalText: string; state: 'queued' | 'processing' | 'complete' | 'failed'; echoSuspect?: boolean; model?: string; latencyMs?: number };
type Moment = { id: string; atMs: number; createdBy: Speaker; text?: string; frameIds: string[] };
type FrameRef = { id: string; atMs: number; source: 'camera' | 'screen'; speaker: Speaker; bytes: number };
type Scene = { id: string; frameIds: string[]; observations: { id: string; text: string; originalText: string; reviewed: boolean }[]; state: 'queued' | 'processing' | 'complete' | 'failed' };
type TaskLog = { id: string; caseId: string; taskId: string; at: string; status: 'done' | 'partial' | 'skipped'; text?: string };
```

기존 보호자 기록 타입은 유지하고 저장 위치만 서버 사례 아래로 옮긴다. 시간은 모두 상담 기록 시작 기준 밀리초다.

`Store`는 사례·상담·프레임·보호자 기록의 읽기와 원자적 쓰기만 제공한다. 파일 구현은 기존 `ConsultationStore`의 임시 파일 후 교체 방식을 재사용한다. 저장 위치는 `D:\hanggo\data`다.

## 6. API

REST는 `/api/coaching` 아래에 둔다. 모든 입력은 Zod로 검증한다.

| 메서드와 경로 | 역할 | 설명 |
|---|---|---|
| `POST /cases` | 훈련사 | 사례와 초대 링크 생성 |
| `POST /cases/:id/invite` | 훈련사 | 초대 재발급, 기존 보호자 세션 무효화 |
| `DELETE /cases/:id` | 훈련사 | 사례와 그 아래 전사, 사진, 일지, 보호자 기록 삭제. 진행·정리 중이면 거부 |
| `POST /join` | 공개 | 초대 토큰을 보호자 세션으로 교환 |
| `GET /cases`, `GET /cases/:id` | 훈련사, 해당 보호자 | 역할별 투영 응답 |
| `POST /cases/:id/consultations` | 훈련사 | 상담 시작, 전사 모델 준비 |
| `POST /consultations/:id/consent` | 참가자 | 본인 동의·철회 |
| `GET /consultations/:id/ice` | 참가자 | ICE 서버와 TURN 자격 증명 |
| `PUT /consultations/:id/audio/:sequence` | 참가자 | 본인 음성 구간 업로드, 화자는 세션에서 결정 |
| `PUT /consultations/:id/frames/:frameId` | 참가자 | 본인 장면 업로드 |
| `POST /consultations/:id/moments` | 참가자 | 캐치 생성 |
| `POST /consultations/:id/end` | 훈련사 | 종료와 후처리 시작 |
| `PATCH /consultations/:id/segments/:id` | 훈련사 | 전사 수정 |
| `PATCH /consultations/:id/scenes/:id` | 훈련사 | 장면 관찰 수정·검토 |
| `POST /consultations/:id/note` | 훈련사 | 일지 초안 재생성 |
| `PUT /consultations/:id/note` | 훈련사 | 일지 수정 |
| `POST /consultations/:id/approve` | 훈련사 | 확정 |
| `GET /consultations/:id/delivery` | 해당 보호자, 훈련사 | 확정본과 과제만 반환 |
| `GET /cases/:id/brief` | 훈련사 | 브리핑 |
| `POST /cases/:id/task-logs` | 해당 보호자 | 과제 수행 기록 |

WebSocket은 `/api/coaching/consultations/:id/signal`이다. 세션 쿠키와 Origin을 검사한다. 메시지는 64KB 이하로 제한한다.

| 메시지 | 방향 | 용도 |
|---|---|---|
| `hello`, `ping`, `pong` | 양방향 | 서버 시각 동기화 |
| `offer`, `answer`, `candidate` | 상대에게 중계 | WebRTC 협상 |
| `state` | 서버에서 양쪽으로 | 참가자, 동의, 기록, 상담 상태 |
| `caption` | 서버에서 양쪽으로 | 확정된 전사 구간 |
| `moment` | 서버에서 양쪽으로 | 캐치 알림과 장면 업로드 요청 |
| `error` | 서버에서 해당 참가자로 | 복구 안내 |

## 7. 권한

서버가 강제한다. 화면에서 숨기는 것만으로 처리하지 않는다.

| 자원 | 훈련사 | 보호자 |
|---|---|---|
| 사례 생성, 초대 재발급, 상담 시작·종료 | 가능 | 불가 |
| 브리핑 | 가능 | 불가 |
| 통화, 자막, 캐치, 본인 동의 | 가능 | 해당 사례만 |
| 전사 수정, 장면 관찰, 일지 초안 | 가능 | 불가 |
| 확정 일지와 과제 | 가능 | 해당 사례만 |
| 근거 장면 | 전체 | 확정본이 인용한 장면만 |
| 과제 수행 기록 작성 | 읽기만 | 해당 사례만 |
| 체벌·강압 검토 표시 | 가능 | 불가 |

초대 토큰은 256비트 난수이며 해시만 저장한다. 유효 기간은 7일이다. 첫 교환 때 보호자 세션 쿠키로 바꾸고 재사용을 막는다. 새 기기는 훈련사가 재발급한다. 세 번째 참가자는 거부한다. 같은 역할의 재접속은 이전 연결을 대체한다.

## 8. 통화

- 1:1 P2P WebRTC다. 두 명뿐이므로 SFU를 쓰지 않는다. 협상은 perfect negotiation 패턴으로 하고 훈련사를 impolite로 둔다.
- ICE는 인증된 참가자에게만 서버가 준다. `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL`이 있으면 함께 내리고, 없으면 `stun.cloudflare.com`만 쓰며 화면에 "다른 네트워크에서 연결이 실패할 수 있음"을 표시한다. ExpressTURN 무료는 고정 자격 증명이라 브라우저에 전달되므로 참가자 인증 뒤로 제한하고, 유출 시 대시보드에서 갱신한다. 중계되어도 미디어는 DTLS-SRTP로 암호화된다.
- ExpressTURN 무료는 포트 3478만 제공한다. 이 포트를 막는 회사망에서는 중계도 실패할 수 있으며 이때 원인을 화면에 안내한다.
- 장치: 영상+음성, 음성만, 영상만, 수신만의 순서로 대체한다. 카메라가 없는 이 PC도 입장할 수 있어야 한다. 수신용 transceiver를 항상 만든다.
- 조작: 음소거, 카메라 끄기, 장치 선택, 전후면 전환(`replaceTrack`), 나가기. 원격 음성 자동 재생이 막히면 "소리 켜기"를 표시한다.
- 화면 공유: `getDisplayMedia`로 전체 화면·창·탭을 모두 허용한다. `systemAudio: 'include'`, `monitorTypeSurfaces: 'include'`, `surfaceSwitching: 'include'`를 요청한다. Windows Chrome의 전체 화면 공유는 사용자가 선택하면 시스템 소리도 전달된다. 공유 트랙은 카메라와 별도 트랙으로 보낸다. 공유 중에도 카메라는 유지한다. 모바일 지원은 미확인이며, 미지원이면 버튼을 숨긴다.
- 화면 배치: 훈련사 화면은 보호자 영상이 크게, 보호자 화면은 훈련사 영상이 크게, 공유가 있으면 공유가 가장 크다. 본인 화면은 작게 둔다.
- 재연결: `disconnected`가 5초 이상이면 ICE restart, WebSocket은 지수 백오프로 재접속한다. 양쪽에 상태를 표시한다. 재연결 후 기록은 같은 시간축으로 이어지고 끊긴 구간은 `recordingGaps`에 남긴다.
- 연결 상태 표시는 `getStats` 값(수신 프레임, 수신 오디오, 왕복 시간, 중계 여부)을 쓴다. E2E도 이 표시를 읽어 별도 테스트 훅을 만들지 않는다.

## 9. 실시간 기록

- **화자:** 각 참가자 브라우저가 자기 마이크만 전사용으로 올린다. 화자는 업로드한 세션의 역할이다. 화자 추정 모델을 쓰지 않는다.
- **분할:** 기존 10초 고정 구간은 단어 경계 누락이 관측됐다. 침묵 지점을 우선해 3~8초로 자르고 15초를 넘기지 않는다. 무음 구간은 업로드하지 않는다. Whisper의 무음 환각과 Cohere의 소음 환각 때문에 이 게이트는 필수다.
- **시간 동기화:** `hello`의 서버 시각과 왕복 3회 중 최소 RTT로 시계 차이를 구한다. 구간 시각은 상담 기록 시작 기준으로 변환한다. 약 1초 단위 근거로만 표시한다.
- **에코:** 상대 음성이 마이크로 다시 들어올 수 있다. 3초 이내 상대 구간과 문자 유사도가 높으면 `echoSuspect`로 표시하고 일지 근거에서 뺀다. 원문은 보존한다.
- **장면:** 자기 브라우저의 원본 트랙에서 1초마다 640×360 JPEG를 만들어 메모리 링 버퍼에 10초분 유지한다. 256KB를 넘으면 품질을 낮춘다. 동의 전에는 만들지 않는다.
- **업로드:** 보호자 카메라는 30초마다 1장 올린다. 캐치가 생기면 양쪽 모두 버튼 시점 기준 5초 전부터 2초 후까지 최대 8장을 올린다. 공유 화면은 개인 정보가 비칠 수 있어 캐치 때만 저장한다. 훈련사 카메라는 캐치 때만 저장한다.
- **GPU 순서:** 통화 중에는 전사 모델만 GPU에 올린다. 종료 후 전사 모델을 내리고 장면 분석, 일지 생성 순으로 LLM을 쓴다. 8GB에 동시 적재하지 않는다. PC 구성은 동시에 상담 1건만 받는다.
- **후처리 실패:** AI가 실패해도 통화는 끊지 않는다. 실패 구간은 숨기지 않고 표시한다. 상담 시간 상한은 60분을 유지한다.

## 10. 상담일지

현재 일지는 `validateConsultationNote`가 항목 문장과 원문 인용의 정확한 일치를 요구해 사실상 문장 분류다. 이를 개발가이드 §7.2의 `text` + 근거 구조로 바꾼다. LLM은 정리자이며, 문장은 쓸 수 있지만 근거 없는 사실은 만들 수 없다.

```ts
type Evidence = { kind: 'segment' | 'moment' | 'scene'; id: string; quote: string; startMs: number; endMs: number; speaker?: Speaker };
type Claim = { id: string; text: string; evidence: Evidence[]; edited?: boolean };
type BehaviorEntry = { id: string; title: string; context: Claim[]; behavior: Claim[]; response: Claim[]; unknown: ('trigger' | 'frequency' | 'duration' | 'response')[] };
type CoachingTask = { id: string; text: string; who: string | null; frequency: string | null; until: string | null; successCriteria: string | null; evidence: Evidence[] };
type CoachingNote = { version: 2; summary: Claim[]; concerns: Claim[]; behaviors: BehaviorEntry[]; guardianReports: Claim[]; trainerObservations: Claim[]; aiObservations: Claim[]; guidance: Claim[]; tasks: CoachingTask[]; followUps: Claim[]; safetyFlags: string[]; methodReview: boolean; uncitedSegmentIds: string[]; createdAt: string; approvedAt?: string; fallbackUsed?: boolean; warnings: string[] };
```

### 코드 검증

1. 스키마를 통과해야 한다. `llama-server`의 JSON 스키마 제약을 쓰고, 근거 ID는 실제 ID 목록으로 제한한다.
2. 모든 문장에 근거가 1개 이상 있어야 한다. `quote`는 원문의 부분 문자열이고 시각은 원문과 일치해야 한다.
3. 문장의 숫자는 근거에 있어야 한다. "세 번"과 "3번", "오십 그램"과 "50g"처럼 한국어 수사는 정규화해 비교한다.
4. 문장의 이름은 근거 또는 사례 정보에 있어야 한다.
5. 화자 규칙: `guardianReports`는 보호자 구간, `guidance`는 훈련사 구간, `aiObservations`는 장면만 근거로 쓴다. `tasks`는 훈련사 구간 근거가 필수다.
6. 금지 표현은 `notes.ts`와 개발가이드 §3.6 규칙을 쓴다. 안전 신호는 규칙과 LLM의 OR이며 LLM이 해제할 수 없다. 안전 신호가 있으면 과제보다 동물병원 안내를 먼저 표시한다.
7. 과제의 담당·횟수·기한은 근거에 없으면 `null`로 두고 "미확인"으로 표시한다.
8. 체벌·강압 언급은 `methodReview`로 표시하고 보호자 전달본에서 뺀다.

검증 실패 항목은 사유를 붙여 그 문장만 1회 다시 묻고 맞던 내용에 더한다. 그래도 실패하면 그 항목을 버리고 경고를 남긴다. 전체 실패 시 빈 양식과 전체 전사를 표시한다. `uncitedSegmentIds`로 일지에 쓰이지 않은 발화를 보여 주어 조용히 사라지는 내용이 없게 한다.

### 긴 상담

말한 양 기준 약 5분(1,500자) 단위로 나눠 근거 ID가 붙은 항목을 추출하고, 추출 항목만 입력으로 통합한다. 각 부분은 앞 부분의 끝을 함께 읽고, 합칠 때 같은 줄을 다시 정리한 문장을 합친다. 통합 단계도 근거 ID를 유지한다. 전체 전사를 한 번에 넣지 않는다. 15분 단위는 30분 상담에서 사실의 5분의 1, 과제의 3분의 1을 잃어 줄였다.

### 장면 관찰

종료 후 캐치와 30초 간격 장면을 최대 3장 단위로 분석한다. 프롬프트는 `consultation-vision.ts`의 "보이는 것만" 규칙을 유지한다. 최초 결과와 수정본을 함께 보존한다. 훈련사가 검토한 관찰만 확정본에 들어간다. "지금", "방금", "보세요" 같은 발화 시점도 장면 후보로 추가한다.

### 검토 화면

전사를 왼쪽, 일지를 오른쪽에 둔다. 항목을 누르면 근거 발화가 강조되고 근거 장면 사진이 보인다. 시각은 영상 이동이 아니라 전사와 사진으로 연결한다.

## 11. 코칭 순환

- 보호자 기록과 과제 수행은 사례 아래 서버에 저장한다. 현재 `localStorage` 방식은 이 흐름에서 쓰지 않는다.
- 사례 ID가 있으므로 지난 상담을 이름으로 추정하지 않는다. 브리핑은 같은 사례의 최신 확정 상담을 자동으로 쓴다.
- 브리핑은 기존 3줄 + 상세 근거 구조와 `src/domain/brief.ts`의 코드 집계를 재사용하고, 지난 과제와 수행 기록을 입력에 더한다.
- 보호자 음성 입력은 전사 제공자를 함께 쓴다. CPU medium 경로는 제거한다.

## 12. 제거와 축소

- 제거: `MediaRecorder`, WebM 업로드, `server/consultation-media.ts`, 녹화 재생·다운로드, FFmpeg 장면 추출, 탭 전용 입력, `recordingChunkCount`. 인계 가이드 §3.2의 WebM 헤더 오류 경로도 함께 사라진다. 원인이 규명된 것은 아니다.
- 교체: `server/ollama.ts`, `server/local-speech.ts`, `server/local-model.ts`, `server/live-speech.ts`는 제공자 구현으로 옮긴다. `scripts/setup-local*.ps1`, `setup-speech-candidates.ps1`은 `setup-models.ps1`로 합친다.
- 플래그로 끔: 보호소 프로필, 레슨 후보. 코드는 유지한다.
- 공개 체험판: 5단계에서 자동 시연 영상 페이지로 바꾼다.

기존 상담 데이터의 이전은 하지 않는다. 이 PC에는 이전할 `.local-data`가 없다.

## 13. 모델과 D 드라이브

```text
D:\hanggo\
├─ runtime\   llama.cpp, transcribe.cpp, whisper.cpp, cloudflared
├─ models\    stt, llm
├─ data\      사례, 상담, 장면
├─ cache\     다운로드, 측정 결과
└─ secrets.env
```

모든 실행 파일과 모델은 URL, 크기, SHA-256을 고정해 받는다. 저장소 설정은 `HANGGO_HOME`으로 이 위치를 찾는다.

| 역할 | 1순위 후보 | 비교군 |
|---|---|---|
| 전사 | Cohere Transcribe 03-2026 Q8_0 (2.41GB, FLEURS 한국어 CER 6.57%) | Whisper large-v3-turbo(현 기준선), Qwen3-ASR 1.7B |
| 일지·브리핑·장면 | Qwen3.8-27B Q4_K_M (17.44GB + mmproj 0.93GB, Apache 2.0) | HyperCLOVA X SEED Think 14B(`naver-ellm` GGUF, 자체 라이선스 확인 필요), Gemma 4 12B, Qwen3.5-9B(현 기준선) |
| 빠른 장면 비교 | Gemma 4 E4B | MiniCPM-V 4.6 |

EXAONE 4.5는 비상업 라이선스라 제외한다.

### 선정 방법

공개 순위는 한국어 대화 품질을 보장하지 않는다. 이 PC에서 직접 측정해 결정한다.

- 전사 자료: 공개 한국어 음성셋, 반려동물 용어·이름·숫자 합성 문장, 사용자가 원하면 본인 음성. `scripts/compare-speech.ts`를 확장한다.
- 전사 기준: 문자 오류율이 가장 낮고, 이름·숫자·부정 표현 재현율이 기준선 이상이며, 구간 처리 시간이 구간 길이의 1/3 이하다. 두 사람 음성을 번갈아 처리할 여유를 뜻한다.
- LLM 자료: §17의 골든 대화.
- LLM 기준: 근거 없는 주장 0건을 먼저 만족하고, 핵심 사실 재현율이 가장 높으며, 30분 상담 일지를 10분 이내에 만든다. 시간 기준은 시작값이다.
- 탈락 모델은 D 드라이브에서 지워도 된다. 결과는 `docs/llm/model-selection-2026-11.md`에 기록한다.

## 14. 실행 구성

| 구성 | 앱 | AI | 데이터 | 용도 |
|---|---|---|---|---|
| `local` | 이 PC, 루프백 | 이 PC | `D:\hanggo\data` | 개발 |
| `tunnel` | 이 PC + Cloudflare Quick Tunnel | 이 PC | `D:\hanggo\data` | 사람 시연 |
| `cloud` | Cloudflare Workers, Durable Objects | Workers AI | Durable Object SQLite | PC 꺼짐 시연 |
| CI | GitHub Actions 일회성 서버 | `stub` 또는 소형 CPU 모델 | 임시 폴더 | 자동 시연·검증 |

- GitHub Actions는 서비스 호스팅에 쓰지 않는다. 약관이 serverless 용도를 막고 프로젝트 테스트·배포·게시만 허용하기 때문이다.
- `demo:tunnel`은 cloudflared를 먼저 실행해 주소를 얻고, `PUBLIC_ORIGIN`과 `NODE_ENV=production`으로 빌드된 앱을 띄운다. Vite 개발 서버는 노출하지 않는다. 기본 4시간 후 터널을 자동으로 닫는다. 주소가 매번 바뀌므로 초대 링크도 실행 때 만든다.
- `cloud`의 한도: Workers AI 하루 10,000 neuron, 요청당 CPU 10ms(네트워크 대기 제외), Durable Object SQLite 5GB와 하루 쓰기 10만 행. Whisper turbo는 오디오 1분당 46.63 neuron, Qwen3.8-27B는 입력 100만 토큰당 40,909, 출력 100만 토큰당 290,909 neuron이다. 1시간 상담 1~2건을 추정한다. 7단계에서 실측하고 화면에 남은 한도를 표시한다.
- `cloud`는 AI가 Cloudflare를 거친다. 문서상 고객 내용을 학습에 쓰지 않지만, 실제 상담 자료는 `local` 또는 `tunnel`을 쓴다. 화면에 구성을 표시한다.

## 15. 보안과 개인정보

- `tunnel`과 `cloud`는 16자 이상 비밀번호를 필수로 한다. 현재 `server/config.ts:15`는 바인딩 주소만 검사해 터널에서 비밀번호 없이 통과한다. 0단계에서 구성값 기준 검사로 고친다.
- 인터넷 노출 전에 npm high 취약점 6건을 해결한다.
- Origin·Host 허용 목록, 로그인·초대 교환 속도 제한, 업로드 예산, WebSocket 크기·빈도 제한을 둔다. `Permissions-Policy`는 camera, microphone, display-capture를 self로만 연다.
- 비밀값은 `D:\hanggo\secrets.env`에 둔다. 저장소, 로그, 응답, 채팅에 내보내지 않는다.
- 첫 push 전에 전체 이력의 비밀값 검사를 통과해야 한다.
- 원본 음성은 디스크에 쓰지 않는다. 전사 대기 중에만 메모리에 두고 처리 후 지운다. 전사와 장면은 사례 삭제 시 함께 지운다.
- 시연·테스트 자료는 가상 이름을 쓴다. 실제 상담 자료는 Git에 넣지 않는다. 터널과 TURN을 거치므로 "데이터가 PC 밖으로 나가지 않는다"고 표현하지 않는다.

## 16. 오류 처리

| 상황 | 동작 |
|---|---|
| 권한 거부, 장치 없음 | 원인별 안내 후 가능한 트랙으로 입장 |
| 인앱 브라우저 | Chrome·Safari로 열도록 안내 |
| ICE 실패 | TURN 미설정 여부를 구분해 안내, 재시도 버튼 |
| 신호 연결 끊김 | 통화 유지, 백오프 재접속 |
| 전사 모델 준비 실패 | 통화 유지, 기록 불가 표시 |
| 전사 구간 실패 | 실패 표시, 일지에 공백 경고 |
| 서버 재시작 | 저장 구간 보존, 상담은 `interrupted`, 새 상담 안내 |
| 일지 생성 실패 | §10의 재시도와 대체 표시 |
| 카드 요구, 한도 초과 | 해당 기능 중지, 명확히 안내, 원문 보존 |

## 17. 테스트와 자동 시연

- **단위:** 상태 전이, 권한 표, 일지 검증, 수사 정규화, 시계 동기화, 침묵 분할, 링 버퍼, 에코 판정.
- **통합:** supertest와 `ws`로 초대, 역할, 동의 게이트, 업로드, 투영 응답, 브리핑.
- **E2E:** Playwright로 Chrome 인스턴스 2개를 서로 다른 launch 인자로 띄운다. `--use-file-for-fake-video-capture`와 `--use-file-for-fake-audio-capture`에 역할별 파일을 넣고 실제 서버·WebSocket·WebRTC로 연결한다.
- **AI 분리:** PR마다 `AI_PROVIDER=stub`으로 전체 시나리오를 돈다. 품질 증거로 쓰지 않는다. 수동·야간 실행은 CPU에서 Cohere Q4_K_M과 소형 LLM(Qwen3.5-4B)을 쓴다. 표준 러너는 4 CPU, RAM 16GB, SSD 14GB, GPU 없음, 작업당 6시간, 캐시 10GB다. 품질 측정의 기준은 이 PC다.
- **자동 시연:** 두 브라우저를 `recordVideo`로 녹화해 FFmpeg로 나란히 합치고 시나리오 결과와 함께 Pages `/demo/`에 게시한다. 합성 입력임을 페이지에 표시한다. 이 영상은 시연 산출물이며 제품의 녹화 기능이 아니다.
- **시연 자료:** 약 3분 가상 대화 대본, 역할별 합성 음성, 라이선스가 확인된 반려견 영상. 저장소에 20MB 이하로 둔다.
- **골든 대화:** `fixtures/coaching-dialogues/`에 화자 포함 합성 대화 10건 이상을 둔다. 기대 사실, 기대 과제, 미확인 항목, 나오면 안 되는 주장을 라벨로 단다. 부정 표현, 숫자, 체벌 언급, 안전 신호, 과제 미합의, 화자 혼동, 30분 이상 긴 상담을 포함한다.
- **사람 시연:** `docs/testing/two-way-coaching.md`에 15분 대본과 체크 시트를 둔다. 자동 결과로 대신하지 않는다.

## 18. 단계별 완료 기준

각 단계는 검증 문서를 `docs/llm/`에 남긴다. 합성 입력 결과와 실제 입력 결과를 구분한다.

| 단계 | 내용 | 통과 기준 |
|---|---|---|
| 0 | D 드라이브 설치, `llama-server`·전사 제공자, 취약점 해결, 비밀번호 검사 수정, 모델 비교 | RTX 3070에서 실모델 전사·구조화 출력 동작. 모델 선정 문서 완료. 기존 기능 테스트 통과 |
| 1 | 사례, 초대, 역할, 동의, WebSocket, 1:1 통화, 화면 공유, 장치 대체, 재연결, TURN | CI 두 브라우저가 실제 WebRTC로 양방향 영상·음성 수신. 화면 공유 전환 성공. 카메라 없는 입장 성공. 권한 위반·세 번째 참가·만료 초대 거부. TURN 키가 있으면 relay 강제 연결 통과, 없으면 미검증으로 기록 |
| 2 | 화자별 전사, 자막, 캐치, 장면 링 버퍼, 녹화 코드 제거 | 합성 대화에서 화자 라벨 100% 일치. 문자 오류율과 자막 지연 기록. 캐치 사진이 버튼 5초 전을 포함. 동의 전 업로드 0건 |
| 3 | 일지 v2, 장면 관찰, 검토 화면, 보호자 전달본 | 골든 대화에서 근거 없는 숫자·이름·과제·금지 표현 0건. 핵심 사실 재현율 85% 이상(시작값). 보호자는 초안 접근 불가 |
| 4 | 서버 보호자 기록, 과제 수행, 브리핑 연결 | 2회차 브리핑에 1회차 과제와 수행 기록이 근거와 함께 표시 |
| 5 | Actions 자동 시연 | push E2E 연속 3회 통과. 수동·야간 실모델 실행 성공. Pages에서 양쪽 화면 영상 재생 |
| 6 | 사람 시연 (`tunnel`) | PC + 휴대폰(LTE)으로 15분 대본 완주를 사용자가 확인 |
| 7 | `cloud` 구성 | PC를 끈 상태로 두 기기가 전체 흐름 완주. 무료 한도 실측. 무료 CPU 제한 등으로 불가하면 사실을 기록하고 보고 |

## 19. 점수판과 반복 규칙

`scripts/score.ts`가 아래 값을 `docs/llm/scoreboard.md`에 누적한다. 측정 환경과 합성 여부를 함께 적는다.

| 영역 | 지표 |
|---|---|
| 통화 | 연결 성공률, 연결 시간, 재연결 복구 시간, 중계 비율 |
| 전사 | 문자 오류율, 이름·숫자·행동 용어 재현율, 부정 표현 보존, 자막 지연 p95 |
| 장면 | 보이지 않는 내용 기술 수, 캐치 사진 포함률 |
| 일지 | 핵심 사실 재현율, 근거 없는 주장 수, 과제 정확도, 미확인 표시 정확도, 30분 상담 처리 시간 |
| 순환 | 다음 브리핑의 지난 과제 반영률 |
| 사람 | 훈련사 수정 없이 확정한 비율, 사용자가 입력한 시연 평가 |

7단계 이후 한 번의 반복은 다음과 같다.

1. 점수판에서 가장 낮은 지표 하나를 고른다.
2. 재현 테스트를 먼저 만든다.
3. 고친다.
4. 회귀가 없으면 브랜치에 반영하고 측정값을 기록한다.

개선 후보: 공유 화면 소리 전사, 움직임 기반 장면 후보, 훈련사 화면 드로잉, 상담 중 미확인 항목 알림, 훈련사 수정 내용을 다음 프롬프트 예시로 활용.

**멈추고 보고하는 경우:** 결제·카드 요구, 외부 서비스 신규 가입, 사람 시연 필요, 비가역 삭제, 약관 위반 소지.

작업 규칙: `feat/two-way-coaching` 브랜치에서 구현하고 단계 통과 시 `main`에 합쳐 push한다. Conventional Commits, 테스트 우선. 합성 입력 결과를 실제 검증으로 쓰지 않는다.

## 20. 사람만 가능한 일

- ExpressTURN 무료 가입과 자격 증명 입력. 값은 `D:\hanggo\secrets.env`에 넣는다.
- 휴대폰 + PC 실제 통화. 이 PC에 카메라가 없어 휴대폰이 보호자 카메라다. 같은 공간에서 하면 소리가 섞이므로 이어폰을 쓰거나 공간을 분리한다.
- 7단계의 Cloudflare 사용. 결제 정보를 요구하면 멈추고 보고한다.

## 21. 범위 밖

3인 이상 통화, 실제 행고 앱 연동, 결제, 예약·매칭, 모델 재학습, AI 진단, 자동 전송. 입양 플랜과 레슨 연결은 팀 자료가 올 때까지 보류한다.

## 22. 미검증 가정과 대안

| 가정 | 확인 시점 | 틀리면 |
|---|---|---|
| Cohere의 실제 상담 한국어가 Whisper turbo보다 낫다. FLEURS 수치는 낭독 음성 기준이다 | 0단계 | Whisper turbo 유지 |
| `transcribe.cpp`를 모델 재로딩 없이 상주 실행할 수 있다. 서버 모드는 문서에서 확인되지 않았다 | 0단계 | 바인딩 또는 얇은 상주 프로세스, 불가하면 Whisper turbo |
| Qwen3.8-27B가 VRAM 8GB + RAM 32GB에서 쓸 만한 속도를 낸다 | 0단계 | Gemma 4 12B, Qwen3.5-9B 순 |
| Quick Tunnel이 WebSocket을 지원한다. 문서는 SSE 미지원만 명시한다 | 1단계 | 커서 기반 폴링 |
| ExpressTURN 무료가 카드 없이 동작하고 한국에서 지연이 쓸 만하다. 공식 페이지는 월 1,000GB와 포트 3478만 명시한다 | 2026-11-04 확인: 카드 없이 동작, 왕복 569ms, 서버가 프랑스로 보임. 체감은 6단계 사람 시연에서 확인 | Metered 무료 검토, 없으면 P2P만 쓰고 중계는 미검증으로 표시 |
| Workers AI를 결제 정보 없이 쓸 수 있다. TURN은 결제 정보를 요구했다 | 7단계 | 사실 기록 후 보고, PC 구성 유지 |
| Fake 장치 WebRTC가 CI에서 안정적이다 | 1단계 | 재시도 대신 원인 분석, 불안정 테스트 격리 |
| 모바일 화면 공유 지원 여부 | 6단계 | PC 전용으로 표시 |
| Workers 무료 CPU 10ms로 서버 로직이 동작한다. Qwen3.8을 무료로 호출할 수 있다 | 7단계 | 사실 기록 후 보고, PC 구성 유지 |

## 근거

- [Cohere Transcribe GGUF](https://huggingface.co/handy-computer/cohere-transcribe-03-2026-gguf), [transcribe.cpp](https://github.com/handy-computer/transcribe.cpp)
- [Qwen3.8-27B GGUF](https://huggingface.co/bartowski/Qwen3.8-27B-GGUF), [HyperCLOVA X SEED Think 14B](https://huggingface.co/naver-hyperclovax/HyperCLOVAX-SEED-Think-14B)
- [ExpressTURN](https://www.expressturn.com/), [Open Relay](https://www.metered.ca/tools/openrelay/), [Quick Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
- [Workers 제한](https://developers.cloudflare.com/workers/platform/limits/), [Durable Objects 요금](https://developers.cloudflare.com/durable-objects/platform/pricing/), [Workers AI 요금](https://developers.cloudflare.com/workers-ai/platform/pricing/), [데이터 사용](https://developers.cloudflare.com/workers-ai/platform/data-usage/)
- [GitHub Actions 약관](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features), [Runner 사양](https://docs.github.com/en/actions/reference/runners/github-hosted-runners), [Actions 제한](https://docs.github.com/en/actions/reference/limits)
