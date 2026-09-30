# 상담노트 단일 운영자 배포

React 빌드와 Node API를 동일 출처에서 제공하는 단일 프로세스 구성입니다. 운영자 본인이 비밀번호로 접근하며 기록은 그 브라우저에 저장합니다. 중앙 데이터베이스·다중 사용자 권한·공유 기록은 포함하지 않습니다.

## 배포 전

`npm.cmd run verify` 후 실제 키로 `npm.cmd run llm:eval -- --live`와 직접 음성 테스트를 수행합니다. 가상 음성·모의 API를 쓰는 브라우저 테스트만으로 실제 모델 품질이 검증되지는 않습니다.

## GitHub Pages 공개 체험판

주소: **https://joon56.github.io/Hanggo-LLM/**

`CI`의 테스트와 Docker 검사가 통과하면 `pages` 작업이 체험판을 배포합니다. `VITE_PUBLIC_DEMO=true`를 이 빌드에만 설정합니다. 체험판은 서버 요청 없이 텍스트 규칙 분류·마이크 녹음과 재생·검토·승인·브라우저 저장·JSON 내보내기를 제공합니다. AI 생성·받아쓰기는 없으며 화면에 명시합니다.

일반 `npm run build`와 Docker 빌드는 이 플래그를 사용하지 않아 서버 인증을 계속 요구합니다. 운영 서버의 빌드 환경에는 `VITE_PUBLIC_DEMO`를 설정하지 않습니다. GitHub Pages는 전체 AI 서버 배포를 대체하지 않습니다.

## Render로 공개 배포

저장소 루트의 `render.yaml`은 Docker 웹 서비스 한 개를 만듭니다. 서버와 화면은 같은 HTTPS 주소를 사용하며 FFmpeg는 이미지에 포함됩니다. GitHub Pages 같은 정적 호스팅만으로는 음성·OpenAI API 서버가 실행되지 않습니다.

1. `joon56/Hanggo-LLM`의 `main`에 코드를 올리고 GitHub Actions의 `CI` 결과를 확인합니다.
2. [Render 배포 화면](https://render.com/deploy?repo=https://github.com/joon56/Hanggo-LLM)을 열고 저장소를 연결합니다. `hanggo-llm`, Docker, Singapore, Free 설정을 확인하고 Blueprint를 생성합니다.
3. Render가 제공한 실제 HTTPS 주소에서 로그인 화면과 `/api/health` 응답을 확인합니다. `PUBLIC_ORIGIN`은 서비스의 `RENDER_EXTERNAL_URL`에서 자동으로 가져옵니다.
4. Render → 서비스 → Environment에서 자동 생성된 `APP_ACCESS_PASSWORD`를 확인해 로그인합니다. 비밀번호를 README나 GitHub Issue에 공개하지 않습니다.
5. 실제 AI 테스트 시 같은 Environment에 `OPENAI_API_KEY`를 비밀값으로 추가하고 `AI_ENABLED`를 `true`로 바꾼 뒤 재배포합니다. 최초 설정은 AI 꺼짐이므로 키 없이도 로그인·텍스트 데모·검토·저장을 확인할 수 있습니다.
6. 아래 배포 후 확인 절차를 수행한 뒤, 사용할 사람에게 실제 HTTPS 주소와 접근 비밀번호를 전달합니다. 각자의 기록은 각 브라우저에 보관됩니다. 공유 계정 체험 범위이며 사용자별 권한·공유 DB는 없습니다.

다음 커밋은 `CI` 통과 후 자동 배포됩니다. `render.yaml`의 `AI_ENABLED=false`는 초기 기본값입니다. 운영에서 AI를 계속 켤 경우 파일도 `true`로 바꿔 커밋하여 Blueprint 재동기화 때 설정이 되돌아가지 않도록 합니다. API 키와 접근 비밀번호는 파일에 넣지 않습니다. [Blueprint 설정](https://render.com/docs/blueprint-spec)

Free 인스턴스는 15분 유휴 후 중지되고 다음 접속에서 다시 시작합니다. 이 앱의 로그인 세션·요청 제한은 서버 메모리에 있으므로 재시작하면 초기화됩니다. 브라우저에 승인한 기록은 유지됩니다. 지속 운영에는 유료 인스턴스를 검토하세요. [무료 서비스 제한](https://render.com/docs/free)

도메인 변경 시 `PUBLIC_ORIGIN`을 실제 사용하는 HTTPS 주소로 변경합니다. 도메인을 여러 개 혼용하지 않습니다. Render 상태 검사는 커스텀 도메인이 있으면 그 Host로 요청하므로 설정이 어긋나면 상태 검사도 실패할 수 있습니다. [상태 검사](https://render.com/docs/health-checks)

`TRUST_PROXY=0`은 현재 모든 요청 제한이 전역 기준이므로 유지합니다. 클라이언트별 IP 제한을 추가한다면 호스팅 프록시 구성을 먼저 검증합니다.

### GitHub 업로드

프로젝트 폴더에서 쓰기 권한이 있는 GitHub 계정으로 인증한 뒤 실행합니다.

```powershell
gh auth login --hostname github.com --git-protocol https --web
gh auth setup-git
git push -u origin main
```

Git 원격 주소는 `https://github.com/joon56/Hanggo-LLM.git`입니다. `.env`, `node_modules`, `dist`, `.tmp`, 실제 평가 결과와 녹음 파일은 `.gitignore`로 제외됩니다.

## 환경변수

| 변수 | 설정 |
|---|---|
| NODE_ENV | production |
| HOST | 컨테이너 0.0.0.0, 동일 호스트 프록시에서는 127.0.0.1 |
| PORT | 3001 |
| PUBLIC_ORIGIN | 실제 HTTPS 도메인. 경로·끝 슬래시 없음 |
| APP_ACCESS_PASSWORD | 고유한 16자 이상 운영자 비밀번호 |
| OPENAI_API_KEY | 배포 환경 비밀값 저장소에 설정 |
| AI_ENABLED | true |
| OPENAI_TEXT_MODEL | 기본 gpt-4.1-mini |
| OPENAI_STT_MODEL | 기본 gpt-4o-mini-transcribe |
| OPENAI_TIMEOUT_MS | 기본 15000 |
| AI_DAILY_LIMIT | 기본 200 |
| TRUST_PROXY | 정확히 한 개의 신뢰할 수 있는 프록시 뒤에서만 1 |
| FFPROBE_PATH | PATH에 없을 때 ffprobe 실행 파일 절대 경로 |

키·비밀번호를 브라우저 번들·이미지 빌드 인자·소스에 넣지 않습니다. 공개 HTTP 구성은 서버가 거부합니다. HTTPS는 역방향 프록시에서 종료하고 앱 포트를 직접 공개하지 않습니다. 프록시 업로드 상한 약 11MB, 응답 대기 시간 90초를 권장합니다. Origin·Host를 유지하세요.

## Node 실행

Node.js 24와 ffprobe가 있는 호스트에서:

```powershell
npm.cmd ci
npm.cmd run build
$env:NODE_ENV = 'production'
npm.cmd start
```

환경변수와 `.env`가 충돌하면 기존 환경변수가 우선합니다. 서비스 관리자로 프로세스 재시작을 설정합니다.

## Docker

```powershell
docker build -t hanggo-notes:0.2 .
docker run --rm --name hanggo-notes --env-file .env.production -p 127.0.0.1:3001:3001 hanggo-notes:0.2
```

`.env.production`에 배포 변수와 비밀값을 넣고 `HOST=0.0.0.0`, `NODE_ENV=production`을 유지합니다. 이 파일은 이미지에 복사하지 않습니다. 컨테이너는 node 사용자로 실행하며 음성은 메모리·ffprobe 파이프로 처리합니다.

## 배포 후 확인

1. HTTPS 주소에서 로그인 전 기록 화면이 숨겨지는지 확인합니다.
2. 잘못된 비밀번호 거부와 정상 로그인을 확인합니다.
3. 가상의 N01 텍스트·짧은 녹음으로 실제 AI 응답을 확인합니다.
4. 검토·승인·새로고침·다운로드·삭제·로그아웃을 확인합니다.
5. `/api/health`의 `{ "ok": true }`를 확인합니다. 이는 프로세스 확인이며 OpenAI 키 검사가 아닙니다.

세션은 8시간이며 재시작 시 만료됩니다. 요청 한도는 단일 프로세스 메모리 기준이고 여러 서버에 공유되지 않습니다. 재생성으로 실제 공급사 호출 수는 요청 수보다 많을 수 있습니다. OpenAI 프로젝트 사용 제한도 설정하세요.

서버 백업은 브라우저 기록을 복구하지 못합니다. 도메인·포트 변경 전 JSON을 내려받으세요. 현재 내보내기만 지원합니다. 로그인은 같은 기기의 브라우저 저장 자료를 암호화하지 않습니다.

실제 개인정보 처리 전 동의·보존 정책을 확인하세요. 화면 동의 체크는 외부 처리 안내 기능이며 법률 검토를 대신하지 않습니다. 음성 원본은 STT로 전송됩니다. `store:false`는 Responses 저장 옵션입니다. [OpenAI 데이터 처리 안내](https://developers.openai.com/api/docs/guides/your-data)를 기준으로 운영 정책을 정하세요.
