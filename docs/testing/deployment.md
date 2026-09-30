# 행고 실행·배포 범위

현재 AI 기능의 기준 실행 환경은 **행고를 설치한 PC 한 대**입니다. Ollama `qwen3.5:9b`와 Whisper medium을 그 PC에서 실행합니다. 회의 시연은 `http://127.0.0.1:5173/`에서 합니다. [15분 시연 대본](beta-test-script.md)을 먼저 확인하세요.

## 로컬 AI 시연

Windows에서 Node.js 24, Ollama 0.34.4 이상, FFmpeg/ffprobe를 준비합니다.

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup.ps1
npm.cmd run local:check
npm.cmd run dev:local
```

`setup.ps1`은 npm 설치와 로컬 모델 설치를 진행합니다. 준비 상태를 점검하고 싶으면 별도 터미널에서 `npm.cmd run beta:check`를 실행합니다. `npm.cmd run beta:check -- --warmup`은 가상 문장으로 HTTP 모델 요청을 보내며 저장 기록을 만들지 않습니다. 화면은 5173, API는 3001 루프백 포트를 씁니다. 앱 탭이나 창만 화면 공유합니다.

프로덕션 빌드를 같은 PC에서 확인할 수도 있습니다. 먼저 `dev:local`을 Ctrl+C로 종료해 3001 포트를 비웁니다.

```powershell
npm.cmd run build
$env:PUBLIC_ORIGIN = 'http://127.0.0.1:3001'
npm.cmd start
```

이때 화면과 API는 `http://127.0.0.1:3001/`에서 제공됩니다. 종료 후 PowerShell에서 `Remove-Item Env:PUBLIC_ORIGIN`으로 이번 세션의 값을 지우고, 개발 시에는 `dev:local`을 다시 시작합니다. 브라우저 저장소는 출처별로 달라지므로 5173의 저장 기록이 3001에 자동으로 보이지 않습니다. JSON 내보내기는 가능하지만 가져오기는 지원하지 않습니다. 시연 도중 포트를 바꾸지 마세요.

## GitHub Pages 공개 체험판

[공개 체험판](https://joon56.github.io/Hanggo-LLM/)은 정적 화면입니다. 텍스트 규칙 정리, 녹음·재생, 원문 검토, 브라우저 저장, JSON 내보내기를 체험할 수 있습니다. AI 생성·음성 받아쓰기는 제공하지 않습니다. GitHub Pages의 화면은 발표자 PC의 로컬 모델과 연결되지 않습니다.

## 데이터와 기능 경계

- 승인된 상담일지, 보호자 일상 기록, 보호소 프로필은 현재 브라우저에 저장됩니다. 브라우저 프로필·호스트명·포트가 다르면 별도 저장소입니다. 기존 저장 기록은 읽을 수 있습니다.
- 상담 전 브리핑은 같은 브라우저에 저장된 보호자 기록을 사용합니다. 기록이 적으면 최근 14일 변화 판단을 생략합니다.
- 레슨은 검수한 `LESSON_CATALOG_PATH`를 연결했을 때만 후보가 나옵니다. 기본으로 레슨 목록을 만들어 보여 주지 않습니다.
- 사용자별 권한, 중앙 DB, 기기 간 공유, 자동 백업, JSON 가져오기는 제공하지 않습니다. 브라우저 프로필을 분리하고 필요한 기록을 JSON으로 내려받으세요.
- `AI_ENABLED`, 기능별 `FEATURE_*_ENABLED`, `OLLAMA_*`, `WHISPER_*`로 로컬 실행을 설정합니다. 자세한 값은 [로컬 AI 가이드](local-ai.md)에서 확인합니다.

## 외부 호스팅 참고

저장소의 과거 Docker·Render 구성은 AI 없는 화면과 API를 배포하는 데 쓸 수 있으나, 원격 인스턴스에서 이 PC의 Ollama·Whisper를 자동으로 사용할 수는 없습니다. 현재 베타 AI 시연 절차에는 포함하지 않습니다. 외부 공유 운영을 하려면 별도 모델 실행 인프라, 인증, 저장소 설계와 재검증이 필요합니다.

과거 외부 AI 시험 기록은 [기존 검증 보고서](../llm/openai-verification.md)에 역사 자료로 남겨 둡니다. 현재 실행·검증 기준은 [로컬 검증 보고서](../llm/local-verification.md)입니다.
