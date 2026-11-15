# Batch Workbench Implementation Plan

**Goal:** Import 50-100 distinct prompts, apply shared image parameters in one action, and manage the resulting tasks in a compact local workbench.

**Architecture:** Keep the existing queue, profiles, task editor and history. Add shared JSON parsing and bulk-edit validation, a batch import dialog, a defaults/bulk editor, and a paginated task list. Preserve independent task parameters and credentials.

**Tech Stack:** Node.js, Express, React, Vite, node:test, Playwright CLI.

## Contract

```json
{
  "version": 1,
  "defaults": {
    "model": "a-model-from-the-selected-connection",
    "size": "1536x1024",
    "quality": "high",
    "n": 1,
    "outputFormat": "png",
    "background": "auto"
  },
  "tasks": [
    { "title": "First image", "prompt": "First distinct image prompt" },
    { "title": "Second image", "prompt": "Second distinct image prompt", "size": "1024x1536" }
  ]
}
```

- Task overrides take precedence over JSON defaults, then current workbench defaults.
- Import validates all rows before adding anything, preserves source order and creates drafts only.
- Available model IDs always come from the selected saved connection.
- Unknown fields and unavailable models produce actionable errors.
- Maximum 500 workspace drafts, 500 tasks per import, 100 active upstream requests.
- Existing concurrency remains unchanged until explicitly saved.
- Bulk edits apply only enabled fields, skip queued/running/uploading/submitting tasks, preserve prompts/references and unrelated individual overrides.
- JSON files, a JSON example, and a Chinese prompt for another AI are available locally and through the import dialog.

## Tasks

- [x] Shared validation and batch data contract.
  - Move pure `validateTask(input)` to `shared/task-validation.mjs`, re-export from provider.
  - Add `shared/batch.mjs`: `parseBatchJson(text, settings, defaults)`, `applyBulkSettings(drafts, patch, settings, lockedIds)`, defaults, limits and template/prompt builders.
  - Test 100 distinct prompts, inheritance, per-task overrides, invalid model/field/row, atomic validation and locked task exclusions.
- [x] Scale queue settings.
  - Raise server and settings control to 1-100 concurrency without changing saved value.
  - Test 100 simultaneous workers and correct queue release without making external API calls.
- [x] Batch workbench UI.
  - Add JSON paste/file import, preview/count/errors, template download and AI prompt copy.
  - Add shared defaults and selective bulk editing for selected or all editable tasks.
  - Add compact paginated list, search/status filtering, selection, single-task editor and batch actions; retain card view.
  - Limit client submission fan-out to a small number of local API requests while server controls actual upstream concurrency.
- [x] Documentation and verification.
  - Add Chinese instructions, JSON example and AI prompt.
  - Run tests/check/build, browser verification with 100 fixture tasks and overrides, desktop/mobile screenshots.
  - Check for active production jobs before restart; preserve user settings, credentials and historical files.
