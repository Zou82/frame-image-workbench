# Android Native Backend Review

Date: 2026-11-15

Scope: `Backend.java`, `Store.java`, `Provider.java`, `TaskRules.java`, and
`BackendTest.java`, checked against the Android design spec. The desktop provider
and submission contract were consulted for compatibility. MainActivity and export
implementation were excluded.

## Findings

### P2: Allow a valid URL result when the base64 field is empty

Location: `android/app/src/main/java/com/frame/workbench/Provider.java:170-178`

The stream transformer creates a temporary file even for an empty `b64_json`
string. The result loop considers that file present, skips the valid `url` on the
same item, and then fails `Store.saveImage` because the file is empty. Providers
that serialize an unused base64 field as an empty string alongside their URL
therefore produce a failed paid job despite returning a usable image. Treat an
empty decoded base64 file as absent before deciding whether to download the URL.
Add coverage for a result containing both an empty base64 field and a valid URL.

### P2: Bound whitespace lookahead before buffering it

Location: `android/app/src/main/java/com/frame/workbench/Provider.java:399-405`

Both whitespace scans append to `after` without checking its length. The 4 MiB
metadata check at lines 374-375 runs only after `token()` returns. Consequently,
whitespace around the base64 property separator can consume memory up to the much
larger response byte limit before the metadata limit runs. On an Android heap,
that can terminate the process with an out-of-memory error instead of producing
the intended bounded parser failure and cleanup. Enforce the metadata budget
during these scans, or discard insignificant whitespace rather than storing it.
Add a parser case that exceeds the metadata budget during lookahead.

### P2: Do not persist history that the next launch refuses to read

Location: `android/app/src/main/java/com/frame/workbench/Store.java:64-70`

`readJobs` rejects files above 128 MiB, but `writeJobs` has no corresponding size
limit and history is never bounded. Repeated batches with long prompts or revised
prompts can therefore save successfully until a restart makes Backend
construction fail at `store.readJobs()`. The user then cannot reach the workbench
to remove old history. Apply a consistent supported size policy at write time,
with an actionable failure while the existing readable history remains intact,
or provide a storage format and reader that support the larger history. Cover
the read/write boundary and restart behavior.

## Spec And Quality Verdict

Needs the three P2 fixes above for an unconditional backend approval. No P0/P1
issue was found in this review.

The reviewed implementation otherwise follows the central backend contract:

- Generation uses JSON and edits use multipart with the specified image field
  names; advanced parameters cannot replace protected fields.
- Connections and task settings are copied at submission. Settings writes,
  scheduling, cancellation, and job state transitions share the backend lock.
- Queued and running history is written before paid requests. Restart interrupts
  unfinished jobs without resubmitting them.
- Cancellation disconnects that task's connections, preserves independent work,
  and cleans outputs completed during the cancellation race.
- Validated original image bytes are moved into persistent media storage;
  deleting history retains media for reference reuse.
- Public settings omit API keys, stored settings use Android Keystore encryption,
  and provider errors redact the connection key.
- No source-level Android API newer than the declared API 26 minimum was found
  in the reviewed backend files. This is a static compatibility observation,
  not an API 26 device validation result.

Editable saved model IDs were treated as intentional desktop compatibility and
were not reported as a defect.

## Validation Limits

Reviewed all 14 instrumentation test methods. They cover the principal request,
multipart, persistence, cancellation, concurrency, and error paths, but do not
cover the three cases above. No tests were run and no implementation files were
changed during this review; execution results remain the responsibility of the
parent task.
