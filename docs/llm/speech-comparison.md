# 로컬 음성 모델 비교 — 2026-10-07

**선택: Whisper large-v3-turbo GPU.** 세 후보를 설치·비교한 결과를 확인한 뒤 사용자가 선택했다.
이 결과는 짧은 합성 음성의 실행 검증이다. 실제 상담 음성의 최고 정확도를 입증한 평가는 아니다.

## 조건

- Windows, NVIDIA GeForce RTX 4060 Laptop GPU 8GB, RAM 32GB.
- 한국어 Microsoft Heami Desktop 합성 음성 5문장(각 7.54~10.02초)과 무음 5초.
- 동일한 mono 16kHz PCM WAV를 모델별 두 번씩, 한 요청씩 처리.
- Whisper: whisper.cpp `b5454`, CUDA 12.4, FP16, 한국어 고정, beam 5.
- Qwen: llama.cpp `b11457`, CUDA 12.4, BF16 모델·오디오 인코더, context 4096, parallel 1.
- 텍스트 LLM을 동시에 실행하지 않았다. 최초 준비 시간과 준비 후 전사 시간을 분리했다.
- GPU 수치는 모델 준비 직후 `nvidia-smi`가 보고한 GPU 전체 사용량이다. 최대 사용량은 아니다.

| 모델 | 최초 준비 | 발화 전사 처리 시간 | 준비 직후 GPU 사용량 |
|---|---:|---:|---:|
| Whisper large-v3-turbo | 3.23초 | 0.227~0.354초 | 1,877MiB |
| Whisper large-v3 | 2.75초 | 0.526~0.725초 | 3,559MiB |
| Qwen3-ASR 1.7B | 6.85초 | 0.525~0.771초 | 5,061MiB |

기존 medium Q5 CPU 경로로 첫 문장을 한 번 처리한 시간은 10.156초였다.
기존 경로는 FFmpeg 변환·실행기 시작·모델 로드를 포함한다. 위 표의 준비 후 시간과
동일 조건이 아니므로 모델 자체의 속도 배수로 해석하면 안 된다.

## 인식 결과

- Whisper 두 후보는 다섯 발화의 내용을 보존했다. `여덟 시 → 8시`, `오십 그램 → 50g`처럼 표기 변환이 있었다.
- Qwen은 네 번째 문장의 `소리가 나자`를 두 번 모두 `소리가 낮아`로 인식했다.
- 기존 CPU medium은 첫 문장의 `짖었습니다`를 `지졌습니다`로 인식했다.
- Whisper 두 후보는 완전한 무음에 `감사합니다.`를 출력했다. Qwen은 빈 문자열을 반환했다.
  따라서 새 상담 경로는 모델 호출 전에 무음을 검사한다. 이 검사는 잡음 속 환각을 모두 막는다는 뜻이 아니다.

이 작은 표본에서는 turbo가 가장 빠르면서 발화 내용을 보존했다. 사람 목소리, 겹친 말,
방언, 반려동물 이름, 주변 소음, 실제 탭·마이크 혼합 입력의 정확도는 별도 확인해야 한다.
문장 길이와 녹음 구간 분할에 따른 전사 누락도 실제 상담 테스트 대상이다.

## 재현

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-speech-candidates.ps1
node --env-file-if-exists=.env scripts/compare-speech.ts test-audio/manifest.json .tmp/speech-comparison.json
```

`manifest.json` 예시. `file`은 manifest 기준 상대 경로이며 PCM WAV 파일을 사용한다.
출력에는 발화 원문이 포함되므로 개인 음성 결과는 `.tmp`나 `test-audio`에 보관한다.

```json
{
  "kind": "human",
  "samples": [
    {
      "file": "sample-01.wav",
      "expected": "오늘 초코는 산책 중 다른 개를 보고 세 번 짖었습니다. 줄을 당기지는 않았습니다."
    }
  ]
}
```

스크립트는 구두점·공백을 제외한 문자 오류율(CER)도 기록한다. 숫자 표기 변환은
오류로 계산되므로 CER만으로 위 후보의 의미 보존 순위를 정하지 않는다.
실행 전 Ollama에 올라간 모델을 내려 GPU 메모리를 비운다.

### 비교에 사용한 발화

1. 오늘 초코는 산책 중 다른 개를 보고 세 번 짖었습니다. 줄을 당기지는 않았습니다.
2. 보호자님은 아침 여덟 시에 사료 오십 그램을 줬고, 물은 평소와 비슷하게 마셨다고 말씀하셨습니다.
3. 과제는 아직 정하지 않았습니다. 간식을 주지 말라는 뜻은 아닙니다. 내일까지 상태를 확인하겠습니다.
4. 훈련사가 관찰했을 때, 보리는 현관 소리가 나자 문 쪽으로 이동했습니다. 보호자가 이름을 부르자 돌아봤습니다.
5. 이번 상담에서는 산책 중 줄 당김을 이야기했습니다. 다음 주까지 하루 두 번, 삼 분씩 연습하기로 합의했습니다.

## 설치 검증과 다른 후보

모델·실행기는 `setup-speech-candidates.ps1`에 고정한 리비전·SHA-256으로 검증했다.
무료 로컬 가중치를 사용하므로 API 크레딧이 필요하지 않는다.

- [Whisper large-v3-turbo](https://huggingface.co/openai/whisper-large-v3-turbo): large-v3의 decoder를 줄인 속도 중심 후보.
- [Whisper large-v3](https://huggingface.co/openai/whisper-large-v3): 더 큰 decoder를 사용하는 비교 후보.
- [Qwen3-ASR 1.7B](https://huggingface.co/Qwen/Qwen3-ASR-1.7B): 한국어 지원. 공식 vLLM streaming과 이번 llama.cpp 구간 전사는 실행 방식이 다르다.
- [Qwen ASR GGUF](https://huggingface.co/ggml-org/Qwen3-ASR-1.7B-GGUF): llama.cpp 팀이 배포한 변환 가중치.
- [Voxtral Mini 4B Realtime](https://huggingface.co/mistralai/Voxtral-Mini-4B-Realtime-2602): 한국어·실시간 모델이나 8GB Windows 데모의 첫 비교에서는 실행 메모리 부담을 고려해 제외.
- [VibeVoice-ASR](https://huggingface.co/microsoft/VibeVoice-ASR): 장시간·화자 정보가 장점이나 공식 BF16 규모가 더 커 이번 1차 비교에서 제외.
