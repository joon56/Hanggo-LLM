# 로컬 한국어 음성 받아쓰기

Windows x64에서 전체 설치는 `powershell -ExecutionPolicy Bypass -File scripts/setup.ps1`로 진행합니다. 음성 실행기만 다시 설치하려면 저장소 루트에서 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-local-speech.ps1`을 실행합니다. whisper.cpp `b5130` CPU 실행기와 다국어 `ggml-medium-q5_0.bin` 모델을 `.local-ai`에 설치합니다. 다운로드 파일의 SHA-256을 확인하며 재실행할 수 있습니다. FFmpeg는 `PATH`에 있어야 합니다.

`createLocalTranscriber` 경로 예:

```ts
createLocalTranscriber({
  executable: '.local-ai/whisper/whisper-cli.exe',
  modelPath: '.local-ai/models/ggml-medium-q5_0.bin',
  ffmpegPath: 'ffmpeg',
  timeoutMs: 120_000,
});
```

서버는 업로드 음성 길이를 먼저 검사합니다. 변환은 `pipe` 입력만 허용합니다. 요청별 임시 디렉터리에 16 kHz 단일 채널 WAV와 받아쓰기 텍스트를 두고, 처리·취소·시간 초과 후 프로세스 종료를 기다려 삭제합니다. 자식 프로세스 출력은 64 KiB로 제한합니다. 사용자 파일명과 반려동물 이름을 명령 인자로 전달하지 않습니다.

`npm.cmd test -- server/local-speech.test.ts`와 `npm.cmd run typecheck`로 확인합니다. 실제 받아쓰기 점검에는 한국어 녹음이 필요합니다. 테스트는 잘못된 입력, 실행기 부재, 취소, 정리를 확인합니다.

2026-09-30에 Windows Heami로 만든 3.75초 WAV `오늘 초코가 앉아를 세 번 연습했습니다.`를 CPU medium 모델이 `오늘 초코가 앉아를 3번 연습했습니다.`로 약 9.7초에 받아썼습니다. 당시 요청 임시 디렉터리는 남지 않았습니다. 이는 한 번의 측정이며 회의 환경의 지연 시간·정확도 보장은 아닙니다.

자료: [whisper.cpp b5130 릴리스](https://github.com/ggml-org/whisper.cpp/releases/tag/b5130), [다국어 medium 모델](https://huggingface.co/ggerganov/whisper.cpp/blob/98aa99a0a9db05ae2342309f5096248665f7cba3/ggml-medium-q5_0.bin).
