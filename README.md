<div align="center">

# 행고 · Hanggo

### 대화의 끝에서, 기록의 시작.

보호자의 일상 기록부터 상담일지와 보호소 프로필까지, 원문 근거로 연결합니다.

[![CI](https://github.com/joon56/Hanggo-LLM/actions/workflows/ci.yml/badge.svg)](https://github.com/joon56/Hanggo-LLM/actions/workflows/ci.yml)
![Node.js 24](https://img.shields.io/badge/Node.js-24_LTS-405438?style=flat-square)
![React](https://img.shields.io/badge/React-19-405438?style=flat-square)
![Local AI](https://img.shields.io/badge/llama.cpp_%2B_Qwen3--ASR-Local_AI-405438?style=flat-square)

[실제 모델 시연](https://joon56.github.io/Hanggo-LLM/demo/real/) · [자동 시연 영상](https://joon56.github.io/Hanggo-LLM/demo/) · [공개 체험판](https://joon56.github.io/Hanggo-LLM/) · [빠른 시작](#빠른-시작) · [브리핑 시연](docs/testing/consultation-brief.md) · [화상 코칭 시연](docs/testing/two-way-coaching.md) · [기존 기능 시연](docs/testing/beta-test-script.md)

</div>

![행고 상담노트 데스크톱 화면](docs/assets/desktop.png)

## 무엇을 할 수 있나요?

보호자와 훈련사가 각자 기기에서 링크로 접속해 화상 코칭을 합니다. 기록 초안은 이 PC의 llama.cpp `Gemma 4 12B`로 만들고, 음성은 `Qwen3-ASR`로 전사합니다. 초안은 원문 근거와 함께 사람이 검토합니다.

상담이 끝나면 전사와 장면으로 근거 달린 일지 초안을 만들고, 훈련사가 확정한 내용만 보호자에게 갑니다. 보호자의 과제 기록은 다음 상담 브리핑으로 이어집니다. [자동 시연 영상](https://joon56.github.io/Hanggo-LLM/demo/)에서 두 사람의 화면을 나란히 볼 수 있습니다. 합성 입력으로 흐름을 보여 주는 영상입니다. [설계](docs/superpowers/specs/2026-11-03-two-way-coaching-design.md) · [점수판](docs/llm/scoreboard.md)

| 기능 | 흐름 |
|---|---|
| **쌍방향 화상 코칭** | 사례 생성 → 초대 링크 → 각자 기기로 입장 → 영상·음성·바탕화면 공유 → 양쪽 동의 후 화자별 자막과 캐치 → 근거 달린 일지 초안 → 훈련사 확정 → 보호자 전달 → 과제 기록 → 다음 상담 브리핑 |
| 상담일지 | 3~60초 음성 또는 8,000자 이하 텍스트 → 원문·분류·숫자 확인 → 승인·저장 |
| 보호자 일상 기록 | 반려동물 등록 → 음성 또는 텍스트 → 사건별 반려동물·시각·근거 확인 → 저장 |
| 상담 전 브리핑 | 보호자 기록 + 직접 선택한 확정 상담일지 → 핵심 3줄·구체적인 확인 질문·날짜와 원문 근거·자료 부족 표시 |
| 보호소 프로필 | 날짜·작성자 역할이 있는 관찰 메모 → 긍정·주의 관찰 확인 → 담당자 확정 |

화상 코칭의 전사와 장면은 `HANGGO_HOME/data/coaching`에 저장합니다. 원본 음성은 저장하지 않고, 영상은 녹화하지 않습니다. 기존 짧은 상담일지·보호자 기록 등은 브라우저 `localStorage`를 사용합니다. 실제 레슨 카탈로그가 연결된 경우에만 레슨 후보가 표시됩니다. 사용자별 계정·권한, 팀 공유 저장소, 보호자 자동 전송은 제공하지 않습니다.

### 상담 전 브리핑

**핵심 상황 / 변화·주의점 / 이번 상담에서 확인할 일**을 3줄로 읽고, 상세 근거에서 기록 날짜·원문·상담 시간을 확인합니다. 보호자 기록의 발생 상황·대응·이후 반응과 선택한 확정 상담일지를 질문으로 연결합니다. 기록 건수와 실제 행동 횟수를 구분하며, 자료가 없는 부분과 과제 수행 여부를 추정하지 않습니다.

카메라 없이도 텍스트 기록과 확정 상담일지로 시연할 수 있습니다. [브리핑 시연 대본](docs/testing/consultation-brief.md) · [브리핑 검증 결과](docs/llm/consultation-brief-verification.md)

### 화상 코칭의 흐름

**입장 → 양쪽 동의 → 화자별 자막·캐치 → 종료 → 장면 관찰·일지 초안 → 훈련사 검토·확정 → 보호자 전달 → 과제 기록 → 다음 브리핑**

각 브라우저가 자기 마이크만 침묵 기준으로 잘라 서버로 보내므로 화자는 업로드한 사람으로 정해집니다. 캐치를 누르면 양쪽 브라우저가 버튼 약 5초 전부터 2초 후까지의 사진을 올립니다. 공유 화면과 훈련사 카메라는 캐치할 때만 저장합니다. 어느 쪽이든 동의를 철회하면 아직 보내지 않은 음성과 사진을 버립니다.

일지의 문장은 LLM이 쓰지만 인용과 시각은 코드가 원문에서 채웁니다. 근거에 없는 숫자와 이름, 훈련사가 말하지 않은 과제, 금지 표현은 재생성 후에도 남으면 빼고 경고로 남깁니다. 안전 신호는 규칙과 LLM 중 하나만 잡아도 표시합니다. 보호자에게는 확정본만 가고 초안, 메모, 체벌 언급, 인용하지 않은 사진은 가지 않습니다.

[사람 시연 대본](docs/testing/two-way-coaching.md) · [전사 검증](docs/llm/two-way-step-2.md) · [일지 검증](docs/llm/two-way-step-3.md) · [순환 검증](docs/llm/two-way-step-4.md) · [자동 시연 검증](docs/llm/two-way-step-5.md) · [무료 음성 모델 비교 결과](docs/llm/speech-comparison.md)

<details>
<summary><strong>모바일 검토 화면 보기</strong></summary>
<br>
<img src="docs/assets/mobile.png" alt="모바일에서 원문과 안전 신호를 검토하는 화면" width="360">
</details>

**[공개 체험판 열기 →](https://joon56.github.io/Hanggo-LLM/)**

GitHub Pages는 정적 체험판입니다. 텍스트 정리·녹음 재생·검토·브라우저 저장을 체험할 수 있지만 AI 생성과 받아쓰기는 없습니다. 회의에서 실제 AI를 시연할 때는 아래 **로컬 주소**를 사용하세요.

## 빠른 시작

Windows에서 Node.js 24, FFmpeg와 ffprobe, NVIDIA GPU가 필요합니다. 첫 설치에 약 12GB를 받습니다. 확인 환경은 RTX 3070 8GB와 RAM 32GB입니다.

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup.ps1 -HanggoHome D:\hanggo
npm.cmd run local:check
npm.cmd run dev:local
```

`setup.ps1`은 npm 패키지와 고정된 실행기·모델을 `-HanggoHome` 아래에 설치합니다. 설정은 그 폴더의 `settings.env`, 비밀값은 `secrets.env`에 둡니다. 비교용 모델까지 받으려면 `-Groups core,compare`를 더합니다. `dev:local`은 화면 `http://127.0.0.1:5173/`와 API `127.0.0.1:3001`을 이 PC에 엽니다. 종료는 Ctrl+C입니다. 화상 코칭은 `/coaching`에서 시작합니다.

**다른 기기와 시연**

```powershell
npm.cmd run demo:tunnel
```

Cloudflare Quick Tunnel로 이 PC의 앱을 인터넷에 엽니다. 접근 비밀번호가 없으면 만들어 `secrets.env`에 저장하고, 기본 4시간 뒤 자동으로 닫습니다. 서로 다른 네트워크에서는 중계 서버가 필요할 수 있습니다. `secrets.env`의 `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL`을 채운 뒤 `npm.cmd run check:turn`으로 확인하세요. [사람 시연 대본](docs/testing/two-way-coaching.md)

회의 전 상태 점검:

```powershell
npm.cmd run beta:check
npm.cmd run beta:check -- --warmup
```

첫 명령은 준비 상태만 확인합니다. `--warmup`은 가상 상담 문장으로 로컬 HTTP 요청 1회를 보내 모델을 준비시키며 일일 요청 한도 1회를 사용합니다. 브라우저 기록은 저장하지 않습니다. [로컬 설치·설정](docs/testing/local-ai.md) · [음성 실행기](docs/testing/local-speech.md) · [15분 시연](docs/testing/beta-test-script.md)

## 사용 흐름과 확인

1. 가상 반려동물·훈련사 이름을 사용합니다. 회의 화면 공유에 입력 내용이 보일 수 있습니다.
2. 텍스트를 입력하거나 3~60초 녹음하고 재생합니다. 음성은 받아쓰기 뒤 이름·숫자·행동을 직접 확인합니다.
3. 화면의 로컬 AI 처리 확인란을 선택하고 초안을 만듭니다.
4. 원문 근거와 분류를 확인합니다. 승인·검토 확인란을 선택한 뒤 브라우저에 저장합니다.
5. 새로고침 뒤 저장 목록에서 다시 열고 JSON으로 내보낼 수 있습니다. 삭제는 확인 후 진행합니다.

AI 요청 실패·검증 실패 때 원문을 유지하고 수동 검토 초안을 표시할 수 있습니다. 이 경우 AI 성공으로 기록하지 않습니다. 개인정보 패턴 일부는 텍스트 요청 전에 가리지만 모든 항목을 찾지는 못합니다. 음성은 받아쓰기 요청 때 이 PC의 로컬 서버에서 처리됩니다. 서버는 요청용 임시 파일을 처리 후 삭제합니다. 브라우저 저장 자료는 자동 백업·기기 간 동기화되지 않으며 JSON은 내보내기만 지원합니다.

## 검증

2026-11-04 쌍방향 코칭은 단위 테스트 1046개, 브라우저 테스트 37개를 통과했습니다. 서로 다른 Chrome 2개가 실제 WebRTC로 합성 영상과 소리를 주고받는 테스트가 GitHub Actions에서도 돕니다. 터널, 실제 휴대폰, 중계 서버는 사람 시연으로 확인해야 합니다. [검증 상세](docs/llm/two-way-step-1.md)

2026-10-07 브리핑 개선은 단위 테스트 450개(`--maxWorkers=2`), 관련 Chrome 테스트 5개, 브리핑 자료 평가 12개와 빌드를 통과했습니다. 실제 로컬 모델의 가상 사례 1건은 약 12.2초 걸렸습니다. 전체 Chrome 검증에서는 녹화 2건이 실패했고, 변경 전 코드에서도 같은 WebM 오류가 재현됐습니다. 카메라·녹화 문제는 별도 보류 중입니다. [이번 브리핑 검증 상세](docs/llm/consultation-brief-verification.md)

```powershell
npm.cmd run verify
npm.cmd run llm:eval:local
npm.cmd run llm:eval:local -- --all
npm.cmd run llm:eval -- --live --case N01
npm.cmd run llm:eval:workspace -- --feature owner --case bark-delivery --live
```

`verify`는 단위·빌드·모의 브라우저 테스트와 자료 형식 평가를 실행합니다. `llm:eval:local`과 `--live`는 로컬 모델 평가입니다. 전체 평가는 오래 걸릴 수 있습니다. 음성 평가는 `--audio-dir test-audio`와 사례 ID에 맞는 WAV/WebM/MP4/MP3 파일이 필요합니다. 결과 JSON에는 가상 원문을 사용하세요.

카메라 상담 추가 후 단위 테스트 410개, Chrome 테스트 14개, 빌드·타입 검사와 82개 테스트 자료 검사가 통과했습니다. 가상 카메라·합성 음성과 실제 로컬 모델을 연결해 녹화·전사·장면 수정·일지 확정·내보내기를 확인했습니다. 영상에서 보이지 않는 자세 추측과 전사 구간 경계의 단어 누락도 발견돼, 원본 검토·수정이 필요합니다. 물리 카메라·마이크, 실제 반려동물 행동 인식과 60분 연속 브라우저 녹화는 추가 확인 대상입니다. [카메라 상담 검증](docs/llm/camera-analysis-verification.md) · [이전 실시간 상담·60분 자료 가속 검증](docs/llm/live-consultation-verification.md)

이전 실모델 측정에서 `qwen3.5:9b` 전체 사례는 74/82개 자동 조건을 통과했습니다. 같은 16개 사례 비교에서는 이전 모델 6/16개, 현재 모델 15/16개였습니다. 실모델 수치는 당시 환경의 측정값이며 모든 입력에 대한 품질 보장은 아닙니다. [이전 베타 검증](docs/llm/beta-verification.md) · [이전 로컬 모델 검증](docs/llm/local-verification.md) · [과거 외부 AI 실험](docs/llm/openai-verification.md)

## 실행 범위

로컬 실행에는 API 크레딧이 필요하지 않습니다. 텍스트 모델은 `LLM_MODEL`(기본 `gemma4-12b`), 음성 모델은 `SPEECH_MODEL`(기본 `qwen-asr`)로 고릅니다. `LESSON_CATALOG_PATH`가 비어 있으면 레슨 후보가 없습니다.

공개 GitHub Pages는 AI 없는 정적 체험판으로 유지됩니다. 로컬 빌드 확인은 `npm.cmd run build` 뒤 `npm.cmd start`로 할 수 있습니다. 외부 호스팅은 현재 로컬 Ollama·Whisper 실행 경로가 아니므로 회의 AI 시연에 사용하지 않습니다. [실행·배포 범위](docs/testing/deployment.md) · [기능별 테스트](docs/testing/workspace-testing.md)

---

<div align="center"><strong>말하고, 확인하고, 기록으로 남기세요.</strong><br>행고 · 우리아이 행동고민</div>
