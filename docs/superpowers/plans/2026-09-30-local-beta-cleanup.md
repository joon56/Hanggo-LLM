# Local beta cleanup implementation plan

> Execute with subagent-driven-development. User authorized removing API-key implementation remnants and preparing a meeting demo script.

**Goal:** Keep a local-only runtime and provide a reproducible 15-minute Korean beta demonstration.

**Architecture:** Ollama and Whisper remain the only AI runtime. Keep legacy saved-record readers so existing records remain accessible. Update active documentation; mark historical implementation reports as historical.

**Constraints:** Preserve models, browser records, source/risk validation and approval. Never print key values. Remove obsolete `.env` keys without touching unrelated settings. GitHub Pages remains a static demo. Do not introduce cloud access, model changes or inference tuning.

## Tasks

- [x] Root: red test default local config and rejection of cloud endpoint; remove OpenAI SDK, provider branch, obsolete env settings and SDK tests. Default shared generators to `ollama`. Retain legacy record parsing only.
- [x] UI task: remove cloud consent/cost/provider choices from current screens and API types; adapt UI/e2e tests to local responses. Label legacy saved AI records accurately.
- [x] Documentation task: rewrite active README/setup/testing/deployment docs for local-only use; create `docs/testing/beta-test-script.md` with timed operator actions, spoken lines, input samples, expected outcomes and failure alternatives; create a result sheet.
- [x] Root: provide a read-only meeting preflight command checking local tools, server state and an optional synthetic text warmup; run the documented samples against the real local model and record limitations.
- [x] Review: inspect cleanup, dependency tree and legacy storage compatibility; run full verification and real browser/voice smoke. Restart only this project's local app.

Release follow-through: commit/push verified changes under existing repository authorization, check CI, leave local demo running and link the beta script. Results are recorded in `docs/llm/beta-verification.md` and the final handoff.
