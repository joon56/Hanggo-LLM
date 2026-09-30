# UI integration report

Implemented session gate, password login/logout, explicit local demo choice, external AI consent, note generation, and voice transcription. Stored history loads only after a successful session check and authentication when required. In development, a failed session check offers an explicit local demo choice; production keeps the gate closed. Existing local demo remains available when server responds without requiring authentication.

Text and audio requests use same-origin cookies and `AbortSignal`. Source edits, metadata changes, new/opened records, recorder changes, consent withdrawal, cancellation, and unmount invalidate pending results. New requests clear prior drafts immediately. A failed AI note request preserves source and uses the shared `createManualDraft` helper, with every item in `follow_up`. Transcription failures leave the source and recording intact. Transcripts require explicit confirmation; edits and replacement recordings clear that confirmation while retaining voice provenance. Audio is checked for an audible signal before upload; unsupported browser decoding blocks upload with an honest message.

Review panel labels `demo`, `openai`, and `manual` drafts and saved records separately. AI generation metadata appears beside the draft. Privacy copy states when text or audio leaves the browser.

Verification: focused App tests passed (12 tests) and `npm.cmd run build` passed after the consent fix. `npm.cmd run test:e2e` exited with code 0 and all 6 cases passed after moving browser server lifecycle to Playwright global setup. A simultaneous `npm.cmd run verify` attempt collided with another Playwright run in the shared output directory; root is running the final verify alone.

Limits: Real microphone and live OpenAI behavior still need human/API-key verification. Browser audio decoding support varies; unsupported recordings are rejected before upload.
