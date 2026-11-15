# Batch workbench progress

Plan: docs/superpowers/plans/2026-11-14-batch-workbench.md

No Git repository exists; execute in existing workspace without Git-specific isolation or commits.

| Tasks | Shared interface | Check |
| --- | --- | --- |
| Core / UI | parseBatchJson => tasks/errors; applyBulkSettings => drafts/updated/skipped/errors | Defined in batch-core-brief.md |
| Queue / UI | MAX_CONCURRENCY=100, saved limit unchanged | UI reads saved settings |
| UI / docs | getBatchTemplate and buildAiPrompt used in dialog and docs | Generate docs from the same contract |
| Core | All validation atomic, actual provider models only | Required tests |
| UI | Selected fields only, locked jobs skipped, editable task detail | Browser verification required |

- Core and concurrency complete; 32/32 tests, check and build pass.
- Frontend, standalone JSON example and Chinese AI instructions complete.
- Reviewer found uploading-state loss after pagination and empty batch field acceptance.
  Both fixed and scoped re-review approved.
- Upload regression: delayed upload, paginate away/back; RED unlocked upload;
  GREEN upload and generation remain disabled, reference persists.
- Browser QA: import100 distinct prompts, atomic invalid model rejection, paginate25/6,
  cross-page selection, shared defaults, selective bulk updates, individual override,
  JSON file import, download example, refresh persistence, desktop/mobile layouts.
- Local fixture execution:100 requests,100 distinct prompts,100 actual simultaneous
  requests,100 completed outputs; references use multipart edits, overrides preserved.
- Production before restart:0 active jobs,20 history records, concurrency8,
  one configured connection. Settings SHA256:
  7BF9C9FDC4137B19FA70AD76D8F1429F75FB8E9F774CCF6A610C1A2229A0B4ED.
- Production restarted at http://127.0.0.1:4311, PID19272. Health and browser
  smoke pass;20 history records,0 active jobs, concurrency8 unchanged.
  Settings SHA256 matches exactly, including private credentials.
- Final desktop/mobile checks include320px width, numeric concurrency control,
  strict null/empty batch validation and final compiled bundle. No paid upstream calls.
- QA browser and fixture process stopped; production background service remains running.
- All four plan tasks complete.
