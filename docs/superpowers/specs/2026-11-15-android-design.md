# FRAME Android

## Outcome

Deliver a signed standalone APK preserving the desktop workbench's functionality.
The user delegates interface decisions and authorizes implementation and emulator
testing. No further design approval is required for reversible implementation.

## Architecture

Bundle the existing React production assets in an Android WebView at the synthetic
HTTPS origin `https://frame.local/`. Only that origin can load in the WebView.
Intercept local assets and `/media/` in a WebViewClient. Native networking avoids
CORS and does not rely on a computer or expose a network listener.

`window.FrameNative.request(json)` accepts `{id, route, method, body}`. Native code
responds by evaluating `window.__frameNativeResolve({id, ok, data, error})`.
JSON bodies match the desktop `/api` contract without the `/api` prefix.
Uploads use `{files:[{name,type,data}]}` where data is base64, one file per request
to limit transient bridge memory. The UI combines the returned files.

Native text exports and Android 8/9 image exports use the Storage Access Framework.
On Android 10+, image downloads save directly to Pictures/FRAME through MediaStore,
without broad storage permission.
`/export` accepts `{name,text,type}` or `{name,mediaId}` and opens a create-document
picker for documents or saves an image to the gallery as above. `/clipboard`
accepts `{text}`. Media IDs are always validated.

## Compatibility

- Java Android application, minSdk 26, compileSdk 34, targetSdk 34.
- No native ABI libraries: one APK for ARM32, ARM64, x86, and x86_64.
- Android System WebView 105+; detect missing/incompatible WebView with an actionable
  native error rather than a blank screen.
- System file chooser supports multiple image files and JSON.
- Portrait, landscape, tablet, keyboard, display cutouts and large text.
- Network calls run off the UI thread with timeouts and cancellation.
- A dataSync foreground service and notification keep active work alive while the
  UI is backgrounded; OS force stop/process kill interrupts unfinished jobs.
- Never automatically resubmit generation after restart.
- Do not access the connected physical device; use explicit emulator serials.

## Functional Contract

Preserve up to 20 connections with actual fetched model IDs only, up to 500 drafts,
100 concurrent tasks, 16 reference photos per task (20 MB each), task validation,
independent prompts/models/settings, batch defaults and overrides, selective bulk
editing, JSON preview/import/export/AI prompt, pagination/filtering, gallery,
preview, saving, and image reuse.

Native API mirrors desktop:
`GET /settings`, `PUT /settings`, `POST /profiles/:id/models|test`,
`POST /uploads`, `GET /jobs`, `POST /jobs`, `POST /jobs/:id/cancel`,
`DELETE /jobs/:id`, and `GET /health`.

Generation POSTs JSON to `/images/generations`, or multipart `/images/edits`
with `image` for one reference and `image[]` for multiple. No automatic retries.
API results may contain base64 images or HTTP(S) URLs. Persist validated original
PNG/JPEG/WebP bytes and dimensions. Cancellation disconnects requests, cleans
partial outputs, and preserves independent tasks.

Settings writes are atomic and keys are encrypted using Android Keystore.
Public settings omit keys. Snapshot connections for submitted tasks so edits do
not reroute queued work. History writes precede paid requests. Restart marks
queued/running jobs interrupted. Keep referenced image files when deleting history.
The APK contains no real desktop credentials, generated images, or test fixtures.

## Validation

Use a local mock provider with strict payload checking for emulator tests, never
paid real requests. Verify model sync, JSON and multipart generation, 100-task
batch and concurrency, overrides, errors/cancellation, persistence/restart,
background execution, imports/exports, image reuse, responsive layout and crash
logs. Record exact tested OS versions and honest remaining limits.
