# Image Workbench Implementation Plan

> **For agentic workers:** Execute inline in the existing session. Use
> superpowers:executing-plans and verify each task before continuing.

**Goal:** Run a Chinese local image generation workbench with configurable
OpenAI connections and independent parallel image tasks.

**Architecture:** Express serves a built React application and local media.
A persisted task queue invokes an isolated provider adapter with cancellation.
Local settings never return API keys to the browser.

**Tech Stack:** Node.js 24, Express 5, React 19, Vite 7, lucide-react, sharp,
multer, node:test, Playwright CLI.

**Spec:** docs/superpowers/specs/2026-11-14-image-workbench-design.md

## Global Constraints

- Bind to 127.0.0.1; accept local Host values and same-origin mutations only.
- Default concurrency 3, range 1 through 8.
- Reference limit 16 PNG/JPEG/WebP images, 20 MiB each.
- No automatic paid retries; restart interrupts unfinished work.
- Do not send response_format to GPT Image models.
- Saved keys remain in local data/settings.json and never in browser state.

## Task 1: Validated Provider Requests And Task Queue

Files: server/provider.mjs, server/queue.mjs, tests/provider.test.mjs,
tests/queue.test.mjs.

- [x] Write tests for a queue with concurrency 2 and three deferred workers:
  only two workers begin, resolving one starts the third. Cancel a pending
  job and assert it never starts. Reject one worker and assert later work
  still runs. A restart maps running/queued states to interrupted.
- [x] Write provider tests asserting JSON requests use n/model/prompt/size,
  no response_format, and multipart edits send image[] reference bytes.
  Reject malformed advanced JSON, unsupported dimensions and JPEG transparency.
- [x] Run `npm test` and verify missing production modules fail.
- [x] Implement `TaskQueue({ concurrency, worker, onChange, initialJobs })`,
  exposing add, cancel, setConcurrency and list.
- [x] Implement `validateTask(input)` and
  `requestImages(task, connection, { signal, readReference, fetchImpl })`.
- [x] Run `npm test` and inspect all assertions.

## Task 2: Local API And Durable Storage

Files: server/index.mjs, server/storage.mjs, tests/api.test.mjs.

- [x] Test configuration key redaction, secret preservation, job creation
  without a key, upstream generation/edit results, upload validation, saved
  result access, restart interruption and cross-origin mutation rejection.
- [x] Implement atomic settings/jobs persistence, media storage, API routes,
  connection/model probing, validated uploads and static frontend serving.
- [x] Run `npm test` against a real local HTTP service with a fake upstream.

## Task 3: Complete Chinese Frontend

Files: index.html, vite.config.js, src/main.jsx, src/App.jsx, src/styles.css,
src/components/TaskCard.jsx, src/components/Settings.jsx,
src/components/Gallery.jsx, src/lib.js, public/assets/.

- [x] Build navigation, independent drafts, reference uploads, parameter
  controls, batch submission, queue status, cancellation and error display.
- [x] Build multi-connection settings, model discovery and connection tests.
- [x] Build result preview/download, history filtering and reuse.
- [x] Preserve drafts without credentials and use polling for task updates.
- [x] Run `npm run build` and `npm run check`.

## Task 4: Windows Launch And Browser Verification

Files: tools/launch.mjs, tools/stop.mjs, start.cmd, stop.cmd, README.md,
output/playwright/.

- [x] Implement dependency/build checks, hidden local server startup,
  browser opening, application health checking and free port selection.
- [x] Start the server and verify desktop/mobile screenshots with Playwright
  CLI; exercise settings, independent tasks, upload, cancellation and results.
- [x] Run `npm test`, `npm run build`, `npm run check`; report the live URL,
  launcher path and the need for the user's API key for real generation.

## Verification Results

- 11 node:test checks pass; production build and syntax checks pass.
- Playwright exercised connection saving/testing, two independent models,
  multi-image reference uploads, blocking submission during uploads, concurrent
  generation, multiple returned images, preview, actual PNG download, history
  search, result/history reuse, intentional upstream failure and cancellation.
- Removed-profile reassignment and historical task restoration were verified
  in the browser and by a dedicated regression test.
- Desktop and mobile screenshots checked at 320, 390, 768, 1440 and 1512 px;
  no horizontal overflow. Browser console reported no errors or warnings.
- Windows start.cmd and tools/stop.mjs were executed, then the application
  restarted successfully. The live service is http://127.0.0.1:4311.
- Isolated QA service stopped. Production data contains no QA credentials or
  generated fixtures. Actual OpenAI generation awaits the user's own API key.
