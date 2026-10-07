# Live Consultation Implementation Plan

> **For agentic workers:** Use subagent-driven-development for the session backend and browser workflow; the root agent owns model installation, runtime integration, and end-to-end verification.

**Goal:** Deliver the approved 60-minute local consultation demo with timestamped transcription, screen/audio recording, manual bookmarks, and evidence-linked notes.

**Architecture:** Browser captures a shared tab and optional microphone, writes recording chunks to the local server, and sends independent PCM WAV windows for transcription. The server persists sessions and serializes GPU speech work. After transcription, it releases the speech model before calling the existing local text model on bounded transcript groups.

**Tech Stack:** Existing React, TypeScript, Express, Zod, Vitest, Playwright; browser MediaRecorder and AudioWorklet; pinned llama.cpp / whisper.cpp CUDA executables.

## Global Constraints

- Maximum session duration: 60 minutes.
- Windows Chrome/Edge browser tab sharing only in this demo.
- Local model inference without paid APIs. Model choice follows measured results and user confirmation.
- Seven note sections: purpose, owner_report, observation, guidance, task, follow_up, moments.
- Evidence must point to persisted transcript segments or manual bookmarks. No invented facts, diagnosis, tasks, or numbers.
- Existing short notes and other workspaces retain their data formats.
- Recordings/transcripts/models are ignored by Git. Recording writes must stay beneath the configured session directory.
- Authentication and Origin guards apply to all session APIs. Bounded upload sizes, duration, concurrency, disk writes, retries.
- No automatic visual interpretation or speaker identification.

## Task 1: GPU comparison and reusable speech runtime — root

Files: `scripts/setup-speech-candidates.ps1`, `scripts/compare-speech.ts`, `server/live-speech.ts`, `server/live-speech.test.ts`, `server/config.ts`, `server/providers.ts`, `server/local-status.ts`.

- [x] Pin official runtime/model URLs, file sizes, and SHA-256 values; download into `.local-ai/candidates`.
- [x] Verify actual CUDA loading and readiness; compare the same audio across models, including repeated requests.
- [x] Test invalid model/configuration, process start failure, cancellation, timeout, bounded response, and release.
- [x] Provide `LiveSpeechService` with `prepare(): Promise<void>`, `transcribe(wav: Buffer, signal?: AbortSignal): Promise<{text: string; model: string; latencyMs: number}>`, `release(): Promise<void>`.
- [x] Prepare unloads the configured Ollama text model before loading speech; release terminates only the process launched by this app. Bind helper to loopback only.
- [x] Persist comparison reports under ignored `.tmp`; publish synthetic timing results and user-selection status in documentation.

## Task 2: Persisted consultation sessions and detailed notes — implementer

Files: `src/domain/consultation.ts`, `server/consultation-store.ts`, `server/consultation-router.ts`, `server/consultation-notes.ts`, corresponding tests. Integrate router into `server/app.ts` and feature metadata into `src/api.ts` / config as coordinated.

Data: `ConsultationSession` includes id, metadata (existing Metadata), createdAt, state, durationMs, ordered transcript segments, bookmarks, recording chunk count, errors, optional note. A segment has id, sequence, startMs, endMs, text, originalText, state. Bookmark has id, atMs, text. Note item has id, section, text, evidence references. Keep changes local to this feature.

API (all under `/api/consultations`):

```text
GET /                              list recoverable local sessions
POST / {metadata, consent:true}    prepare speech and create session
GET /:id                           snapshot, processing status
PUT /:id/media/:sequence            WebM bytes, ordered and idempotent
PUT /:id/audio/:sequence?startMs=N&endMs=N  standalone mono 16k WAV, queued, idempotent
POST /:id/finish {durationMs,captureError?}       finish capture; drain transcription; release speech
POST /:id/bookmarks {atMs,text}     add manual observation
PATCH /:id/segments/:segmentId {text} edit transcript, invalidate generated note
POST /:id/note                     generate detailed draft from all transcript groups
PATCH /:id/note {note}             save validated edits
POST /:id/approve {reviewed:true,noteRevision}  approve complete, evidence-valid note
GET /:id/recording                 concatenate ordered WebM chunks for replay/export
GET /:id/export                    full JSON (metadata, transcripts, bookmarks, note)
DELETE /:id                       delete confirmed session, after stopping its own work
```

- [x] RED: persistence recovery, idempotent duplicate versus conflicting content, invalid sequence/path/duration, queue failure, deletion during work, invalid evidence, full-transcript coverage, edits invalidate approval.
- [x] GREEN: implement store with atomic metadata writes and bounded recording/audio storage. Sessions left recording after restart become interrupted.
- [x] GREEN: router with feature gate, existing authentication/Origin protection, separate bounded upload budget, one active session, serialized audio queue and truthful incomplete state.
- [x] GREEN: notes process every transcript group within 8,000 characters using existing `generate`, remap existing categories to seven approved sections with original quotes/times. Add exact manual bookmarks as observation/moments evidence. No unsupported claim that video was analyzed. Show missing sections explicitly. Purpose can retain exact source statements instead of speculative synthesis.
- [x] Test through Supertest temporary storage and fake speech/LLM services. Run focused tests and typecheck. Write handoff report with precise final interfaces.

## Task 3: Browser capture and review — fresh implementer after Task 2 review

Files: `src/consultation-api.ts`, `src/hooks/useConsultationRecorder.ts`, `public/consultation-audio-worklet.js`, `src/components/ConsultationWorkspace.tsx`, `src/consultation.css`, `src/App.tsx`, targeted tests / browser spec.

- [x] RED: permissions rejected, no tab audio, microphone toggle, stop/track ended, 60-minute cutoff, ordered uploads, failed upload retained for retry, recover/list/delete confirmation.
- [x] GREEN: show a local-only consultation workspace using existing navigation pattern and new feature metadata.
- [x] GREEN: `getDisplayMedia({video:true,audio:true})`, require browser display surface and audio track; optional microphone, AudioContext mix; MediaRecorder WebM timeslice uploads with bounded queued bytes. Stop with explicit error rather than unbounded buffering.
- [x] GREEN: AudioWorklet supplies PCM; sample-rate convert to 16k, encode independent WAV windows with source-relative times. Stop handles the final short tail. Show actual transcription delay and failed segments.
- [x] GREEN: session replay/export, editable transcript, bookmarks with time seek, seven note sections and evidence links, review approval, confirmation before delete.
- [x] Browser checks use simulated capture plus actual local API where possible. Never claim physical microphone test from mocked capture.

## Task 4: Integration, long-session validation, and demo documentation — root + final reviewer

Files: `docs/testing/live-consultation.md`, `docs/llm/live-consultation-verification.md`, README, `.env.example`, setup/check scripts where directly relevant.

- [x] Run all unit tests, typecheck/build, existing browser tests and new consultation workflow.
- [x] Drive a 60-minute synthetic input through recording/segment storage; verify start/middle/end coverage and replay duration. Distinguish accelerated storage testing from wall-clock capture testing.
- [x] Run a real GPU transcription and note-generation demo with available synthetic audio; ask user to validate their microphone quality using recorded fixed phrases.
- [x] Ask user to select speech default after presenting results; retain separate candidate setup until selected.
- [ ] Final code review, fixes, and documented remaining limitations. Integrate reviewed branch into local main; publish only source/docs when authorized, never captures/models.
