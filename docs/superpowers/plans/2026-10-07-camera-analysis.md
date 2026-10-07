# Camera Consultation Analysis Implementation Plan

> **For agentic workers:** Use subagent-driven-development for task implementation and review. Execute without repeated scope approval; the user approved simultaneous camera capture followed by analysis and notes.

**Goal:** Record local camera/audio, transcribe live, analyze saved scenes and create source-linked consultation notes.

**Architecture:** Reuse the existing recorder and session store. Add bounded, persistent vision jobs after capture; use local Ollama images and existing GPU reservation. Extend source evidence rather than flattening visual observations into spoken quotes.

**Tech Stack:** React, TypeScript, Express, Zod, ffmpeg, Ollama qwen3.5:9b, whisper.cpp GPU.

## Global Constraints

- Windows Chrome/Edge, 60 minutes, free local AI; no remote meeting or external services.
- Camera is new default; legacy tab capture and saved sessions remain usable.
- Sampled scene analysis: every 30 seconds plus bookmarks, at most 240 scenes, up to 3 frames around each time.
- Show AI observations as unverified until explicit review; frame timestamps are evidence locations, not precise event boundaries.
- Preserve audio/video if analysis fails. Bound resources, retain authorization, abort on cancellation/deletion.
- Work only in `.tmp/camera-consultation`; no model downloads or secret output.

## Task 1: Vision sources, local processing, API and note integration

**Files:** `src/domain/consultation.ts`, new `src/domain/consultation-vision.ts`, `server/consultation-store.ts`, `server/consultation-router.ts`, `server/consultation-notes.ts`, new `server/consultation-vision.ts`, `server/app.ts`, `server/config.ts` only if needed; focused tests alongside them.

**Interfaces:**

```ts
type CaptureSource = 'camera' | 'tab'; // optional persisted field, missing means legacy tab
type VisionScene = {
  id: string; atMs: number; frameTimesMs: number[];
  state: 'pending' | 'complete' | 'failed';
  observations: string[]; originalObservations: string[]; error?: string;
};
type VisionAnalysis = {
  revision: string; state: 'processing' | 'complete' | 'failed' | 'cancelled';
  model: string; intervalMs: number; scenes: VisionScene[];
  reviewedAt?: string; error?: string;
};
// ConsultationSession gains captureSource?: CaptureSource, vision?: VisionAnalysis.
// Evidence kind gains 'vision': id = scene.id, quote = exact observation,
// startMs/endMs = min/max scene.frameTimesMs.
// POST /api/consultations accepts captureSource? in addition to existing input.
// POST /:id/vision {} -> 202 session; GET /:id polls persisted progress.
// POST /:id/vision/cancel {} -> session after stopping job.
// PATCH /:id/vision/scenes/:sceneId {revision, observations:string[]} -> session.
// POST /:id/vision/review {revision, reviewed:true} -> session.
// GET /:id/vision/scenes/:sceneId/frames/:index -> saved JPEG.
```

- [ ] Write failing focused tests for camera creation, visual evidence persistence, incomplete vision generation/approval rejection, scene review revision, job cancellation and GPU reservation.
- [ ] Run focused tests and record expected failures.
- [ ] Implement bounded schemas, restart recovery, ffmpeg frame extraction, strictly local vision requests with assertLocalModel and vision capability check. Validate observations as short strings; never use transcript text to invent visual observations. Use asynchronous jobs, persisted per-scene results, fixed frame paths and generated IDs. Release AI reservation exactly once. Treat missing model/images/invalid output as visible errors, not fallback observations.
- [ ] Extend note generation, revision/source conflict checks, approval and deletion for visual sources. Camera notes require complete analysis; approval requires reviewed analysis. Successful empty visual observations remain legitimate.
- [ ] Verify with focused Vitest suites, typecheck and backend tests. Commit task files only. Report RED/GREEN evidence and exact interfaces to `.tmp/camera-backend-report.md`.

## Task 2: Camera capture and vision review UI

**Files:** `src/hooks/useConsultationRecorder.ts`, `src/consultation-api.ts`, `src/components/ConsultationWorkspace.tsx`, new `src/components/ConsultationVision.tsx`, `src/consultation.css`, related tests and `e2e/consultation.spec.ts`.

**Interfaces:** Use Task 1 API/types. Extend recorder start with optional source, preserving existing tab-call compatibility:

```ts
start(metadata: Metadata, microphoneEnabled: boolean, source?: 'camera' | 'tab')
createConsultation(metadata: Metadata, captureSource?: 'camera' | 'tab')
```

- [ ] Add failing tests for camera video/audio permissions without display capture, track cleanup and disconnected camera handling; new default camera UI and legacy tab option.
- [ ] Run focused tests and record failures.
- [ ] Implement camera capture reusing media/audio queues, with camera microphone always present. Show camera/source labels, preview, consent and device errors. Ensure preparation delay does not enter recording timestamps.
- [ ] Add analysis start/progress/cancel/retry, thumbnails with time, scene observations editing and explicit revision-bound review. Poll processing even after navigation/reload. Prevent source edits while analysis runs and prevent stale approval after any change. Capture the exact moment when the moment action is used; explain elapsed time is recording time.
- [ ] Extend note editor source lookup/labels and generation/approval availability for vision sources. Do not offer valid-looking camera notes when analysis incomplete. Preserve empty observation edits and original model results.
- [ ] Run hook, component/API tests, build and browser tests. Commit task files only; report to `.tmp/camera-frontend-report.md`.

## Task 3: Actual model/browser verification, demo guide and integration

**Files:** `docs/testing/live-consultation.md`, `docs/llm/camera-analysis-verification.md`, `README.md`, optional `scripts/verify-camera-consultation.ts`.

- [ ] Test actual ffmpeg images and installed local model; record latency and output without claiming pet behavior accuracy from synthetic imagery.
- [ ] Exercise camera/audio recording with browser fake devices, analysis, sources, notes, review and export. Cover interrupted recording and vision cancellation separately from the successful path.
- [ ] Write the physical-camera beta flow: device permission, pet behavior plus spoken explanation, important moment, stop, analysis, original scene verification, note, export. Include a timing check against a visible/spoken cue.
- [ ] Run `npm.cmd run verify` and actual local integration. Record untested real hardware / human performance limits.
- [ ] Review complete diff; fix material findings, rerun covering checks, integrate into main and refresh local service after checking process ownership.
