# 쌍방향 코칭 5단계 검증 · 2026-11-04

설계: [2026-11-03-two-way-coaching-design.md](../superpowers/specs/2026-11-03-two-way-coaching-design.md) §17, §18.

## 통과 기준

| 기준 | 결과 |
|---|---|
| push E2E 연속 3회 통과 | RUNS_PLACEHOLDER |
| 수동·야간 실모델 실행 성공 | NIGHTLY_PLACEHOLDER |
| Pages에서 양쪽 화면 영상 재생 | PAGES_PLACEHOLDER |

## 자동 시연

[자동 시연 페이지](https://joon56.github.io/Hanggo-LLM/demo/)는 코드를 `main`에 올릴 때마다 새로 만든다. `e2e/auto-demo.ts`가 실제 앱을 띄우고 서로 다른 Chrome 2개를 훈련사와 보호자로 움직여 초대부터 다음 상담 브리핑까지 진행한다. 각 단계의 확인이 실패하면 배포도 멈춘다. 두 화면을 녹화해 FFmpeg로 나란히 합친다.

**합성 입력이다.** 카메라는 저장된 영상, 마이크는 시험 신호, 자막과 일지 문장은 대본을 쓰는 시험용 AI 응답이다. 흐름의 증거이고 AI 품질의 증거가 아니다. 페이지에도 그렇게 적었다.

영상의 반려견 자료는 [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:German_shepherd_eating_dog_treat.webm)의 CC BY-SA 4.0 영상이다. 출처를 페이지와 `fixtures/demo/README.md`에 표시했다.

## 야간 실모델 실행

`.github/workflows/real-models.yml`이 매일 03:00(KST)에 돈다. GPU 없는 러너에서 CPU용 llama.cpp, Qwen3-ASR, Qwen3.5-4B를 받아 해시를 확인한 뒤, 실제 사람의 낭독(zeroth_korean)을 두 브라우저에 넣어 전사부터 일지까지 진행한다. 결과는 실행 주석으로 남는다.

작은 모델이라 이 PC의 품질을 대표하지 않는다. 경로가 실제 모델로 끝까지 도는지를 본다. 낭독 음성의 주제는 상담과 무관해 일지 내용은 평가하지 않는다.

## 운영 모드 시험

터널은 이 환경에서 열 수 없어 `e2e/two-way-production.spec.ts`가 로컬 HTTPS 프록시로 같은 조건을 만든다. `NODE_ENV=production`에서 secure 쿠키, 운영 CSP, wss 신호, 프록시를 거친 업로드, 사진 표시가 전부 동작하고 CSP 위반이 없는지 본다. Actions에서 푸시마다 돈다. 이 PC는 Kaspersky가 자체 서명 인증서를 막아 건너뛴다.

Cloudflare 자체의 동작은 이 시험 범위가 아니다. 사람 시연의 `npm.cmd run check:tunnel`로 확인한다.

## 이 PC의 실모델 전체 경로

REAL_RUN_PLACEHOLDER
