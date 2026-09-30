# Local Korean speech transcription

Run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-local-speech.ps1` from repository root on Windows x64. The script installs official whisper.cpp `b5130` CPU binaries and the multilingual `ggml-medium-q5_0.bin` model under `.local-ai`. It checks the downloaded archives against pinned SHA-256 hashes and can be rerun. No system-wide installation or paid API key is needed. FFmpeg must be on `PATH`.

Use these paths with `createLocalTranscriber`:

```ts
createLocalTranscriber({
  executable: '.local-ai/whisper/whisper-cli.exe',
  modelPath: '.local-ai/models/ggml-medium-q5_0.bin',
  ffmpegPath: 'ffmpeg',
  timeoutMs: 120_000,
});
```

The server validates uploaded duration before calling this function. Conversion reads audio from a pipe with only the `pipe` input protocol allowed. A single 16 kHz mono WAV and transcript exist inside a request-specific temporary directory until inference ends. Abort, timeout, and failure wait for the child process to exit before deleting that directory. Child output has a 64 KiB limit. User filenames and pet names are never passed to commands.

Run `npm.cmd test -- server/local-speech.test.ts` and `npm.cmd run typecheck`. A live speech check needs an actual Korean recording; tests cover invalid input, unavailable executable, abort, and cleanup without recording personal audio.

On 2026-09-30, Windows Heami synthesized `오늘 초코가 앉아를 세 번 연습했습니다.` as a 3.75-second WAV. The installed medium model returned `오늘 초코가 앉아를 3번 연습했습니다.` in 9.7 seconds on CPU. No request temporary directory remained afterward.

Sources: [whisper.cpp b5130 release](https://github.com/ggml-org/whisper.cpp/releases/tag/b5130), [official multilingual medium model](https://huggingface.co/ggerganov/whisper.cpp/blob/98aa99a0a9db05ae2342309f5096248665f7cba3/ggml-medium-q5_0.bin).
