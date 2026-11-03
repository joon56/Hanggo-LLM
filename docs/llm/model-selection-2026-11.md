# 로컬 모델 선정 · 2026-11-03

**선정:** 전사 Qwen3-ASR 1.7B Q8_0, 일지·브리핑·장면 Gemma 4 12B QAT Q4_0. 3단계에서 골든 대화 10건으로 일지 모델을 다시 검증한다.

측정 환경: Windows, RTX 3070 8GB, RAM 32GB, llama.cpp b12069 CUDA 12.4, whisper.cpp b5454. 파일은 `scripts/models.manifest.json`에 URL·크기·SHA-256으로 고정했다.

## 전사

자료는 두 묶음이다. 모두 실제 상담 음성은 아니다.

- 공개 음성: `kresnik/zeroth_korean` 시험 구간 200건. 사람이 읽은 문장이다.
- 도메인 문장: `fixtures/speech-domain-sentences.json` 30건을 Microsoft Heami로 합성했다. 반려동물 이름, 숫자, 부정 표현, 행동 용어를 넣었다.

| 모델 | 공개 음성 CER | 도메인 CER | 도메인 용어 재현 | 처리 시간/음성 길이 | 무음 | 잡음 | 준비 후 GPU 전체 |
|---|---:|---:|---:|---:|---|---|---:|
| **Qwen3-ASR 1.7B Q8_0** | **3.81%** | **1.56%** | 95.8% (91/95) | 0.035 | 없음 | 없음 | 4,657MiB |
| Whisper large-v3-turbo | 4.10% | 3.80% | 96.8% (92/95) | 0.032 | "감사합니다." | "아멘" | 3,250MiB |
| Cohere Transcribe Q8_0 | 8.05% | 5.04% | 91.6% (87/95) | 0.090 | 없음 | "갑자기 갑자기." | 3,736MiB |

처리 시간/음성 길이는 공개 음성 평균이다. GPU 수치는 바탕화면 사용량 약 1.1GB를 포함한다.

- **Qwen3-ASR을 고른 이유:** 두 자료 모두 CER이 가장 낮고 무음·잡음에서 말을 지어내지 않았다. 말을 지어내지 않는 점은 근거 기반 일지에 직접 영향을 준다.
- **기준에서 어긋난 점:** 설계 문서는 용어 재현율이 기준선 이상일 것을 요구한다. Qwen3-ASR은 95개 중 한 개 적어 엄밀히는 미달이다. 합성 30문장의 1건 차이로 판단이 뒤집힐 근거는 아니라고 보고 선정했다. 실제 음성 비교로 다시 확인한다.
- **Cohere를 뺀 이유:** 공개 영어 순위와 FLEURS 수치는 좋았지만 이번 자료에서는 가장 낮았다. "짖었어요"를 "지졌어요"로, "줬고"를 "젓고"로 들었다. 어댑터와 의존성을 코드에서 제거했다. 필요하면 커밋 `fa93c31`에서 복구한다.
- **두 사람 동시 처리:** 처리 시간이 음성 길이의 약 4%라 기준(1/3)을 크게 밑돈다.
- **남은 검증:** 사용자 실제 목소리, 겹친 말, 주변 소음, 방언, 긴 상담. Qwen3-ASR은 긴 문장 하나에서 끝에 없는 말을 덧붙인 적이 있어 짧게 끊어 보내는 2단계 방식이 필요하다.

## 일지

자료는 `fixtures/coaching-dialogues/`의 합성 대화 3건이고 프롬프트는 잠정이다. 재시도와 검증 없이 한 번 호출한 결과다.

| 모델 | 크기 | 대화 3건 시간 | GPU 최대 | 사실 재현 | 근거 없는 숫자 | 지어낸 과제 | 안전 신호 재현 |
|---|---:|---:|---:|---:|---:|---:|---:|
| Qwen3.8-27B Q4_K_M | 17.4GB | 1,406초 | 7,247MiB | 100% | 0 | 0 | 2/3 |
| **Gemma 4 12B QAT Q4_0** | 7.0GB | 326초 | 7,343MiB | 100% | 3* | 0 | 2/3 |
| Qwen3.5-9B Q4_K_M | 5.7GB | 147초 | 7,406MiB | 100% | 2* | 2 | 2/3 |
| Gemma 4 E4B QAT Q4_0 | 5.2GB | 45초 | 5,582MiB | 91.5% | 0 | 1 | 2/3 |
| HyperCLOVA X SEED Think 14B | 8.9GB | 실행 불가 | | | | | |

\* Gemma의 3건은 문장에 `[s01]` 같은 근거 표기를 그대로 쓴 것이다. Qwen3.5의 2건은 "한 번"을 다른 발화에서 가져온 약한 인용이다. 실제 숫자를 지어낸 사례는 아니지만 검증 대상이다.

자동 지표에 잡히지 않는 차이를 원문으로 비교했다.

- **Qwen3.5-9B:** 초인종 대화에서 "매트로 가면 짖지 않음"을 지어냈다. 실제로는 앞으로 연습할 내용이었다. 병원 안내도 과제로 넣었다.
- **Gemma 4 12B:** 같은 대화에서 지어낸 내용이 보이지 않았다. 과제의 담당, 횟수, 기한을 맞게 채웠다. "큰 소리로 말함"을 체벌 검토로 올린 오탐이 있다.
- **Qwen3.8-27B:** 요약이 가장 간결하고 정확했다. 대화 1건에 6~10분 걸렸다. 8GB에 다 올라가지 않아 대부분 CPU로 돈다.
- **HyperCLOVA X SEED Think 14B:** `naver-ellm` GGUF가 `unknown model architecture: 'hcx-seed-think'`로 llama.cpp b12069에서 열리지 않았다. 지원되면 다시 비교한다.
- **EXAONE 4.5:** 비상업 라이선스라 후보에서 뺐다.

**공통 약점:** 네 모델 모두 "갑작스러운 공격성"을 놓쳤다. 3단계는 코드 규칙과 LLM을 OR로 합치므로 규칙이 이 신호를 올려야 한다. 근거 없는 서술은 자동 지표만으로 잡히지 않으므로 3단계에 문장별 근거 재확인을 넣는다.

**시간:** Gemma 4 12B는 대화 1건 약 100초다. 30분 상담은 나눠서 처리해도 10분 안팎으로 예상하지만 측정 전이다. 3단계에서 재서 기준을 넘으면 Qwen3.5-9B와 근거 재확인 조합을 비교한다.

## 재현

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-models.ps1 -HanggoHome D:\hanggo -Groups core,compare
node --use-system-ca --env-file-if-exists=.env scripts/fetch-speech-eval.ts 200
node --env-file-if-exists=.env scripts/compare-speech.ts D:/hanggo/cache/eval/zeroth/manifest.json D:/hanggo/cache/eval/speech-zeroth.json qwen-asr,whisper-turbo
node --env-file-if-exists=.env scripts/compare-llm.ts gemma4-12b,qwen35-9b
```

이 PC의 Node는 시스템 인증서를 쓰도록 `--use-system-ca`가 있어야 공개 자료를 받을 수 있었다. curl과 브라우저는 그대로 동작했다.
