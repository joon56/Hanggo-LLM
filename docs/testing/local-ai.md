# 행고 로컬 AI 실행·테스트

이 PC에서 Ollama와 Whisper로 실행합니다. 인터넷은 최초 모델·실행 파일 다운로드에 필요합니다. 설치 후 텍스트와 음성은 로컬 서버에서 처리합니다.

## 모델 선택

- 선정 모델: `qwen3.5:9b` (Q4_K_M, 다운로드 약 6.6GB). 이 PC에서 GPU 실행을 확인했고, 같은 16개 검사에서 기존 모델 6/16 → 새 모델 15/16으로 개선됐습니다. [Ollama 모델 정보](https://ollama.com/library/qwen3.5:9b) · [전체 검증 결과와 한계](../llm/local-verification.md)
- 메모리 여유가 부족하면 `qwen3.5:4b`를 비교할 수 있습니다. 기본 설치는 9B 하나만 받습니다.
- `gemma3:12b-it-qat`도 비교 후보이나 RTX 4060 Laptop 8GB에서는 GPU 외 메모리를 사용할 가능성이 커 기본값으로 선택하지 않았습니다. [모델 정보](https://ollama.com/library/gemma3:12b-it-qat)
- 음성: Whisper medium Q5_0, CPU 실행. 텍스트 모델과 VRAM을 경쟁하지 않게 구성합니다.

모델 크기만으로 한국어 품질을 보장하지 않습니다. 실제 평가 결과와 원문 누락 여부를 함께 보세요.

## 처음 설치 (Windows)

Node.js 24, Ollama 0.34.4 이상, FFmpeg/ffprobe가 필요합니다. 이전 Ollama에서는 긴 입력 누락 방지 옵션을 보장할 수 없어 연결을 제한합니다. PowerShell에서 프로젝트 폴더를 열고 실행합니다.

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup.ps1
```

`setup.ps1`은 npm 설치와 `setup-local.ps1` 호출을 진행합니다. 텍스트 모델과 음성 실행기를 로컬 모델 저장소에 내려받습니다. 모델 파일은 Git에 올리지 않습니다. 기존 모델은 삭제하지 않습니다. 다운로드 중 끊기면 같은 명령으로 다시 시도하세요.

이미 설치한 PC:

```powershell
npm.cmd run local:configure
npm.cmd run local:check
npm.cmd run dev:local
```

브라우저에서 **http://127.0.0.1:5173/** 접속. `dev:local`은 이 PC의 루프백에 화면과 API를 엽니다. GitHub Pages 주소는 로컬 AI를 자동 사용하지 않습니다. 기존 브라우저 저장 기록은 같은 프로필·주소에서 계속 읽을 수 있습니다.

## 설정

```dotenv
AI_ENABLED=true
FEATURE_OWNER_LOG_ENABLED=true
FEATURE_BRIEF_ENABLED=true
FEATURE_SHELTER_ENABLED=true
OLLAMA_MODEL=qwen3.5:9b
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_CONTEXT_SIZE=8192
OLLAMA_TIMEOUT_MS=120000
WHISPER_EXECUTABLE=.local-ai/whisper/whisper-cli.exe
WHISPER_MODEL_PATH=.local-ai/models/ggml-medium-q5_0.bin
LOCAL_STT_TIMEOUT_MS=180000
```

`.env` 변경 후 앱 서버를 다시 시작하세요. 문맥을 늘리면 GPU 메모리 사용량도 늘어납니다. 모델 실행 실패·시간 초과·원문 검증 실패 시 기존 원문과 수동 검토 화면을 보존합니다. 자동으로 외부 API를 호출하지 않습니다.

회의 직전에는 `npm.cmd run beta:check`로 Ollama·Whisper·FFmpeg와 앱 API·화면 프록시 및 네 기능 활성화를 확인합니다. `npm.cmd run beta:check -- --warmup`은 가상 상담 한 건으로 로컬 모델을 준비합니다. 브라우저 기록은 저장하지 않지만 일일 요청 한도에서 1회를 사용합니다. 실제 마이크 권한과 받아쓰기 결과는 브라우저에서 별도로 확인합니다.

## 자동 평가

```powershell
# 실제 모델로 고정된 16개 사례 비교
npm.cmd run llm:eval:local -- --model qwen2.5:3b
npm.cmd run llm:eval:local -- --model qwen3.5:9b

# 전체 82개 사례; 완료까지 시간이 걸릴 수 있음
npm.cmd run llm:eval:local -- --all

# 서비스 전체 회귀 확인 (모델 호출 없음)
npm.cmd run verify
```

비교 모델은 먼저 `ollama pull 모델명`으로 설치해야 합니다. 결과는 `test-output/local-모델명-smoke.json` 또는 `-all.json`에 매 사례 저장됩니다. 같은 모델/범위 재실행 시 덮어씁니다. PASS는 자동 기대 조건 통과이며 임상적 판단·모든 사실의 완전한 추출·품질 보장을 뜻하지 않습니다. 원문과 결과를 직접 비교하세요.

서버 HTTP 경로를 포함한 상담일지 테스트:

```powershell
npm.cmd run llm:eval -- --live --case N06
npm.cmd run llm:eval:workspace -- --live --feature owner --case bark-delivery

# fixtures/session-notes.json의 N06 원문을 녹음한 test-audio/N06.wav 준비
npm.cmd run llm:eval -- --live --case N06 --audio-dir test-audio
```

상담일지·음성 명령은 실행 중인 앱 서버가 필요합니다. `llm:eval:workspace`의 `--live`도 로컬 모델을 사용합니다. 음성은 3~60초, 10MB 이하의 WAV/WebM/MP4/MP3 파일을 사용합니다. `llm:eval:local`은 Ollama 모델별 비교에 사용합니다.

## 직접 테스트 순서

1. 연결 패널에서 로컬 모델과 음성 준비 상태를 확인합니다.
2. 상담일지: `보호자는 초코가 현관 소리에 짖었다고 말했습니다. 오늘 앉아 신호 5회 중 3회 수행하는 모습을 관찰했습니다. 다음 주 과제로 앉아를 하루 3회 연습하기로 했습니다.` 입력. 동의 → 초안. 보고·관찰·합의한 과제가 구분되고 숫자가 보존되는지 확인합니다.
3. 음성: 같은 내용을 3~60초 녹음. 받아쓰기 → 원문 수정·확인 → 초안. 반려동물 이름과 횟수는 직접 확인합니다.
4. 보호자 기록: 반려동물 등록 후 `초코가 택배에 5분 짖다가 멈췄다. 초코 산책 30분.` 입력. 사건 종류·시간·동물 선택 후 저장합니다.
5. 상담 전 브리핑: 반려동물을 선택합니다. 저장한 실제 기록 수와 집계가 맞고 기록 부족 안내가 표시되는지 확인합니다.
6. 보호소 프로필: 날짜가 다른 `다른 개와 잘 놀았음.` / `다른 개를 보면 짖음.` 메모를 넣습니다. 긍정과 주의 관찰 모두 근거와 함께 남는지 확인합니다.
7. 취소: 생성 중 취소하거나 동의를 해제합니다. 이전 원문이 유지되고 늦은 응답이 화면을 덮어쓰지 않아야 합니다.
8. 저장·다시 열기·JSON 다운로드·삭제 확인을 점검합니다. 모델명과 로컬 AI 출처가 유지되어야 합니다.

## 제한

- 1차 범위는 이 PC에서 직접 테스트입니다. 외부 공개 서버·사용자별 로그인·기기 간 데이터 공유는 추가 구성 대상입니다.
- 첫 요청은 모델 로딩 때문에 느릴 수 있습니다. 로컬 서버는 AI 요청을 한 번에 하나씩 처리합니다.
- 길고 복잡한 입력은 작은 모델에서 누락·분류 오류가 생길 수 있습니다. 검토·승인 절차를 유지합니다.
- 상담일지의 원문 문장 선택 제약도 문맥을 사용합니다. 입력이 8,000자 제한 이내여도 모델 문맥을 넘으면 원문을 보존한 수동 초안으로 전환될 수 있습니다.
- 녹음은 받아쓰기 때 임시 파일로 변환한 후 요청 종료 시 삭제합니다. 브라우저에 녹음이 남아 있으면 녹음 삭제 또는 새 기록으로 지울 수 있습니다.
- 실제 마이크·잡음·말투의 정확도는 사용자 녹음으로 확인해야 합니다.
