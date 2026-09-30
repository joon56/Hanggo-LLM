# OpenAI 상담노트 구현 검증

검증일: 2026-09-30. 환경: Windows, Node.js 24.16.0, npm 11.13.0, 설치된 Chrome 및 FFmpeg.

## 구현 범위

현재 상담노트에 서버 OpenAI 연결, 음성 받아쓰기, 원문 확인, 구조화 추출·검증, 수동 대체, 수정·승인·브라우저 저장을 연결했다. 접근 비밀번호, HTTPS 공개 배포 설정 검사, 요청·동시 처리·업로드 제한, 실제 음성 길이 검사와 Docker 구성을 추가했다.

테스트 자료는 30개 예문·기대 조건, 텍스트/음성용 60행 CSV, 직접 테스트 절차, 실제 API 평가 CLI, PowerShell 설치·실행·검증 스크립트로 제공한다.

## 최종 확인 결과

| 항목 | 결과 |
|---|---|
| `npm.cmd run verify` | 종료 코드 0 |
| Vitest | 11개 파일, 77개 테스트 통과 |
| TypeScript | 화면·서버 검사 통과 |
| Vite production build | 통과 |
| Playwright | Chrome 6개 테스트 통과, 정상 종료 |
| 평가 자료 | N01~N30 30개 형식·ID 검증 통과 |
| 수동 기록 CSV | 60행, 사례 ID 30개 확인 |
| Node 정적 화면·API | 임시 3019 포트에서 `/`, `/api/health`, `/api/session` HTTP 200 확인, CSP 존재 |
| `npm.cmd audit --omit=dev --audit-level=high` | 보고된 취약점 0건 |
| 독립 코드 검토 | 발견된 중요 문제 수정 후 재검토에서 추가 중요 문제 없음 |
| Linux GitHub Actions | 전체 검증 통과 ([실행 결과](https://github.com/joon56/Hanggo-LLM/actions/runs/36670543457)) |
| Docker 이미지 | GitHub Linux에서 빌드·시작·HTTP 상태 검사·ffprobe·인증 설정 검사 통과 |
| 공개 체험판 빌드 | 별도 빌드에서 승인·새로고침·재열람·모바일 레이아웃 확인, API 호출·브라우저 오류 0건 |
| 공개 HTTPS 접속 | [GitHub Pages](https://joon56.github.io/Hanggo-LLM/) HTTP 200, 실제 Chrome에서 예시 입력→승인→저장→새로고침→재열람 통과. 모바일 넘침·API 호출·브라우저 오류 0건 |

Playwright는 가상 오디오와 모의 API를 사용한다. 실제 OpenAI SDK를 통한 요청 형식·응답 처리도 모의 HTTP 응답으로 검증했다. 공급사에 실제 음성이나 텍스트를 전송하지 않았다.

## 검토에서 수정한 문제

- 유효한 긴 입력의 수동 초안이 항목 수·공백 제한 때문에 승인되지 않던 문제.
- 잘못된 AI 분류 필드로 인해 함께 반환된 위험 신호까지 사라지던 문제.
- SDK 자동 파싱 예외가 위 위험 신호 보존·재시도 절차를 건너뛰던 문제.
- 음성 길이를 클라이언트 선언값으로만 검사하던 문제. ffprobe로 실제 길이를 검사한다. 인코더 패딩을 포함해 3~60.5초만 허용한다.
- 공개 바인딩에서 production·HTTPS 설정을 우회할 수 있던 문제.
- 로그아웃 응답 형식 때문에 기록 화면이 다시 노출되던 문제.
- 입력 변경·이전 응답·새 초안 요청 중 승인·받아쓰기 확인 상태의 경합.
- 오디오 분석 중 동의를 철회해도 업로드가 진행되던 문제.
- Windows에서 Playwright 서버 종료가 지연되던 문제. 직접 생성한 Node 자식 프로세스를 종료하도록 변경했다.
- 테스트 산출 HTML이 Vite 화면 새로고침을 유발하던 문제. 임시 산출물을 감시 대상에서 제외했다.
- Linux FFmpeg의 fragmented MP4 첫 패킷에 길이가 없을 때 정상 녹음이 거절되던 문제. 다음 패킷 시각으로 누락된 구간을 측정한다. 60초 MP4 허용·61초 거부를 검증했다.
- Docker 검사에서 서버가 시작되기 전에 연결해 실패하던 문제. 상태 응답이 준비될 때까지 제한된 재시도를 수행한다.
- GitHub Pages용 명시적 공개 체험판을 추가했다. 이 빌드에서는 API 호출을 하지 않으며, 일반 production 빌드는 서버 연결이 끊기면 계속 잠긴다.

마지막 전체 검증은 단독 실행했다. 앞선 병렬 Playwright 검증에서 동일 산출물 경로 충돌로 발생한 ENOENT는 마지막 실행에서 재현되지 않았다.

## 아직 검증하지 못한 항목

- **실제 OpenAI 호출:** `OPENAI_API_KEY`와 `.env`가 없어 실행하지 않았다. 모델 접근 권한, 실제 응답 품질·속도·비용은 키 설정 후 `npm.cmd run llm:eval -- --live`로 확인해야 한다.
- **실제 마이크·사용성:** 사람이 직접 조용한 환경·소음·빠른 말투·실기기에서 테스트해야 한다. 자동 검증은 임상적 안전성이나 오류 부재를 보장하지 않는다.
- **전체 AI 서버 공개 운영:** Render 설정을 추가했으나 호스팅 계정·OpenAI 키 연결이 필요하다. GitHub Pages 공개 체험판에는 서버와 실제 AI·받아쓰기가 없다.

## 운영 경계

단일 운영자·단일 프로세스 구성이다. 승인 자료는 브라우저에만 보관하며 서버 로그인은 저장 자료를 암호화하지 않는다. 서버 재시작 시 세션과 요청 한도 상태가 초기화된다. 다중 사용자 권한·중앙 DB·백업·분산 요청 제한은 별도 구현이 필요하다. 새 도메인·포트에서는 이전 localStorage 기록이 보이지 않는다.

## 실행 자료

- [README](../../README.md)
- [직접 테스트](../testing/manual-testing.md)
- [결과 기록 CSV](../testing/results-template.csv)
- [배포 절차](../testing/deployment.md)

공식 API 근거: [음성 받아쓰기](https://developers.openai.com/api/docs/guides/speech-to-text), [구조화 출력](https://developers.openai.com/api/docs/guides/structured-outputs), [데이터 처리](https://developers.openai.com/api/docs/guides/your-data). 실제 음성 검사 옵션은 [ffprobe 문서](https://ffmpeg.org/ffprobe.html)를 참고했다.
