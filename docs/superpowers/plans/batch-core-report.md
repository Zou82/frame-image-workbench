# Batch Core Implementation Report

## Files

- `shared/task-validation.mjs`
  - Contains the existing pure `validateTask` implementation, moved verbatim.
- `shared/batch.mjs`
  - Exports batch limits, `modelChange`, defaults reconciliation, atomic JSON import, atomic bulk settings, template generation and the external-AI prompt.
- `server/provider.mjs`
  - Re-exports the shared `validateTask`.
- `server/index.mjs`
  - Validates saved concurrency against shared `MAX_CONCURRENCY` (1-100).
- `src/components/Settings.jsx`
  - Uses the shared concurrency limit for the slider and adds an exact numeric input.
- `tests/batch.test.mjs`
  - Covers 100 ordered tasks, inheritance/overrides, shorthand prompts, actual profile models, field/type/limit failures, atomicity, locked drafts, reference preservation, model normalization, templates and AI instructions.
- `tests/api.test.mjs`
  - Covers concurrency 100 accepted, 101 rejected and persistence remaining at the last valid value.
- `tests/queue.test.mjs`
  - Exercises 100 simultaneously waiting workers, ordered release into the next task and bounded cleanup.

## RED Evidence

- `node --test tests/batch.test.mjs`
  - Failed with `ERR_MODULE_NOT_FOUND` for `shared/batch.mjs` before production implementation.
- Focused API concurrency test
  - Failed because concurrency 100 returned HTTP 400 instead of 200 under the former 1-8 validation.
- Shared `modelChange` follow-up
  - Failed with an ESM missing-export error before the helper was exported.
- Strict batch-schema review
  - Failed because explicit `defaults: null` was treated as omitted and empty parameter strings could reach legacy validator fallbacks; both are now rejected in the shared batch layer.
- The new 100-worker queue characterization passed immediately, demonstrating the existing queue was already generic and needed no production change.

## GREEN Evidence

- `node --test tests/batch.test.mjs`
  - 9/9 passing after implementation.
- Focused concurrency API test
  - Passing for 100 accepted, 101 rejected and the valid setting preserved.
- `npm test`
  - Full suite passed after core integration.
- `npm run check`
  - Node syntax checks passed.
- `npm run build`
  - Vite production build passed and resolved shared modules in the browser bundle.

## Concerns

- Concurrency 100 is intentionally permitted but can exceed a provider's rate limits or the local machine's comfortable network load; it remains an explicit user setting rather than an automatic default.
- `MAX_DRAFTS` is a shared contract constant; enforcing the workspace draft cap belongs to the consuming UI.
- No paid external API request was made. Tests use local processes/fakes only and never print saved keys.
