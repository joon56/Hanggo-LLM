<div align="center">

# 행고 · Hanggo

### 대화의 끝에서, 기록의 시작.

보호자의 일상 기록부터 상담일지와 보호소 프로필까지, 원문 근거로 연결합니다.

[![CI](https://github.com/joon56/Hanggo-LLM/actions/workflows/ci.yml/badge.svg)](https://github.com/joon56/Hanggo-LLM/actions/workflows/ci.yml)
![Node.js 24](https://img.shields.io/badge/Node.js-24_LTS-405438?style=flat-square)
![React](https://img.shields.io/badge/React-19-405438?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-7-405438?style=flat-square)
![OpenAI](https://img.shields.io/badge/OpenAI-Text_%2B_Voice-405438?style=flat-square)

[공개 체험판](https://joon56.github.io/Hanggo-LLM/) · [빠른 시작](#빠른-시작) · [테스트 가이드](docs/testing/manual-testing.md) · [배포 안내](docs/testing/deployment.md)

</div>

![행고 상담노트 데스크톱 화면](docs/assets/desktop.png)

## 상담 이후의 기록을 돕습니다

훈련사의 상담 후 요약을 음성 또는 텍스트로 받아 원문 근거가 있는 일지로 정리합니다. OpenAI 받아쓰기와 일지 추출을 분리하며, 훈련사가 검토·승인한 기록만 이 브라우저에 저장합니다.

**A·B-1·B-2·C를 하나의 기록 공간에서 테스트할 수 있습니다.** 현재 저장은 개인 브라우저 기준입니다. Firebase·Android 원본 앱, 사용자별 권한·공유 저장소, 보호자 자동 전송, 상담 전체 녹취는 별도 연결이 필요합니다.

| 기능 | 동작 |
|---|---|
| 음성 입력 | 3~60초 녹음, 다시 듣기, 받아쓰기, 원문 확인 |
| 텍스트 입력 | 최대 8,000자 요약에서 근거 구절 추출 |
| 다섯 가지 분류 | 보호자 보고 · 훈련사 관찰 · 안내 · 합의한 과제 · 추가 확인 |
| 검토와 승인 | 항목별 원문 확인, 직접 수정, 위험 신호 확인 |
| 기록 보관 | 승인 후 브라우저 저장, 재열람, JSON 내보내기, 삭제 |
| A · 보호자 일상 기록 | 반려동물·별명 등록, 음성/텍스트를 사건별로 추출, 시각·유형·원문 검토 후 저장 |
| B-1 · 상담 전 브리핑 | 최근 14일/직전 14일 사실표, 근거 링크, 기록 부족 표시, 이전 상담 과제 |
| B-2 · 상담일지 | 음성 요약→받아쓰기 확인→일지 승인, 실제 카탈로그의 조건에 맞는 레슨 연결 |
| C · 보호소 프로필 | 날짜·작성자 역할이 있는 메모→사회성·좋아하는 것·주의사항·입양 소개, 담당자 승인 |

레슨은 실제 카탈로그 파일을 연결해야 표시됩니다. 데이터가 없으면 추천하지 않습니다. 브리핑 수치는 코드로 계산하며 AI가 선택한 근거 ID를 검증합니다. 기록이 부족하면 변화 판단을 생략합니다.

<details>
<summary><strong>모바일 검토 화면 보기</strong></summary>
<br>
<img src="docs/assets/mobile.png" alt="모바일에서 원문과 안전 신호를 검토하는 화면" width="360">

</details>

화면은 가상 상담 자료를 사용한 데모입니다. 실제 OpenAI 호출에는 서버의 API 키가 필요합니다.

**[공개 체험판 열기 →](https://joon56.github.io/Hanggo-LLM/)**

설치 없이 텍스트 정리·녹음과 재생·원문 검토·승인·저장·JSON 내보내기를 체험합니다. GitHub Pages 체험판에는 AI 생성과 받아쓰기가 없습니다. 실제 AI를 사용하려면 아래 Node/Docker 서버를 배포합니다.

## 빠른 시작

Node.js **24 LTS**, npm, **FFmpeg(ffmpeg와 ffprobe)**가 필요합니다. Windows에서는 설치한 FFmpeg의 bin 폴더를 PATH에 추가합니다. ffprobe는 서버에서 실제 음성 길이를 검사합니다.

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1
```

생성된 `.env`를 편집합니다. 설치 스크립트는 기존 `.env`를 덮어쓰지 않습니다.

```dotenv
OPENAI_API_KEY=발급받은_API_키
AI_ENABLED=true
FEATURE_OWNER_LOG_ENABLED=true
FEATURE_BRIEF_ENABLED=true
FEATURE_SHELTER_ENABLED=true
```

키는 로컬 `.env` 또는 서버 비밀값 저장소에만 넣으세요. `VITE_` 접두사나 프론트엔드 코드에 넣지 않습니다. AI 기본값은 꺼짐이며 키가 없어도 로컬 규칙 분류를 사용할 수 있습니다.

```powershell
npm.cmd run dev
```

접속: **http://127.0.0.1:5173/**. 한 명령으로 API 서버(3001)와 화면(5173)을 실행합니다. 종료는 Ctrl+C. `scripts/start.ps1`도 제공합니다.

## 사용 흐름

1. 가상의 반려동물·훈련사 이름과 상담 날짜를 입력합니다.
2. AI 사용 시 외부 음성·텍스트 처리 안내를 읽고 동의합니다.
3. 텍스트는 직접 입력하거나 예시를 불러온 뒤 일지를 생성합니다.
4. 음성은 **3~60초 녹음 → 다시 듣기 → 받아쓰기 → 원문 수정·확인 → 일지 생성** 순서입니다.
5. 원문 근거·분류·숫자를 확인합니다. 직접 수정한 항목은 표시되며 위험 신호가 있으면 과제 승인을 제한합니다.
6. 검토 체크 후 승인합니다. 새로고침 후 재열람, JSON 다운로드, 삭제까지 확인합니다.

실패 시 원문을 보존하고 수동 검토로 이어집니다. 수동 대체는 AI 성공으로 표시하지 않습니다. 처리 중 입력 변경·새 기록·취소 시 오래된 응답은 적용하지 않습니다.

- [직접 테스트 절차와 예문 30개](docs/testing/manual-testing.md)
- [결과 기록 CSV](docs/testing/results-template.csv)
- 원본 테스트 자료: `fixtures/session-notes.json`
- [A·B-1·B-2·C 테스트 흐름과 설정](docs/testing/workspace-testing.md)

## 자동 검증과 실제 평가

```powershell
npm.cmd test
npm.cmd run build
npm.cmd run test:e2e
npm.cmd run llm:eval
npm.cmd run llm:eval:workspace
```

`llm:eval` 기본 실행은 **자료 형식 검증만** 합니다. 실제 API 호출은 실행 중인 서버에 아래 명령으로 요청하며 비용이 발생합니다.

```powershell
npm.cmd run llm:eval -- --live --case N01
npm.cmd run llm:eval -- --live
npm.cmd run llm:eval -- --live --case N01 --audio-dir test-audio
```

음성 파일은 `test-audio/N01.wav`처럼 사례 ID와 같은 이름으로 준비합니다. WebM, MP4, WAV, MP3 지원. 전체 음성 평가에는 N01~N30 파일이 각각 하나 필요합니다. 서버가 실제 길이를 검사하며 인코더 패딩 때문에 최대 60.5초까지 허용합니다. 받아쓰기 핵심어 검사는 보조 지표이므로 표기 차이·의미 누락은 직접 확인하세요.

평가 결과는 `test-output/` JSON에 저장됩니다. 원문·받아쓰기·초안이 포함되므로 가상 자료를 사용하고 보관을 관리하세요. 실패 시 종료 코드 1. 비밀번호가 설정된 서버는 `.env`의 `APP_ACCESS_PASSWORD`로 로그인합니다. 원격 평가에는 `--base-url https://도메인`과 해당 서버의 `PUBLIC_ORIGIN`을 사용합니다.

전체 검증: `npm.cmd run verify` 또는 `scripts/verify.ps1`. Playwright는 설치된 Chrome, 가상 오디오와 모의 API를 사용합니다. 실제 키·비용 없이 화면을 확인하며 실제 STT·LLM 품질을 입증하지는 않습니다.

A·B-1·C 실제 평가도 제공합니다. 서버 실행 없이 `.env`를 읽어 서비스 로직과 OpenAI를 직접 호출합니다. `--live`에만 비용이 발생합니다.

```powershell
npm.cmd run llm:eval:workspace -- --feature owner --case bark-delivery --live
npm.cmd run llm:eval:workspace -- --feature brief --live
npm.cmd run llm:eval:workspace -- --feature shelter --live
npm.cmd run llm:eval:workspace -- --feature owner --case bark-delivery --live --audio-dir test-audio
```

보호자 음성 파일 예: `test-audio/bark-delivery.wav`. 기본 실행은 52개 자료의 스키마와 수동 계산을 검사합니다. 실제 모델 품질 검증과 구분됩니다.

## 처리와 저장

- 기본 모델: 텍스트 `gpt-4.1-mini`, 음성 `gpt-4o-mini-transcribe`. 환경변수로 변경 가능합니다. 텍스트 모델은 Responses API, Structured Outputs, temperature를 지원해야 합니다. 모델 변경 후 실제 평가를 다시 수행하세요.
- AI는 원문의 정확한 구절을 추출·분류합니다. 새로운 사실·조언·레슨을 만들지 않습니다. 인용·분류·숫자·안전 신호를 서버와 승인 단계에서 검사합니다.
- 형식·근거 검증 실패는 한 번 재생성합니다. 계속 실패하거나 공급사 요청이 실패하면 원문 기반 수동 검토 초안을 제공합니다.
- 전화번호·이메일·일부 주소 패턴은 텍스트 전송 전 마스킹합니다. 모든 개인정보를 탐지하지는 못합니다. **음성은 원본이 STT 공급사로 전송됩니다.**
- 서버는 음성을 디스크에 저장하지 않습니다. 브라우저 녹음은 교체·삭제·새 기록·승인·페이지 종료 시 해제됩니다. 공급사의 처리·보존 정책은 별도입니다.
- Responses에는 `store:false`를 사용합니다. 공급사의 모든 보존을 없애는 설정은 아닙니다. [OpenAI 데이터 처리 안내](https://developers.openai.com/api/docs/guides/your-data)를 확인하세요.
- 승인 기록은 `localStorage`의 `hanggo:approved-notes`에 최대 50개 보관합니다. 기존 데모 기록도 읽습니다. 서버 동기화·암호화·자동 백업은 없습니다. 도메인·포트가 바뀌면 별도 저장소입니다.
- 보호자 일상 기록 최대 100건, 보호소 승인 프로필 최대 50건도 별도 로컬 저장소에 보관합니다. 브리핑·레슨 연결 결과는 JSON으로 내보낼 수 있습니다.
- 로그인은 API 접근을 제한합니다. 브라우저 자료 자체를 암호화하거나 같은 기기의 사용자를 격리하지 않습니다. 개인 브라우저를 사용하고 JSON으로 백업하세요. JSON은 내보내기 전용입니다.
- 로그에는 요청 ID·모델·처리 시간·수동 대체 여부만 남깁니다. 원문·음성·키를 기록하지 않습니다.

## 배포

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/joon56/Hanggo-LLM)

`render.yaml`로 **화면 + Node API + FFmpeg**를 함께 배포합니다. 버튼은 배포 생성 화면으로 이동하며, 이미 운영 중인 서비스 주소가 아닙니다. 저장소 업로드 후 Render 계정을 연결해야 합니다.

- 기본 구성: Singapore, Free 인스턴스, HTTPS, 자동 생성 접근 비밀번호, AI 꺼짐.
- 배포 후 Render의 Environment에 `OPENAI_API_KEY`를 추가하고 `AI_ENABLED=true`로 바꿉니다.
- 새 기능은 각각 `FEATURE_OWNER_LOG_ENABLED`, `FEATURE_BRIEF_ENABLED`, `FEATURE_SHELTER_ENABLED`를 `true`로 설정합니다. 세 기능 모두 기본값은 꺼짐입니다.
- 발급된 HTTPS 주소와 접근 비밀번호를 테스트할 사람에게 전달합니다. 기록은 각 브라우저에 따로 저장됩니다.
- 무료 인스턴스는 유휴 시 중지되므로 첫 접속이 늦을 수 있습니다. 상시 운영에는 유료 인스턴스를 검토하세요. [Render 무료 인스턴스 안내](https://render.com/docs/free)

자세한 설정·검증은 [Render 배포 절차](docs/testing/deployment.md#render로-공개-배포)를 참고하세요.

### 로컬에서 배포 빌드 확인

```powershell
npm.cmd run build
npm.cmd start
```

화면과 API를 같은 서버에서 제공합니다. 로컬 빌드 확인: **http://127.0.0.1:3001/**. 공개 배포에는 HTTPS 역방향 프록시와 운영자 비밀번호가 필요합니다. [Node와 Docker 배포 절차](docs/testing/deployment.md)를 참고하세요.

기본 제한: 일일 요청 200건, 분당 30건, 동시 2건. 단일 프로세스 메모리 기준이며 재시작 시 초기화됩니다. 공급사 프로젝트의 사용 한도도 설정하세요. 다중 사용자 인증·공유 저장·분산 요청 제한은 별도 확장 범위입니다.

## 주요 파일

| 경로 | 역할 |
|---|---|
| `server/app.ts` | 인증·출처·입력·요청 제한과 HTTP 라우트 |
| `server/audio.ts` | 실제 음성 길이 검사 |
| `server/openai.ts` | OpenAI 받아쓰기와 구조화 추출 |
| `server/service.ts` | 마스킹·근거 검증·재생성·수동 대체 |
| `src/domain/notes.ts` | 초안·안전·승인 규칙 |
| `src/domain/storage.ts` | 승인 기록 저장·호환성 |
| `src/api.ts` | 브라우저 API 호출과 무음 검사 |
| `src/App.tsx` | 입력·검토·승인·비동기 상태 |
| `scripts/eval.ts` | 실제 API 텍스트·음성 평가 |
| `scripts/eval-workspace.ts` | A·B-1·C 자료·실모델·보호자 음성 평가 |
| `server/owner-service.ts` | 보호자 사건 추출·원문·숫자·안전 검증 |
| `server/brief-service.ts` | 코드 사실표와 AI 근거 ID 선택 |
| `server/shelter-service.ts` | 관찰 추출·주의사항 보존·프로필 생성 |
| `server/lessons.ts` | 실제 레슨 카탈로그 로딩·검증 |

개발가이드와 과거 작업 기록은 그대로 보존합니다. 현재 확인 결과와 미검증 항목은 [검증 보고서](docs/llm/openai-verification.md)에 정리합니다.

---

<div align="center">
<strong>말하고, 확인하고, 기록으로 남기세요.</strong><br>
행고 · 우리아이 행동고민
</div>
