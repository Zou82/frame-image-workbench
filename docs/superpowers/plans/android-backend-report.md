# Android Native Backend Report

Date: 2026-11-15

## Delivered Scope

Owned implementation files:

- `android/app/src/main/java/com/frame/workbench/Backend.java`
- `android/app/src/main/java/com/frame/workbench/Store.java`
- `android/app/src/main/java/com/frame/workbench/Provider.java`
- `android/app/src/main/java/com/frame/workbench/TaskRules.java`
- `android/app/src/androidTest/java/com/frame/workbench/BackendTest.java`

No desktop credentials, desktop settings, generated desktop images, or physical
device data were read. Runtime test images are created with Android Bitmap APIs
inside the instrumentation test APK. The production APK does not include those
fixtures. No paid provider was contacted.

## Implementation

`Backend` implements the agreed singleton, request, media, listener and active
count interface. API routes mirror desktop settings, profiles/models, profiles/test,
uploads, jobs, cancel, delete, and health. Native uploads accept base64 JSON files.
The active count includes both queued and running jobs for the shell's foreground
service. Default connection names and user-facing backend messages are Chinese.

Settings support 1-20 connections, 1-100 concurrency, up to 1000 model IDs per
connection, timeout bounds, explicit key removal, and retention of an existing key
when an empty replacement is submitted. Public settings remove `apiKey` entirely
and expose only `hasKey`. Model synchronization calls the saved provider, validates
actual returned IDs, deduplicates them, and preserves the previous list on invalid
responses or a connection-edit race. Editable model lists retain desktop parity;
the interface does not invent model presets.

Jobs enforce strict JSON types, explicit null rejection, finite integer counts,
the desktop size/model/quality rules, 16 references, 10 outputs, reserved advanced
parameters, compression bounds, and existing safe media IDs. Every submitted task
captures its own immutable connection snapshot. History is durably written before
any generation request starts. Queue order is oldest first, with up to 100 worker
threads; idle threads expire after 30 seconds. Cancellation disconnects every
registered connection for that task without affecting another task. Completed
history deletion retains image files for drafts and other jobs using references.

`Store` keeps data under the app-private `files/frame` directory. Settings use
AES/GCM with a non-exportable Android Keystore key, random IVs, and AtomicFile
writes. History also uses AtomicFile; writes explicitly flush and fsync before
atomic completion. A shared bounded atomic writer rejects settings larger than
16 MiB and history larger than 128 MiB before beginning an AtomicFile write;
matching constants govern the read limits, preserving readable previous files
when a replacement is over budget. Restart marks queued/running jobs interrupted and never
resubmits them. Startup removes temporary partial files. A history write error
blocks new generation requests and is exposed through `storageError`.

`Provider` uses native HttpURLConnection with fixed-length streamed request bodies,
explicit timeouts, cancellation handles, and redirects disabled. Generation uses
JSON for `/images/generations`, multipart `image` for one reference, and multipart
`image[]` for multiple references at `/images/edits`. Multipart parameter names
escape CR, LF, and quote characters like browser FormData. The application has no
retry loop.

Base64 image strings stream to temporary files before the platform JsonReader
parses the remaining JSON. HTTP image URLs stream directly to temporary files
without forwarding provider authorization. An empty decoded base64 field falls
back to a valid URL when both fields are present. Limits are 75 MiB per decoded result,
100 MiB per encoded image string, 20 MiB per upload, 10 result images, 4 MiB of
response metadata, 1 MiB per normal JSON string, a bounded total response,
JSON depth 32, and 20000 parsed JSON entries. Small model/error JSON responses are
bounded separately. Whitespace surrounding base64 field separators is counted as
it is read and discarded, rather than buffered until the response continues.

Images are sniffed with BitmapFactory, restricted to PNG/JPEG/WebP and 50 million
pixels, and validated with a sampled decode. At most two image decoders run at
once, with a target longest decoded side of at most 256 pixels. Successful results
move the original file bytes into media storage without re-encoding. Dimensions,
format, byte length, and revised prompt are retained. Invalid results or
cancellation remove partial files and any outputs already created for that job.
Existing queued/running tasks after process death are interrupted, not retried.

## Verification

Toolchain:

- JDK 17: `C:/Users/13708/.jdks/ms-17.0.20.1`
- Android SDK 34: `D:/Android/Sdk`
- Gradle 8.2, Android Gradle Plugin 8.2.2
- Platform APIs and `org.json` only; no additional production dependencies
- Emulator serial `emulator-5580`, Android 14, API 34, x86_64

The first test-source compilation was run before the implementation existed and
failed with six missing `Backend`/`Store` symbols. The first implemented suite then
passed nine instrumentation tests in 16.31 seconds.

A later regression test for multipart field-name escaping failed with an actual
assertion before the fix: a crafted parameter name inserted raw CRLF into a
multipart header. Percent-escaping the field name made that behavior test pass.

Latest build/check command:

```powershell
$env:JAVA_HOME='C:/Users/13708/.jdks/ms-17.0.20.1'
& 'C:/Users/13708/.gradle/wrapper/dists/gradle-8.2-bin/bbg7u40eoinfdyxsxr3z4i7ta/gradle-8.2/bin/gradle.bat' --offline --console=plain :app:assembleDebug :app:assembleDebugAndroidTest :app:lintDebug
```

Result: `BUILD SUCCESSFUL`. Existing project path-check and deprecated platform
test runner warnings are present; there are no backend build errors. The latest
lint report contains 0 errors and 5 shell/manifest warnings, with no backend
findings.

Only explicit emulator-targeted installation and instrumentation commands were
used, never `connectedAndroidTest`:

```powershell
adb -s emulator-5580 install -r android/app/build/outputs/apk/debug/app-debug.apk
adb -s emulator-5580 install -r android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb -s emulator-5580 shell am instrument -w -r -e class com.frame.workbench.BackendTest com.frame.workbench.test/android.test.InstrumentationTestRunner
```

Latest result: `OK (17 tests)`, 16.629 seconds.

Verified behaviors:

1. Public settings omit the key; encrypted persisted settings contain no plaintext
   key; a recreated backend still authenticates with the saved key.
2. Fetched models use actual response IDs and retain the previous list after an
   invalid model response.
3. Invalid types, explicit nulls, reserved advanced fields, invalid dimensions,
   unsupported quality and traversal references are rejected before a request.
4. Generation sends JSON with expected independent task fields and advanced
   settings; original PNG bytes, dimensions, format and revision are preserved.
5. Deleting history retains output media.
6. Multipart sends `image` for one reference, `image[]` for multiple references,
   actual file bytes, MIME types and task fields.
7. Multipart field names cannot inject headers.
8. HTTP URL image results succeed; provider errors redact the saved key.
9. Cancelling one task preserves another queued task and its earlier connection
   snapshot after settings change.
10. Recreated history changes both queued and running tasks to interrupted with
    no provider resubmission.
11. One hundred jobs enter the real local HTTP fixture concurrently and all finish
    independently. The fixture withholds every response until 100 requests arrive.
12. A valid first image followed by an invalid result removes the earlier output
    and all temporary files, with no retry.
13. Generation redirects are rejected with no follow or retry; oversized URL
    image Content-Length is rejected before saving.
14. Invalid image bytes and malformed uploaded base64 leave no partial files.
15. An empty base64 field accompanying a valid URL falls back to the URL and
    leaves no temporary file.
16. A streamed response containing 4 MiB plus one byte of whitespace after
    `b64_json` is rejected before the withheld colon/value is sent.
17. An over-budget atomic replacement rejects before writing and preserves the
    previous readable history byte for byte. The real shared writer is tested
    with a 64-byte budget, avoiding a 128 MiB allocation just to hit the boundary.

The test HTTP server runs inside the instrumentation process on localhost.
It checks request methods, authorization presence, JSON task fields, multipart
fields, content types and reference bytes, and returns fixture images only.

## Independent Review Follow-Up

Three confirmed P2 findings were fixed:

- Empty base64 data previously created an empty spool file which prevented the
  valid URL fallback. Empty decoded files now defer to an available URL.
- Whitespace around a base64 field separator previously accumulated in an
  unbounded StringBuilder before the metadata check ran. Whitespace is now
  discarded and counted incrementally on both sides of the colon.
- History writes previously lacked the 128 MiB limit used by history reads.
  A shared atomic writer now applies matching read/write byte budgets before
  beginning any replacement, including a 16 MiB settings budget.

The two provider regressions were run against the previous implementation:
both failed in 5.99 seconds. The empty-base64 task failed with an empty-image
error, and the whitespace task remained running while its response tail was
withheld. After the fixes, both tests and all other backend tests passed. The
bounded writer test verifies an actual rejected write preserves existing JSON;
the shared production budget constant links that behavior to the 128 MiB history
limit without an oversized test allocation.

## Remaining Validation Limits

- The final instrumentation suite ran on Android 14/API 34/x86_64. Older API,
  ARM devices, and foreground-service UI/lifecycle acceptance belong to the
  integration task and were not exercised by this backend-only suite.
- Fixtures use small PNGs. JPEG/WebP decoder paths are implemented but have not
  received dedicated fixture tests in this run.
- The 75 MiB and parser caps are enforced in streaming code; the suite checks an
  oversized declared image length, but does not stress a full 75 MiB streamed
  response or 100 large simultaneous images.
- Timeout code has explicit connection deadlines and cancellation, but this run
  does not wait through a complete configured 30-1800 second generation timeout.
- Restart behavior is tested by recreating the backend against persisted history.
  An actual OS force-stop/process-death acceptance test belongs to integration.
- Disk-full/Keystore failure injection, hardware-backed Keystore attestation,
  damaged AtomicFile recovery, and arbitrary malicious image decoder fuzzing were
  not performed.
- The WebView bridge must transiently hold a base64 upload string; the frontend
  contract limits uploads to one file per bridge call to bound that overhead.
- Keystore/settings initialization failures deliberately surface a startup error
  rather than silently overwriting encrypted credentials or damaged history.
