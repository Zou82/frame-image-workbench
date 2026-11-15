# Android Shell Review

Reviewed November 15, 2026 against
`docs/superpowers/specs/2026-11-15-android-design.md`.

**Latest scoped rereview:** the five original findings and the follow-up P2
export-recovery issue are addressed. No remaining concrete issue was found within
the final scope; see the final follow-up section at the end of this report.

**Initial spec verdict: conditional fail.** The image export behavior differs from the
accepted SAF contract, and the declared WebView 105 floor needs viewport fallbacks.

**Initial quality verdict: changes requested.** No P0/P1 defect was confirmed in the
reviewed shell. Five P2 issues remain, covering an exception path, picker lifecycle,
exports, compatibility, and missing asset handling. This is a source review, not
runtime acceptance.

## Findings

### P2: Catch clipboard exceptions inside the UI-thread callback

**Location:** `android/app/src/main/java/com/frame/workbench/MainActivity.java:210`
through line 214.

`setPrimaryClip()` runs in a posted main-thread lambda without a catch. The
surrounding bridge catch has already returned by then, so it cannot handle
exceptions from this call. The bridge accepts strings approaching 30 MiB, while a
clipboard call crosses Binder. For example, a `/clipboard` request containing
`"x".repeat(2 * 1024 * 1024)` can exceed the transaction buffer and raise a runtime
exception on the main thread, terminating FRAME instead of rejecting the bridge
request. A sufficiently large fetched model list can also expand the AI prompt
copied by the existing UI.

Catch exceptions inside the posted lambda, impose a clipboard size bound, and
send an error through `reply()`. Verify with an oversized clipboard request on an
emulator, asserting that the app remains alive and the JS promise rejects.

Evidence: the installed Android SDK sources at
`D:/Android/Sdk/sources/android-37.0/android/content/ClipboardManager.java:181`
show the remote call and rethrow; `android/os/RemoteException.java:81` shows the
runtime rethrow, and `android/os/TransactionTooLargeException.java:29` documents
the shared transaction buffer. The crash has not been executed by this reviewer.

### P2: Preserve pending SAF exports across activity recreation

**Location:** `android/app/src/main/java/com/frame/workbench/Exports.java:26`,
lines 96-100; `MainActivity.java:62` and lines 290-295.

The selected export item exists only in the activity-owned `choosing` field.
`MainActivity` constructs a fresh `Exports` on every creation, does not restore
export state, and closes the old object on destruction. With the Android
"Don't keep activities" option, opening the external save picker destroys the
activity. When the result returns to the recreated activity, `choosing == null`
causes `onResult()` to return without writing or reporting a problem. The picker
may already have created the destination, leaving a zero-byte file.

Persist the pending export metadata and stage text outside the activity before
launching the picker, then restore and complete it on the returned result.
Do not place a potentially 20 MiB text export in the instance-state Bundle.
Exercise this for both JSON and pre-Android-10 image exports.

### P2: Use the promised save-location picker for image exports

**Location:** `android/app/src/main/java/com/frame/workbench/Exports.java:48`.

On API 29 and later, image exports immediately enter `saveGallery()` and return.
The user cannot choose a filename or a document provider, including cloud storage.
The accepted architecture explicitly requires SAF for both text and image files
and says `/export` opens a create-document picker. The same download command
therefore has different destination behavior across supported Android versions.

Send image exports through `ACTION_CREATE_DOCUMENT` on all supported versions.
If saving to the gallery is desirable, expose it as a separate explicit action
while retaining the specified export behavior.

### P2: Add viewport fallbacks for the declared WebView 105 floor

**Location:** `src/android.css:53`; related constraints in
`src/styles.css:226`, line 412, line 525, and line 578.

Modal maximum heights use `dvh` exclusively. Dynamic viewport units were added in
Chromium 108, so WebView 105-107 ignores these declarations. At widths above
700 CSS pixels, including tablets and phone landscape, the backdrop centers the
modal rather than stretching it, and no accepted maximum height remains. A
settings dialog containing many connections can exceed the viewport while the
document body is locked against scrolling, placing its close/save controls
outside the usable screen.

Set `vh` constraints before the `dvh` declarations, or otherwise give the
Android modal a supported viewport constraint. Keep the documented 105 floor only
after checking that version, including landscape, 20 connections and large text.
The compatibility evidence is the `viewport_percentage_units_dynamic` entry in
the MDN browser-compat-data `css/types/length.json` dataset, which records Chrome
108 and mirrors that support to Android WebView.

### P2: Turn missing entry assets into an actionable native startup error

**Location:** `android/app/src/main/java/com/frame/workbench/MainActivity.java:157`
through line 162; `android/app/build.gradle:26`.

Any missing asset becomes an empty HTTP 404 response. Only transport
`onReceivedError()` is handled, and only for the main frame. Missing `index.html`
therefore produces an empty page, and a missing entry JS bundle leaves the empty
React root with no startup UI. The Gradle asset directory points to `dist` without
an asset validation or frontend build dependency, so an otherwise valid native
build can package an absent or incomplete frontend.

Validate `dist/index.html` and its entry assets during the APK build, and surface
main-document or required-entry-asset failures through the native error view.
Verify by building an intentionally incomplete asset set in a temporary copy.
The current reviewed `dist` does contain the referenced entry files; this is a
failure-path gap, not a claim that the current asset set is missing.

Evidence: the installed SDK `android/webkit/WebViewClient.java:357` documents the
separate HTTP-error callback.

## Coverage And Positive Observations

Read the three native shell classes, manifest, app/root Gradle files, styles,
Vite configuration, `src/platform.js`, `src/lib.js`, `src/android.css`, and
`BatchImport.jsx`. Traced one hop into App, Workbench, TaskCard, Settings, Gallery,
shared batch logic and adapter tests.

- The WebView origin check validates scheme, host, port and user-info. External
  requests are intercepted or blocked; compiled HTML receives a restrictive CSP.
  File access is disabled, debugging follows the build type, and backup is off.
  No confirmed origin escape was found in this scope.
- Bridge work runs on a four-thread executor. Request IDs correlate independent
  responses, frontend batch submissions use four workers, and generation is
  submitted asynchronously through the documented backend contract. No shell code
  limits active provider generation to those four bridge threads.
- Reference uploads cross the bridge individually and enforce the 20 MiB limit
  before conversion. Media ID validation remains delegated to `Backend.mediaFile`
  as documented.
- SDK levels match 26/34/34. No ABI-specific native dependency is declared. The
  current `dist` contains only production UI assets and the three inspiration
  images; no desktop data directory is included by the asset source set.
- Desktop fetch/upload/download paths remain separated by the native detection.
  The Android CSS is scoped under `.android-app`. No direct desktop regression
  was identified from this source review.

## Validation Limits

The parent reports 35 frontend tests and the Vite build passing. The existing
adapter tests cover response correlation, error/timeout behavior without retries,
and sequential file uploads; they do not cover the native failure paths above.
No additional test suite or device action was run during this review, and no
physical device was accessed.

Backend, Provider, Store and TaskRules were intentionally excluded because they
were under active implementation. Consequently this review does not establish
native payload correctness, encrypted persistence, paid-request history ordering,
actual 100-task concurrency, cancellation cleanup, or restart semantics.

Runtime acceptance should still cover foreground service start/update/stop,
leaving immediately after submitting a batch, notification denial, picker
recreation, 20 MiB references, renderer loss, WebView 105, API 26, display cutouts,
keyboard resize, tablet/landscape and large text. In particular, service startup
exceptions are currently swallowed in `GenerationService.java:27`; background
service availability must be observed in acceptance, not inferred from the
existence of a service declaration.

There is no Git repository, so no baseline diff, blame or commit-level regression
analysis was possible. Application source was not changed by this review.

## Follow-Up Review: November 15, 2026

Scope: the five original P2 fixes, startup request/reply ordering, per-document
request IDs, globally serialized native uploads, and the service wake lock.
Application code and devices were not modified by this review.

**Current spec verdict: pass for the reviewed shell changes.** The amended
architecture explicitly permits API 29+ MediaStore image saves. This does not
constitute full feature or device acceptance.

**Current quality verdict: changes requested for one new P2.** No P0/P1 issue was
identified in the reviewed fixes. The original findings are closed as follows:

| Original finding | Status and current evidence |
| --- | --- |
| Clipboard UI-thread crash | Fixed. `MainActivity.java:233` rejects over 200,000 UTF-16 characters, and lines 236-240 catch failures inside the posted callback and reply with an error. |
| Export state lost on owner recreation | Fixed for a pending result returning to a replacement owner. `Exports.java:44` restores private preferences, lines 96-100 stage text as a file, and lines 71-77 persist item/queue metadata. Fresh-task recovery has the separate issue below. |
| API 29+ image save contract mismatch | Closed by the explicit spec amendment at `android-design.md:22`. The existing MediaStore behavior now matches that contract. |
| WebView 105 viewport constraints | Fixed. `android.css:3`, line 4, line 20, and line 55 supply supported `vh` declarations before their `dvh` overrides. |
| Missing frontend assets cause an empty startup | Fixed in the reviewed paths. `app/build.gradle:3` builds Vite assets before `preBuild`, `MainActivity.java:64` checks the entry document, and lines 183-185 surface main-document/JS HTTP errors natively. |

### New P2: A stale persisted picker blocks all future SAF exports

**Location:** `android/app/src/main/java/com/frame/workbench/Exports.java:47`,
line 132, and line 141; `MainActivity.java:73`.

The constructor restores `choosing` on every launch, including a fresh task after
force-stop or removal of the old task. In that case there is no outstanding
activity-result delivery associated with the new activity, but `next()` refuses
to launch any picker while `choosing != null`. Every subsequent JSON, text, or
API 26-28 image export is added to the queue and acknowledged without opening a
picker. The state persists through further restarts, so ordinary export actions
cannot recover it.

Concrete sequence:

1. Start a text export and leave `ACTION_CREATE_DOCUMENT` open.
2. Force-stop FRAME or remove its task, then start a fresh launcher activity.
3. Export another text document. The old `choosing` is restored, `next()` returns,
   and no picker opens for either item.

The picker-launch exception path has the same persistence inconsistency:
`next()` persists `choosing`, then its launch catch clears only the in-memory
field. With no queued item to replace it, the persisted selection is stale on the
next launch.

Distinguish restoration of an activity with an outstanding picker result from a
fresh task, and either resume or explicitly cancel the orphaned selection.
Persist state after picker-launch failure as well. Extend coverage with a
fresh-owner/fresh-task path, not only an owner replacement while preserving the
expected result.

### Startup And Service Assessment

The initial `trusted = true` immediately before the first local `loadUrl()`
allows early native requests from the bundled page. External top-level
navigations and resources remain blocked by the existing origin checks.
`documentReady` and the deferred reply list are accessed on the main thread;
`onPageFinished()` flushes replies after the module has established the resolver.
The new UUID prefix in `platform.js:3` prevents a delayed response from an old
document satisfying a new document's request after its sequence counter resets.
No concrete startup-ordering regression was identified in these changes.

The upload lane recovers after rejection and serializes reference conversion and
bridge transfers across task windows, matching its intended memory bound.

The service declares `WAKE_LOCK`, uses a non-reference-counted partial lock,
acquires with a 35-minute timeout, and releases a held lock in `onDestroy()`.
Repeated `onStartCommand()` acquisitions refresh the timeout rather than
accumulating reference-counted holds. Source inspection found no lock-release
regression. The timeout remains a runtime limit if no service update occurs for
35 minutes; this review does not establish screen-off or Doze behavior.

The parent reports that the export-owner regression test failed before the fix
and passes afterward. The reviewed `ShellTest.java:13` exercises serialized
`Exports` state across replacement owners; it does not recreate the Android
Activity itself or cover a fresh task with an orphaned selection. Fresh build,
lint, startup stress and device acceptance results are still owned by the
integration task and were not run by this reviewer.

## Final Follow-Up: Export Recovery

Reviewed the final `Exports`, its `MainActivity` lifecycle hooks, and both shell
regression tests on November 15, 2026. **The follow-up P2 is closed.** No remaining
concrete issue was identified within this scoped review.

`MainActivity.java:73` explicitly tells the export owner whether the activity is
being restored. `Exports.java:54` clears an orphaned selection on a fresh launch,
removes its temporary file, and persists the cleared state. A restored activity
retains the item for its pending result. `MainActivity.java:320` resumes any
remaining queued exports, and the picker-launch failure path at
`Exports.java:153` now removes staged text and persists the cleared selection.

The added `ShellTest.java:14` covers opening a new export after abandoning a prior
owner; the existing owner-recreation test now explicitly uses restoration mode.
The parent reports that the new regression reproduced one picker launch instead
of the expected two before the fix, and that both shell tests now pass.

**Final source-review verdict: pass for the reviewed shell changes.** This closes
all concrete findings in this report. Build/lint and broader emulator acceptance
remain integration evidence; no device action or application-source edit was
performed by this reviewer.
