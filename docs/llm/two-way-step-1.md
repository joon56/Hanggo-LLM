# 쌍방향 코칭 0~1단계 검증 · 2026-11-03

설계: [2026-11-03-two-way-coaching-design.md](../superpowers/specs/2026-11-03-two-way-coaching-design.md). 모델 선정: [model-selection-2026-11.md](model-selection-2026-11.md).

## 통과한 자동 검증

| 검증 | 결과 |
|---|---|
| `npx vitest run --maxWorkers=2` | 56개 파일, 685/685 |
| `npm run build` | 통과. JS 556 kB로 Vite 500 kB 경고 |
| `npx playwright test` | 25 통과, 1 건너뜀(TURN 값 없음) |
| `npm run llm:eval` | 자료 30개 |
| `npm run llm:eval:workspace` | 52/52 |
| `npm audit` | 0건. 시작 시 high 6, moderate 4 |
| GitHub Actions | `feat/two-way-coaching` 브랜치에서 `verify`, `container` 통과. 두 브라우저 통화 테스트 포함 |

## 실제로 확인한 범위

`e2e/two-way.spec.ts`는 실제 Express 서버와 WebSocket, 서로 다른 Chrome 프로세스 2개 사이의 실제 WebRTC로 돈다. 영상과 소리는 FFmpeg로 만든 합성 파일이다.

- 초대 링크로 입장해 양쪽이 영상과 소리를 받는다. 수신 프레임, `totalAudioEnergy`, 영상 크기로 확인한다.
- 음소거하면 상대가 받는 오디오 에너지가 멈추고 해제하면 돌아온다.
- 양쪽 모두 화면을 공유할 수 있고 카메라는 유지된다. 공유를 끄면 원래대로 돌아온다.
- 카메라가 없어도 입장해 상대 영상을 받는다.
- 새로고침 후 다시 연결된다.
- 양쪽이 동의해야 기록 상태가 켜지고, 철회해도 통화는 이어진다.
- 종료하면 양쪽이 첫 화면으로 돌아간다.
- 재사용 초대, 세션 없음, 다른 사례의 보호자는 들어오지 못한다.

서버 단위 테스트로 권한 표 전체, 위조 쿠키, 초대 재발급 시 이전 세션 무효화, 서버 재시작 후 세션 유지, 신호 메시지 크기·빈도 제한을 확인했다.

실모델은 RTX 3070에서 `llama-server`로 기존 평가 16건 중 15건을 통과했다(Gemma 4 12B). 이전 기록과 같은 N11만 실패한다. 짧은 녹음 경로는 Qwen3-ASR로 합성 음성 1건을 3.5초에 처리했고 끝난 뒤 GPU 메모리를 돌려줬다.

## 중계 연결 추가 확인 (2026-11-04)

사용자가 ExpressTURN 무료 계정 값을 `secrets.env`에 넣은 뒤 확인했다. 결제 수단은 요구되지 않았다.

- `npm run check:turn` 통과. 연결 3286ms, 왕복 569ms.
- relay를 강제한 두 브라우저 통화 테스트 통과.
- 서버가 프랑스에 있는 것으로 보여 지연이 눈에 띈다. 같은 네트워크나 일반 P2P에서는 중계를 거치지 않는다.
- Open Relay 공개 인증은 이 PC에서 중계 후보 0개였고 Cloudflare TURN은 결제 정보를 요구해 제외했다.

## 확인하지 못한 범위

- **터널:** `npm.cmd run demo:tunnel`을 실제로 실행하지 못했다. 이 세션의 권한 규칙이 외부 터널 개방을 막았다. Quick Tunnel에서 WebSocket이 동작한다는 가정도 미검증이다. 스크립트의 주소 파싱과 비밀번호 생성만 단위 테스트했다.
- **실제 장치와 네트워크:** 물리 카메라, 휴대폰, LTE, 서로 다른 네트워크, iOS Safari. [사람 시연 대본](../testing/two-way-coaching.md)으로만 확인할 수 있다.
- **바탕화면 공유 선택창:** 자동화할 수 없어 테스트는 캔버스 스트림을 대신 쓴다. 전달 경로만 검증했고 시스템 소리와 실제 선택 흐름은 미검증이다.
- **전사와 일지의 통화 연결:** 전사는 [2단계](two-way-step-2.md)에서 연결했다. 일지는 3단계 작업이다.

## 알려진 정리 대상

- `.env.example`은 권한 설정으로 이 세션에서 열 수 없어 이전 설정 이름이 남아 있다. 새 설정은 `HANGGO_HOME`의 `settings.env`, `secrets.env`에 있고 앱은 예전 이름을 무시한다.
- `draft.mode`의 `'ollama'` 값은 저장 형식 호환 때문에 그대로 뒀다. 이전 화면을 정리하는 단계에서 바꾼다.
- 이전 상담 화면(`ConsultationWorkspace`)과 녹화 코드는 2단계에서 제거했다.
