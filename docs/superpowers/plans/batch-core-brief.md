# Batch core implementation brief

Implement shared batch data rules and scale queue configuration for the existing local React/Express image workbench. User needs 50-100 independent prompts, shared defaults, individual overrides and real concurrency.

Owned files: `shared/*.mjs`, `tests/batch.test.mjs`, concurrency tests in `tests/api.test.mjs` and `tests/queue.test.mjs`, `server/provider.mjs`, concurrency validation in `server/index.mjs`, `src/components/Settings.jsx`. Do not edit App, lib, styles or other components. There is no Git repository; do not commit or create worktrees.

Use TDD: write meaningful failing tests, run them before implementation, then implement and verify. Preserve existing validation behavior and saved settings. No paid external API requests, no printing keys. Do not spawn subagents.

## Shared API

- Extract existing pure `validateTask` verbatim into `shared/task-validation.mjs`, re-export from provider.
- `shared/batch.mjs` exports:
  - `MAX_DRAFTS = 500`, `MAX_IMPORT_TASKS = 500`, `MAX_CONCURRENCY = 100`.
  - `createBatchDefaults(settings, saved = {})`: returns editable parameter object with profileId, actual available model (empty if none), size, quality, n, outputFormat, background, extra (string JSON). Reconcile saved profile/model against current actual lists. No hardcoded models.
  - `parseBatchJson(text, settings, defaults)`: returns `{tasks, errors}`. Never throws for invalid user input. On any error `tasks` is empty; errors are strings with field/row locations. Successful tasks are sanitized validated parameters (extra object, references empty), no IDs/jobId; UI calls makeDraft and stringifies extra.
  - `applyBulkSettings(drafts, patch, settings, lockedIds = new Set())`: returns `{drafts, updated, skipped, errors}`. Input drafts are browser drafts with extra string and reference objects. Only provided parameter fields are changed; preserve title, prompt, references, jobId and unrelated values. lockedIds skipped. Atomic on validation failure (return original array, updated 0, errors). Empty prompts permitted for editing drafts. Preserve original reference objects and string extra. If model changes and inherited quality/background/size become incompatible, normalize them using existing modelChange rules; explicitly supplied incompatible options must error. Profile change can choose new profile first actual model if model not supplied. No unavailable model accepted.
  - `getBatchTemplate(defaults)`: JSON string for downloadable two-task example with version 1, defaults excluding credentials, two Chinese prompts, second override size portrait.
  - `buildAiPrompt(settings, defaults)`: Chinese copyable instruction for external AI, includes exact JSON schema/example, allowed fields and actual available model IDs per profile, output only JSON, tasks overrides > defaults > UI defaults, no invented model/credentials/reference paths. User can append their prompts.

JSON format `{version:1,defaults:{...},tasks:[{title,prompt,...overrides}]}`. Version optional defaults1; reject other versions/unknown root fields. `defaults` optional. tasks can optionally contain prompt strings. Allowed parameter fields: profileId,model,size,quality,n,outputFormat,background,extra; task also title,prompt. Reject unknown fields, wrong types, unknown profile/model, empty/overlong prompt, noninteger n, invalid extra. Explicit JSON invalid combinations fail instead of normalization. Shared UI defaults normalized on model change only where inherited. Validate every row before adding anything. Limits 1-500 tasks; <=20MB text; preserve task order; all errors actionable. Profile override without explicit model must not inherit another connection's unavailable model: select that profile's actual first model only if no model explicitly set in task or JSON defaults.

## Concurrency

Raise backend settings validation and UI range from 1-8 to 1-100 (use shared constant). Add exact numeric input in Settings next to slider for ergonomic setting to50/100. Existing saved8 untouched until save. Queue remains generic.

Tests: 100 distinct tasks ordered with inherited fields; overrides; malformed JSON/unknown fields/model/profile/types; limits and atomicity; bulk selective editing/locked tasks/refs preserved and incompatible normalization; actual 100 waiting workers with bounded cleanup; settings100 accepted101 rejected.

Report to `docs/superpowers/plans/batch-core-report.md`: files, tests, RED/GREEN evidence and concerns. Return short status and shared interfaces.
